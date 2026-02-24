import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface EditOperation {
	old_string: string
	new_string: string
	replace_all?: boolean | null
}

interface MultiEditParams {
	file_path: string
	edits: EditOperation[]
	explanation: string
}

interface EditValidationResult {
	valid: boolean
	error?: string
	editIndex?: number
}

export class MultiEditTool extends BaseTool<"multi_edit"> {
	readonly name = "multi_edit" as const

	async execute(params: MultiEditParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { file_path: relPath, edits, explanation } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				pushToolResult(await task.sayAndCreateMissingParamError("multi_edit", "file_path"))
				return
			}

			if (!edits || !Array.isArray(edits) || edits.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				pushToolResult(formatResponse.toolError("'edits' must be a non-empty array of edit operations."))
				return
			}

			if (!explanation) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				pushToolResult(await task.sayAndCreateMissingParamError("multi_edit", "explanation"))
				return
			}

			// Validate each edit operation
			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i]
				if (!edit.old_string) {
					task.consecutiveMistakeCount++
					task.recordToolError("multi_edit")
					pushToolResult(formatResponse.toolError(`Edit ${i + 1}: 'old_string' is required.`))
					return
				}
				if (edit.new_string === undefined) {
					task.consecutiveMistakeCount++
					task.recordToolError("multi_edit")
					pushToolResult(formatResponse.toolError(`Edit ${i + 1}: 'new_string' is required.`))
					return
				}
				if (edit.old_string === edit.new_string) {
					task.consecutiveMistakeCount++
					task.recordToolError("multi_edit")
					pushToolResult(
						formatResponse.toolError(
							`Edit ${i + 1}: 'old_string' and 'new_string' are identical. No changes needed.`,
						),
					)
					return
				}
			}

			const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}

			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false
			const absolutePath = path.resolve(task.cwd, relPath)

			const fileExists = await fileExistsAtPath(absolutePath)
			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				const errorMessage = `File not found: ${relPath}. Cannot perform multi_edit on a non-existent file.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			let fileContent: string
			try {
				fileContent = await fs.readFile(absolutePath, "utf8")
				fileContent = fileContent.replace(/\r\n/g, "\n")
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				const errorMessage = `Failed to read file '${relPath}'. Please verify file permissions.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			// Apply all edits sequentially, validating each one
			const originalContent = fileContent
			let currentContent = fileContent
			const validationResult = this.validateAndApplyEdits(currentContent, edits)

			if (!validationResult.valid) {
				task.consecutiveMistakeCount++
				task.recordToolError("multi_edit")
				pushToolResult(formatResponse.toolError(validationResult.error!))
				return
			}

			// Apply edits to get new content
			currentContent = this.applyEdits(currentContent, edits)

			if (currentContent === originalContent) {
				pushToolResult(`No changes needed for '${relPath}'`)
				return
			}

			task.consecutiveMistakeCount = 0

			// Initialize diff view
			task.diffViewProvider.editType = "modify"
			task.diffViewProvider.originalContent = originalContent

			// Generate diff
			const diff = formatResponse.createPrettyPatch(relPath, originalContent, currentContent)
			if (!diff) {
				pushToolResult(`No changes needed for '${relPath}'`)
				await task.diffViewProvider.reset()
				return
			}

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			const sanitizedDiff = sanitizeUnifiedDiff(diff)
			const diffStats = computeDiffStats(sanitizedDiff) || undefined
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ClineSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: sanitizedDiff,
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `${edits.length} edit operations: ${explanation}`,
				isProtected: isWriteProtected,
				diffStats,
			} satisfies ClineSayTool)

			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(currentContent, true)
				task.diffViewProvider.scrollToFirstDiff()
			}

			const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

			if (!didApprove) {
				if (!isPreventFocusDisruptionEnabled) {
					await task.diffViewProvider.revertChanges()
				}
				pushToolResult("Changes were rejected by the user.")
				await task.diffViewProvider.reset()
				return
			}

			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(
					relPath,
					currentContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
			pushToolResult(`Applied ${edits.length} edits to ${relPath}:\n${message}`)

			task.recordToolUsage("multi_edit")
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
		} catch (error) {
			await handleError("multi_edit", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
		}
	}

	/** @internal Exposed for testing */
	public validateAndApplyEdits(content: string, edits: EditOperation[]): EditValidationResult {
		// Normalize content line endings
		let currentContent = content.replace(/\r\n/g, "\n")

		for (let i = 0; i < edits.length; i++) {
			const edit = edits[i]
			const normalizedOld = edit.old_string.replace(/\r\n/g, "\n")
			const matchCount = currentContent.split(normalizedOld).length - 1

			if (matchCount === 0) {
				return {
					valid: false,
					error: `Edit ${i + 1}: No match found for 'old_string'. The text may have been modified by a previous edit in this batch.`,
					editIndex: i,
				}
			}

			if (!edit.replace_all && matchCount > 1) {
				return {
					valid: false,
					error: `Edit ${i + 1}: Found ${matchCount} matches. Use 'replace_all: true' or provide more context.`,
					editIndex: i,
				}
			}

			// Apply this edit to simulate the sequence
			const normalizedNew = edit.new_string.replace(/\r\n/g, "\n")
			if (edit.replace_all) {
				const pattern = new RegExp(this.escapeRegExp(normalizedOld), "g")
				currentContent = currentContent.replace(pattern, () => normalizedNew)
			} else {
				currentContent = currentContent.replace(normalizedOld, () => normalizedNew)
			}
		}

		return { valid: true }
	}

	private applyEdits(content: string, edits: EditOperation[]): string {
		let currentContent = content

		for (const edit of edits) {
			const normalizedOld = edit.old_string.replace(/\r\n/g, "\n")
			const normalizedNew = edit.new_string.replace(/\r\n/g, "\n")

			if (edit.replace_all) {
				const pattern = new RegExp(this.escapeRegExp(normalizedOld), "g")
				currentContent = currentContent.replace(pattern, () => normalizedNew)
			} else {
				currentContent = currentContent.replace(normalizedOld, () => normalizedNew)
			}
		}

		return currentContent
	}

	private escapeRegExp(input: string): string {
		return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	override async handlePartial(task: Task, block: ToolUse<"multi_edit">): Promise<void> {
		const relPath: string | undefined = block.params.file_path

		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const absolutePath = path.resolve(task.cwd, relPath!)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath!),
			diff: "Multiple edit operations",
			isOutsideWorkspace,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const multiEditTool = new MultiEditTool()
