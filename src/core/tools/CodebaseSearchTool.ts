import * as vscode from "vscode"
import path from "path"

import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { VectorStoreSearchResult } from "../../services/code-index/interfaces"
import { ExpandedSearchResult } from "../../services/code-index/graph-expander"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchParams {
	query: string
	path?: string
}

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, path: directoryPrefix } = params

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("codebase_search", new Error("Could not determine workspace path."))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("codebase_search", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = CodeIndexManager.getInstance(context)

			if (!manager) {
				throw new Error("CodeIndexManager is not available.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Code Indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error("Code Indexing is not configured (Missing OpenAI Key or Qdrant URL).")
			}

			const searchResults: VectorStoreSearchResult[] = await manager.searchIndex(query, directoryPrefix)

			if (!searchResults || searchResults.length === 0) {
				pushToolResult(`No relevant code snippets found for the query: "${query}"`)
				return
			}

			const jsonResult = {
				query,
				results: [],
			} as {
				query: string
				results: Array<{
					filePath: string
					score: number
					startLine: number
					endLine: number
					codeChunk: string
					pageRank?: number
					isDirectHit?: boolean
					relationType?: string
				}>
			}

			searchResults.forEach((result) => {
				const p = (result as ExpandedSearchResult).payload || (result as VectorStoreSearchResult).payload
				if (!p) return
				if (!("filePath" in p)) return

				const relativePath = vscode.workspace.asRelativePath(p.filePath, false)
				const expanded = result as ExpandedSearchResult

				jsonResult.results.push({
					filePath: relativePath,
					score: result.score,
					startLine: p.startLine,
					endLine: p.endLine,
					codeChunk: p.codeChunk.trim(),
					pageRank: p.pageRank as number | undefined,
					isDirectHit: expanded.isDirectHit,
					relationType: expanded.relationType,
				})
			})

			const payload = { tool: "codebaseSearch", content: jsonResult }
			await task.say("codebase_search_result", JSON.stringify(payload))

			const directHits = jsonResult.results.filter((r) => r.isDirectHit !== false)
			const relatedCode = jsonResult.results.filter((r) => r.isDirectHit === false)

			let output = `Query: ${query}\n`

			if (directHits.length > 0) {
				output += `\n=== Direct Hits ===\n\n`
				output += directHits
					.map(
						(r) =>
							`File: ${r.filePath}  Score: ${r.score.toFixed(2)}  Lines: ${r.startLine}-${r.endLine}${r.pageRank ? `  PR: ${r.pageRank.toFixed(3)}` : ""}\nCode: ${r.codeChunk}\n`,
					)
					.join("\n")
			}

			if (relatedCode.length > 0) {
				output += `\n=== Related Code ===\n\n`
				output += relatedCode
					.map(
						(r) =>
							`File: ${r.filePath}  Lines: ${r.startLine}-${r.endLine}  [${r.relationType || "related"}]${r.pageRank ? `  PR: ${r.pageRank.toFixed(3)}` : ""}\nCode: ${r.codeChunk}\n`,
					)
					.join("\n")
			}

			pushToolResult(output)
		} catch (error: any) {
			await handleError("codebase_search", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"codebase_search">): Promise<void> {
		const query: string | undefined = block.params.query
		const directoryPrefix: string | undefined = block.params.path

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const codebaseSearchTool = new CodebaseSearchTool()
