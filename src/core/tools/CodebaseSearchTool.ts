import * as vscode from "vscode"
import path from "path"

import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { VectorStoreSearchResult } from "../../services/code-index/interfaces"
import { GraphExpander, ExpandedSearchResult } from "../../services/code-index/graph-expander"
import { SearchMode, resolveSearchConfig } from "../../services/code-index/search-config"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchParams {
	query: string | string[]
	path?: string
}

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	/**
	 * Mode is derived from the tool alias name (codebase_search_precise / codebase_search_broad).
	 * Stored per-call by the overridden handle() method.
	 */
	private _currentMode: SearchMode = "broad"

	override async handle(task: Task, block: ToolUse<"codebase_search">, callbacks: ToolCallbacks): Promise<void> {
		// Derive mode from the original tool name (alias) chosen by the model
		const alias = block.originalName ?? block.name
		this._currentMode = alias === "codebase_search_precise" ? "precise" : "broad"
		return super.handle(task, block, callbacks)
	}

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query: rawQuery, path: directoryPrefix } = params
		const mode: SearchMode = this._currentMode
		const resolved = resolveSearchConfig(mode)

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
				const results = await manager.searchIndex(q, directoryPrefix, resolved)
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
				absolutePath: string
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
				refs?: string[] // 添加 refs 字段显示关系信息
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
					absolutePath: path.isAbsolute(p.filePath as string)
						? (p.filePath as string)
						: path.resolve(workspacePath, p.filePath as string),
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
					refs: p.refs as string[] | undefined,
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
			const directHitsSorted = allResults
				.map((r, i) => ({ r, i }))
				.filter(({ r, i }) => r.isDirectHit !== false && !absorbed.has(i))
				.sort((a, b) => b.r.score - a.r.score)
			const relatedCodeSorted = allResults
				.map((r, i) => ({ r, i }))
				.filter(({ r, i }) => r.isDirectHit === false && !absorbed.has(i))
				.sort((a, b) => b.r.score - a.r.score)

			// Global per-file limit: after merging results from multiple queries,
			// cap blocks per file to prevent over-representation.
			// Without this, a file matched by N queries can appear up to
			// N * maxDirectPerFile times in the merged output.
			const GLOBAL_MAX_DIRECT_PER_FILE = resolved.globalMaxDirectPerFile
			const GLOBAL_MAX_RELATED_PER_FILE = resolved.globalMaxRelatedPerFile

			const applyGlobalPerFileLimit = <T extends { r: EnrichedResult }>(items: T[], maxPerFile: number): T[] => {
				const fileCount = new Map<string, number>()
				const fileRanges = new Map<string, Array<{ start: number; end: number }>>()
				return items.filter(({ r }) => {
					const count = fileCount.get(r.filePath) || 0
					if (count >= maxPerFile) return false

					// Skip blocks whose line range overlaps >50% with an already-accepted
					// block from the same file (e.g., PlayerInteraction 7-41 vs 20-45)
					const start = r.startLine || 0
					const end = r.endLine || 0
					const accepted = fileRanges.get(r.filePath) || []
					if (
						start > 0 &&
						end > 0 &&
						GraphExpander.hasSignificantOverlap(start, end, accepted, resolved.overlapThreshold)
					) {
						return false
					}

					fileCount.set(r.filePath, count + 1)
					if (start > 0 && end > 0) {
						accepted.push({ start, end })
						fileRanges.set(r.filePath, accepted)
					}
					return true
				})
			}

			const directHitsFiltered = applyGlobalPerFileLimit(directHitsSorted, GLOBAL_MAX_DIRECT_PER_FILE)
			const relatedCodeFiltered = applyGlobalPerFileLimit(relatedCodeSorted, GLOBAL_MAX_RELATED_PER_FILE)

			// Apply global total caps (prevents multi-query merge from producing 40+ results)
			const directHits = directHitsFiltered.slice(0, resolved.maxTotalDirectHits)
			const relatedCode = relatedCodeFiltered.slice(0, resolved.maxTotalRelatedCode)

			// ── Format output with metadata enrichment ──
			const formatBlock = (r: EnrichedResult, isRelated: boolean): string => {
				// Check if this block covers most of the file (>200 lines = likely complete)
				const lineCount = r.endLine - r.startLine + 1
				const isLikelyComplete = lineCount > 200

				let header = `File: ${r.filePath}  Score: ${r.score.toFixed(2)}  Lines: ${r.startLine}-${r.endLine}`
				if (isLikelyComplete) header += `  [COMPLETE FILE - DO NOT read_file]`
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
				if (r.refs && r.refs.length > 0) {
					meta.push(`Refs: ${r.refs.join(", ")}`)
				}

				let block = header + "\n"
				if (meta.length > 0) block += meta.join("\n") + "\n"

				// Truncate large merged blocks to prevent host-side context truncation.
				// Show class structure (top) + recent methods (bottom) with omission marker.
				const MAX_CODE_LINES = 120
				const codeLines = r.codeChunk.split("\n")
				if (codeLines.length > MAX_CODE_LINES) {
					const SHOW_FIRST = 80
					const SHOW_LAST = 20
					const omitted = codeLines.length - SHOW_FIRST - SHOW_LAST
					const firstPart = codeLines.slice(0, SHOW_FIRST).join("\n")
					const lastPart = codeLines.slice(-SHOW_LAST).join("\n")
					block += `Code: ${firstPart}\n\n// ... [${omitted} lines omitted — full content indexed, do NOT read_file] ...\n\n${lastPart}\n`
				} else {
					block += `Code: ${r.codeChunk}\n`
				}
				return block
			}

			let output = `Query: ${queries.join(" | ")}  [mode=${mode}]\n`

			// ── Block merging helper: merge adjacent blocks from the same file ──
			const mergeBlocks = async (results: EnrichedResult[]): Promise<EnrichedResult[]> => {
				const byFile = new Map<string, EnrichedResult[]>()
				for (const r of results) {
					const arr = byFile.get(r.filePath) || []
					arr.push(r)
					byFile.set(r.filePath, arr)
				}

				const MERGE_MIN_BLOCKS = 2
				const MAX_GAP_FILL = Infinity // Merge all same-file blocks into complete files (truncated in formatBlock)
				const merged: EnrichedResult[] = []

				for (const [, blocks] of byFile) {
					if (blocks.length < MERGE_MIN_BLOCKS) {
						merged.push(...blocks)
						continue
					}
					blocks.sort((a, b) => a.startLine - b.startLine)

					let fileLines: string[] | null = null
					try {
						const filePath = blocks[0].absolutePath
						console.log(`[mergeBlocks] Reading file for merge: ${filePath} (${blocks.length} blocks)`)
						const uri = vscode.Uri.file(filePath)
						const bytes = await vscode.workspace.fs.readFile(uri)
						fileLines = Buffer.from(bytes).toString("utf-8").split(/\r?\n/)
					} catch (err) {
						console.error(`[mergeBlocks] Failed to read file: ${blocks[0].absolutePath}`, err)
					}

					if (!fileLines) {
						merged.push(...blocks)
						continue
					}

					let cur = { ...blocks[0] }
					for (let i = 1; i < blocks.length; i++) {
						const next = blocks[i]
						const gap = next.startLine - cur.endLine - 1
						// gap < 0 means overlapping blocks → always merge
						// gap >= 0 means gap between blocks → merge if within MAX_GAP_FILL
						if (gap <= MAX_GAP_FILL) {
							const mergedCode = fileLines.slice(cur.startLine - 1, next.endLine).join("\n")
							const allDefines = [...(cur.defines || []), ...(next.defines || [])]
							const allRefs = [...(cur.refs || []), ...(next.refs || [])]
							cur = {
								...cur,
								endLine: next.endLine,
								codeChunk: mergedCode,
								score: Math.max(cur.score, next.score),
								defines: [...new Set(allDefines)],
								refs: [...new Set(allRefs)],
							}
						} else {
							merged.push(cur)
							cur = { ...next }
						}
					}
					merged.push(cur)
				}
				return merged.sort((a, b) => b.score - a.score)
			}

			// ── Merge Direct Hits only, then cap ──
			// Merge same-file blocks into complete files (e.g., 30 blocks → 1 block).
			// Related Code stays as individual small blocks to save output space.
			// Large merged blocks are truncated in formatBlock to prevent context overflow.
			const mergedDirectHits = (await mergeBlocks(directHitsFiltered.map(({ r }) => r))).slice(
				0,
				resolved.maxTotalDirectHits,
			)

			if (mergedDirectHits.length > 0) {
				output += `\n=== Direct Hits ===\n\n`
				output += mergedDirectHits.map((r) => formatBlock(r, false)).join("\n")
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
