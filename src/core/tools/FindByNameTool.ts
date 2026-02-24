import * as path from "path"
import { execSync } from "child_process"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface FindByNameParams {
	path: string
	pattern: string
	extensions?: string[] | null
	excludes?: string[] | null
	max_depth?: number | null
	type?: "file" | "directory" | "any" | null
	full_path?: boolean | null
}

interface FindResult {
	type: "file" | "directory"
	path: string
	size?: number
	modified?: string
}

const MAX_RESULTS = 50

export class FindByNameTool extends BaseTool<"find_by_name"> {
	readonly name = "find_by_name" as const

	async execute(params: FindByNameParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { path: relDirPath, pattern, extensions, excludes, max_depth, type: entryType, full_path } = params

		try {
			if (!relDirPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("find_by_name")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("find_by_name", "path"))
				return
			}

			if (!pattern) {
				task.consecutiveMistakeCount++
				task.recordToolError("find_by_name")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("find_by_name", "pattern"))
				return
			}

			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, relDirPath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			// Validate access with rooIgnore
			const accessAllowed = task.rooIgnoreController?.validateAccess(relDirPath)
			if (!accessAllowed) {
				await task.say("rooignore_error", relDirPath)
				pushToolResult(formatResponse.rooIgnoreError(relDirPath))
				return
			}

			const results = await this.findFiles(absolutePath, {
				pattern,
				extensions: extensions || undefined,
				excludes: excludes || undefined,
				maxDepth: max_depth || undefined,
				type: entryType || "any",
				fullPath: full_path || false,
			})

			const resultText = this.formatResults(results, absolutePath)

