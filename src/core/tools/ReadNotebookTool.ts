import fs from "fs/promises"
import path from "path"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ReadNotebookParams {
	path: string
}

interface NotebookCell {
	cell_type: "code" | "markdown" | "raw"
	id?: string
	source: string[] | string
	outputs?: NotebookOutput[]
	execution_count?: number | null
}

interface NotebookOutput {
	output_type: string
	text?: string[] | string
	data?: Record<string, string[] | string>
	ename?: string
	evalue?: string
	traceback?: string[]
}

interface NotebookContent {
	cells: NotebookCell[]
	metadata?: Record<string, unknown>
	nbformat?: number
	nbformat_minor?: number
}

export class ReadNotebookTool extends BaseTool<"read_notebook"> {
	readonly name = "read_notebook" as const

	async execute(params: ReadNotebookParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { path: notebookPath } = params
		const { pushToolResult, handleError } = callbacks

		try {
			if (!notebookPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_notebook")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("read_notebook", "path"))
				return
			}

			// Validate file extension
			if (!notebookPath.endsWith(".ipynb")) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_notebook")
				pushToolResult(formatResponse.toolError("File must be a Jupyter notebook (.ipynb)"))
				return
			}

			const absolutePath = path.isAbsolute(notebookPath) ? notebookPath : path.resolve(task.cwd, notebookPath)

			const fileExists = await fileExistsAtPath(absolutePath)
			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_notebook")
				pushToolResult(formatResponse.toolError(`Notebook not found: ${notebookPath}`))
				return
			}

			task.consecutiveMistakeCount = 0

			// Validate access with rooIgnore
			const accessAllowed = task.rooIgnoreController?.validateAccess(notebookPath)
			if (!accessAllowed) {
				await task.say("rooignore_error", notebookPath)
				pushToolResult(formatResponse.rooIgnoreError(notebookPath))
				return
			}

			let content: string
			try {
				content = await fs.readFile(absolutePath, "utf8")
			} catch (error) {
				pushToolResult(formatResponse.toolError(`Failed to read notebook: ${error}`))
				return
			}

			let notebook: NotebookContent
			try {
				notebook = JSON.parse(content)
			} catch (error) {
				pushToolResult(formatResponse.toolError(`Invalid notebook JSON: ${error}`))
				return
			}

			const formattedOutput = this.formatNotebook(notebook, getReadablePath(task.cwd, notebookPath))
			pushToolResult(formattedOutput)
		} catch (error) {
			await handleError("reading notebook", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** @internal Exposed for testing */
	public formatNotebook(notebook: NotebookContent, notebookPath: string): string {
		const lines: string[] = []

		lines.push(`## Jupyter Notebook: ${notebookPath}`)
		lines.push(`**Format:** nbformat ${notebook.nbformat || "?"}.${notebook.nbformat_minor || "?"}`)
		lines.push(`**Cells:** ${notebook.cells?.length || 0}`)
		lines.push("")

		if (!notebook.cells || notebook.cells.length === 0) {
			lines.push("*No cells in this notebook*")
			return lines.join("\n")
		}

		notebook.cells.forEach((cell, index) => {
			lines.push(`---`)
			lines.push(`### Cell ${index} [${cell.cell_type}]${cell.id ? ` (id: ${cell.id})` : ""}`)

			if (cell.cell_type === "code" && cell.execution_count !== undefined && cell.execution_count !== null) {
				lines.push(`**Execution count:** ${cell.execution_count}`)
			}

			lines.push("")
			lines.push("**Source:**")
			lines.push("```" + (cell.cell_type === "code" ? "python" : "markdown"))
			lines.push(this.normalizeSource(cell.source))
			lines.push("```")

			if (cell.cell_type === "code" && cell.outputs && cell.outputs.length > 0) {
				lines.push("")
				lines.push("**Outputs:**")
				cell.outputs.forEach((output, outIdx) => {
					lines.push(this.formatOutput(output, outIdx))
				})
			}

			lines.push("")
		})

		return lines.join("\n")
	}

	/** @internal Exposed for testing */
	public normalizeSource(source: string[] | string): string {
		if (Array.isArray(source)) {
			return source.join("")
		}
		return source
	}

	private formatOutput(output: NotebookOutput, index: number): string {
		const lines: string[] = []

		switch (output.output_type) {
			case "stream":
				lines.push(`[${index}] stream:`)
				lines.push("```")
				lines.push(this.normalizeSource(output.text || ""))
				lines.push("```")
				break

			case "execute_result":
			case "display_data":
				lines.push(`[${index}] ${output.output_type}:`)
				if (output.data) {
					if (output.data["text/plain"]) {
						lines.push("```")
						lines.push(this.normalizeSource(output.data["text/plain"]))
						lines.push("```")
					} else if (output.data["text/html"]) {
						lines.push("*(HTML output)*")
					} else if (output.data["image/png"] || output.data["image/jpeg"]) {
						lines.push("*(Image output)*")
					} else {
						lines.push(`*(${Object.keys(output.data).join(", ")})*`)
					}
				}
				break

			case "error":
				lines.push(`[${index}] error: ${output.ename}: ${output.evalue}`)
				if (output.traceback) {
					lines.push("```")
					lines.push(output.traceback.join("\n"))
					lines.push("```")
				}
				break

			default:
				lines.push(`[${index}] ${output.output_type}`)
		}

		return lines.join("\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"read_notebook">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const readNotebookTool = new ReadNotebookTool()
