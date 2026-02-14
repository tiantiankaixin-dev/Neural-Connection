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
	query: string | string[]
	path?: string
}

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query: rawQuery, path: directoryPrefix } = params

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("codebase_search", new Error("Could not determine workspace path."))
			return
		}

		// Normalize query to array (handle both string and string[])
		const queries: string[] = Array.isArray(rawQuery)
			? rawQuery.filter((q) => q && q.trim().length > 0)
			: rawQuery && rawQuery.trim().length > 0
				? [rawQuery]
				: []

		if (queries.length === 0) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("codebase_search", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: queries.length === 1 ? queries[0] : queries,
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

			// Search with each query and merge results (dedup by ID, keep highest score)
			const mergedMap = new Map<string | number, VectorStoreSearchResult>()
			for (const q of queries) {
				const results = await manager.searchIndex(q, directoryPrefix)
				if (results) {
					for (const r of results) {
						const existing = mergedMap.get(r.id)
						if (!existing || r.score > existing.score) {
							mergedMap.set(r.id, r)
						}
					}
				}
			}
			const searchResults = Array.from(mergedMap.values())

			if (searchResults.length === 0) {
				pushToolResult(
					`No relevant code snippets found for queries: ${queries.map((q) => `"${q}"`).join(", ")}`,
				)
				return
			}

			interface EnrichedResult {
				filePath: string
				score: number
				startLine: number
				endLine: number
				codeChunk: string
				pageRank?: number
				isDirectHit?: boolean
				relationType?: string
				className?: string | null
				classExtends?: string | null
				defines?: string[]
			}

			const allResults: EnrichedResult[] = []

			searchResults.forEach((result) => {
				const p = (result as ExpandedSearchResult).payload || (result as VectorStoreSearchResult).payload
				if (!p) return
				if (!("filePath" in p)) return

				const relativePath = vscode.workspace.asRelativePath(p.filePath, false)
				const expanded = result as ExpandedSearchResult

				allResults.push({
					filePath: relativePath,
					score: result.score,
					startLine: p.startLine,
					endLine: p.endLine,
					codeChunk: p.codeChunk.trim(),
					pageRank: p.pageRank as number | undefined,
					isDirectHit: expanded.isDirectHit,
					relationType: expanded.relationType,
					className: p.className as string | null | undefined,
					classExtends: p.classExtends as string | null | undefined,
					defines: p.defines as string[] | undefined,
				})
			})

			// Send raw results to webview (unchanged)
			const jsonResult = { query: queries, results: allResults }
			const payload = { tool: "codebaseSearch", content: jsonResult }
			await task.say("codebase_search_result", JSON.stringify(payload))

			// ── Result refinement: absorb fully-contained blocks ──
			const absorbed = new Set<number>()
			for (let i = 0; i < allResults.length; i++) {
				if (absorbed.has(i)) continue
				for (let j = i + 1; j < allResults.length; j++) {
					if (absorbed.has(j)) continue
					const a = allResults[i]
					const b = allResults[j]
					if (a.filePath !== b.filePath) continue
					if (
						a.startLine <= b.startLine &&
						a.endLine >= b.endLine &&
						a.endLine - a.startLine > b.endLine - b.startLine
					) {
						absorbed.add(j)
					} else if (
						b.startLine <= a.startLine &&
						b.endLine >= a.endLine &&
						b.endLine - b.startLine > a.endLine - a.startLine
					) {
						absorbed.add(i)
					}
				}
			}

			// Split into direct/related, skip absorbed, sort by score descending
			const directHits = allResults
				.map((r, i) => ({ r, i }))
				.filter(({ r, i }) => r.isDirectHit !== false && !absorbed.has(i))
				.sort((a, b) => b.r.score - a.r.score)
			const relatedCode = allResults
				.map((r, i) => ({ r, i }))
				.filter(({ r, i }) => r.isDirectHit === false && !absorbed.has(i))
				.sort((a, b) => b.r.score - a.r.score)

			// ── Format output with metadata enrichment ──
			const formatBlock = (r: EnrichedResult, isRelated: boolean): string => {
				let header = `File: ${r.filePath}  Score: ${r.score.toFixed(2)}  Lines: ${r.startLine}-${r.endLine}`
				if (r.pageRank) header += `  PR: ${r.pageRank.toFixed(3)}`
				if (isRelated && r.relationType) header += `  [${r.relationType}]`

				const meta: string[] = []
				if (r.className) {
					let classInfo = `Class: ${r.className}`
					if (r.classExtends) classInfo += ` (extends ${r.classExtends})`
					meta.push(classInfo)
				}
				if (r.defines && r.defines.length > 0) {
					meta.push(`Defines: ${r.defines.join(", ")}`)
				}

				let block = header + "\n"
				if (meta.length > 0) block += meta.join("\n") + "\n"
				block += `Code: ${r.codeChunk}\n`
				return block
			}

			let output = `Query: ${queries.join(" | ")}\n`

			if (directHits.length > 0) {
				output += `\n=== Direct Hits ===\n\n`
				output += directHits.map(({ r }) => formatBlock(r, false)).join("\n")
			}

			if (relatedCode.length > 0) {
				output += `\n=== Related Code ===\n\n`
				output += relatedCode.map(({ r }) => formatBlock(r, true)).join("\n")
			}

			pushToolResult(output)
		} catch (error: any) {
			await handleError("codebase_search", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"codebase_search">): Promise<void> {
		const rawQuery = block.params.query as string | string[] | undefined
		const directoryPrefix: string | undefined = block.params.path

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: rawQuery,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const codebaseSearchTool = new CodebaseSearchTool()