			const sharedMessageProps: ClineSayTool = {
				tool: "findByName",
				path: getReadablePath(task.cwd, relDirPath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: resultText,
			} satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(resultText)
		} catch (error) {
			await handleError("finding files by name", error)
		}
	}

	private async findFiles(
		basePath: string,
		options: {
			pattern: string
			extensions?: string[]
			excludes?: string[]
			maxDepth?: number
			type: "file" | "directory" | "any"
			fullPath: boolean
		},
	): Promise<FindResult[]> {
		const results: FindResult[] = []

		try {
			const args: string[] = []

			if (options.pattern && options.pattern !== "*") {
				if (options.fullPath) {
					args.push("--full-path")
				}
				args.push(options.pattern)
			}

			if (options.type === "file") {
				args.push("--type", "f")
			} else if (options.type === "directory") {
				args.push("--type", "d")
			}

			if (options.maxDepth !== undefined) {
				args.push("--max-depth", String(options.maxDepth))
			}

			if (options.extensions && options.extensions.length > 0) {
				for (const ext of options.extensions) {
					args.push("--extension", ext)
				}
			}

			if (options.excludes && options.excludes.length > 0) {
				for (const exclude of options.excludes) {
					args.push("--exclude", exclude)
				}
			}

			args.push("--color", "never")
			args.push("--hidden")
			args.push("--no-ignore-vcs")

			const hasFd = this.checkCommandExists("fd")

			let output: string

			if (hasFd) {
				const command = `fd ${args.join(" ")}`
				output = execSync(command, {
					cwd: basePath,
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
					timeout: 30000,
				})
			} else {
				output = await this.fallbackFind(basePath, options)
			}

			const lines = output.trim().split("\n").filter(Boolean)
			const limitedLines = lines.slice(0, MAX_RESULTS)

			for (const line of limitedLines) {
				const fullPath = path.isAbsolute(line) ? line : path.join(basePath, line)
				const stats = await this.getFileStats(fullPath)

				results.push({
					type: stats.isDirectory ? "directory" : "file",
					path: line,
					size: stats.size,
					modified: stats.modified,
				})
			}

			if (lines.length > MAX_RESULTS) {
				results.push({
					type: "file",
					path: `... and ${lines.length - MAX_RESULTS} more results (showing first ${MAX_RESULTS})`,
				})
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("ENOENT")) {
				throw new Error(`Directory not found: ${basePath}`)
			}
			throw error
		}

		return results
	}

	private checkCommandExists(command: string): boolean {
		try {
			execSync(`${process.platform === "win32" ? "where" : "which"} ${command}`, {
				encoding: "utf-8",
				stdio: "pipe",
			})
			return true
		} catch {
			return false
		}
	}

	private async fallbackFind(
		basePath: string,
		options: {
			pattern: string
			extensions?: string[]
			excludes?: string[]
			maxDepth?: number
			type: "file" | "directory" | "any"
			fullPath: boolean
		},
	): Promise<string> {
		const fs = await import("fs/promises")
		const results: string[] = []

		const walk = async (dir: string, depth: number): Promise<void> => {
			if (options.maxDepth !== undefined && depth > options.maxDepth) {
				return
			}

			try {
				const entries = await fs.readdir(dir, { withFileTypes: true })

				for (const entry of entries) {
					const relativePath = path.relative(basePath, path.join(dir, entry.name))

					if (options.excludes?.some((ex) => this.matchGlob(relativePath, ex))) {
						continue
					}

					const matchTarget = options.fullPath ? relativePath : entry.name

					const patternMatches = options.pattern === "*" || this.matchGlob(matchTarget, options.pattern)

					const extMatches =
						!options.extensions ||
						options.extensions.length === 0 ||
						options.extensions.some((ext) => entry.name.endsWith(`.${ext}`))

					const typeMatches =
						options.type === "any" ||
						(options.type === "file" && entry.isFile()) ||
						(options.type === "directory" && entry.isDirectory())

					if (patternMatches && extMatches && typeMatches) {
						results.push(relativePath)
						if (results.length >= MAX_RESULTS + 10) {
							return
						}
					}

					if (entry.isDirectory()) {
						await walk(path.join(dir, entry.name), depth + 1)
					}
				}
			} catch {}
		}

		await walk(basePath, 1)
		return results.join("\n")
	}

	/** @internal Exposed for testing */
	public matchGlob(str: string, pattern: string): boolean {
		// Handle **/ at the start - it should match zero or more path segments
		let regexPattern = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*\//g, "{{GLOBSTAR_SLASH}}")
			.replace(/\*\*/g, "{{GLOBSTAR}}")
			.replace(/\*/g, "[^/\\\\]*")
			.replace(/\?/g, "[^/\\\\]")
			.replace(/{{GLOBSTAR_SLASH}}/g, "(?:.*[/\\\\])?")
			.replace(/{{GLOBSTAR}}/g, ".*")

		const regex = new RegExp(`^${regexPattern}$`, "i")
		return regex.test(str)
	}

	private async getFileStats(filePath: string): Promise<{ isDirectory: boolean; size?: number; modified?: string }> {
		try {
			const fs = await import("fs/promises")
			const stats = await fs.stat(filePath)
			return {
				isDirectory: stats.isDirectory(),
				size: stats.isDirectory() ? undefined : stats.size,
				modified: stats.mtime.toISOString().split("T")[0],
			}
		} catch {
			return { isDirectory: false }
		}
	}

	private formatResults(results: FindResult[], basePath: string): string {
		if (results.length === 0) {
			return "No matching files or directories found."
		}

		const lines: string[] = [`Found ${results.length} result(s) in ${basePath}:`, ""]

		for (const result of results) {
			const typeIcon = result.type === "directory" ? "[DIR]" : "[FILE]"
			const sizeInfo = result.size !== undefined ? ` (${this.formatSize(result.size)})` : ""
			const dateInfo = result.modified ? ` [${result.modified}]` : ""
			lines.push(`${typeIcon} ${result.path}${sizeInfo}${dateInfo}`)
		}

		return lines.join("\n")
	}

	/** @internal Exposed for testing */
	public formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
	}

	override async handlePartial(task: Task, block: ToolUse<"find_by_name">): Promise<void> {
		const relDirPath: string | undefined = block.params.path
		const pattern: string | undefined = block.params.pattern

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "findByName",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			pattern: pattern ?? "*",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const findByNameTool = new FindByNameTool()
