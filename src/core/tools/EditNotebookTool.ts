import fs from "fs/promises"
import path from "path"
import { v4 as uuidv4 } from "uuid"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface EditNotebookParams {
	absolute_path: string
	new_source: string
	cell_number?: number | null
	cell_type?: "code" | "markdown" | null
	edit_mode?: "replace" | "insert" | null
	cell_id?: string | null
}

interface NotebookCell {
	cell_type: "code" | "markdown" | "raw"
	id?: string
	source: string[] | string
	metadata?: Record<string, unknown>
	outputs?: unknown[]
	execution_count?: number | null
}

interface NotebookContent {
	cells: NotebookCell[]
	metadata?: Record<string, unknown>
	nbformat?: number
	nbformat_minor?: number
}

export class EditNotebookTool extends BaseTool<"edit_notebook"> {
	readonly name = "edit_notebook" as const

	async execute(params: EditNotebookParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { absolute_path, new_source, cell_number, cell_type, edit_mode, cell_id } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!absolute_path) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit_notebook")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("edit_notebook", "absolute_path"))
				return
			}

			if (new_source === undefined || new_source === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit_notebook")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("edit_notebook", "new_source"))
				return
			}

			// Validate file extension
			if (!absolute_path.endsWith(".ipynb")) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit_notebook")
				pushToolResult(formatResponse.toolError("File must be a Jupyter notebook (.ipynb)"))
				return
			}

			const absolutePath = path.isAbsolute(absolute_path) ? absolute_path : path.resolve(task.cwd, absolute_path)
			const mode = edit_mode || "replace"

			const fileExists = await fileExistsAtPath(absolutePath)
			if (!fileExists && mode === "replace") {
				task.consecutiveMistakeCount++
				task.recordToolError("edit_notebook")
				pushToolResult(formatResponse.toolError(`Notebook not found: ${absolute_path}`))
				return
			}

			task.consecutiveMistakeCount = 0

			// Validate access with rooIgnore
			const accessAllowed = task.rooIgnoreController?.validateAccess(absolute_path)
			if (!accessAllowed) {
				await task.say("rooignore_error", absolute_path)
				pushToolResult(formatResponse.rooIgnoreError(absolute_path))
				return
			}

			// Read existing notebook or create new one
			let notebook: NotebookContent
			if (fileExists) {
				try {
					const content = await fs.readFile(absolutePath, "utf8")
					notebook = JSON.parse(content)
				} catch (error) {
					pushToolResult(formatResponse.toolError(`Failed to read notebook: ${error}`))
					return
				}
			} else {
				// Create new notebook structure
				notebook = {
					cells: [],
					metadata: {},
					nbformat: 4,
					nbformat_minor: 5,
				}
			}

			// Determine target cell index
			let targetIndex: number
			if (cell_id) {
				targetIndex = notebook.cells.findIndex((c) => c.id === cell_id)
				if (targetIndex === -1 && mode === "replace") {
					pushToolResult(formatResponse.toolError(`Cell with id '${cell_id}' not found`))
					return
				}
				if (targetIndex === -1) {
					targetIndex = notebook.cells.length // Insert at end if id not found
				}
			} else {
				targetIndex = cell_number ?? 0
			}

			// Validate cell index
			if (mode === "replace") {
				if (targetIndex < 0 || targetIndex >= notebook.cells.length) {
					pushToolResult(
						formatResponse.toolError(
							`Cell index ${targetIndex} out of range. Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1}).`,
						),
					)
					return
				}
			} else {
				// Insert mode
				if (targetIndex < 0 || targetIndex > notebook.cells.length) {
					pushToolResult(
						formatResponse.toolError(
							`Insert position ${targetIndex} out of range. Valid range: 0-${notebook.cells.length}.`,
						),
					)
					return
				}
				if (!cell_type) {
					pushToolResult(formatResponse.toolError("'cell_type' is required for insert mode."))
					return
				}
			}

			// Apply the edit
			const newCell = this.createCell(new_source, cell_type || "code")

			if (mode === "insert") {
				notebook.cells.splice(targetIndex, 0, newCell)
			} else {
				// Preserve some metadata from old cell
				const oldCell = notebook.cells[targetIndex]
				newCell.cell_type = oldCell.cell_type
				if (oldCell.id) {
					newCell.id = oldCell.id
				}
				notebook.cells[targetIndex] = newCell
			}

			// Ask for approval
			const relPath = getReadablePath(task.cwd, absolute_path)
			const sharedMessageProps: ClineSayTool = {
				tool: "editedExistingFile",
				path: relPath,
				diff: `${mode === "insert" ? "Insert" : "Replace"} cell ${targetIndex}`,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `${mode === "insert" ? "Inserting" : "Replacing"} cell ${targetIndex} in notebook`,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				pushToolResult("Notebook edit was rejected by the user.")
				return
			}

			// Write the updated notebook
			try {
				await fs.writeFile(absolutePath, JSON.stringify(notebook, null, 1), "utf8")
			} catch (error) {
				pushToolResult(formatResponse.toolError(`Failed to write notebook: ${error}`))
				return
			}

			// Track file edit
			await task.fileContextTracker.trackFileContext(absolute_path, "roo_edited" as RecordSource)
			task.didEditFile = true

			const action = mode === "insert" ? "Inserted" : "Replaced"
			pushToolResult(`${action} cell ${targetIndex} in ${relPath}`)

			task.recordToolUsage("edit_notebook")
		} catch (error) {
			await handleError("editing notebook", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** @internal Exposed for testing */
	public createCell(source: string, cellType: "code" | "markdown"): NotebookCell {
		const cell: NotebookCell = {
			cell_type: cellType,
			id: uuidv4().replace(/-/g, "").slice(0, 8),
			source: source.split("\n").map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line)),
			metadata: {},
		}

		if (cellType === "code") {
			cell.outputs = []
			cell.execution_count = null
		}

		return cell
	}

	override async handlePartial(task: Task, block: ToolUse<"edit_notebook">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const editNotebookTool = new EditNotebookTool()
