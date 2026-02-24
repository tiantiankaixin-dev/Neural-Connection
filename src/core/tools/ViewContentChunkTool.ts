import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ViewContentChunkParams {
	document_id: string
	position: number
}

interface DocumentChunk {
	content: string
	position: number
	totalChunks: number
}

interface DocumentCache {
	url: string
	title?: string
	chunks: string[]
	fetchedAt: number
}

const CHUNK_SIZE = 8000
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

export class ViewContentChunkTool extends BaseTool<"view_content_chunk"> {
	readonly name = "view_content_chunk" as const

	// In-memory cache of fetched documents
	private documentCache: Map<string, DocumentCache> = new Map()

	async execute(params: ViewContentChunkParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		const { document_id, position } = params

		try {
			// Validate required parameters
			if (!document_id) {
				task.consecutiveMistakeCount++
				task.recordToolError("view_content_chunk")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("view_content_chunk", "document_id"))
				return
			}

			if (position === undefined || position === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("view_content_chunk")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("view_content_chunk", "position"))
				return
			}

			if (position < 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("view_content_chunk")
				pushToolResult(formatResponse.toolError("Position must be a non-negative integer."))
				return
			}

			task.consecutiveMistakeCount = 0

			// Look up document in cache
			const document = this.getDocument(document_id)

			if (!document) {
				pushToolResult(
					formatResponse.toolError(
						`Document '${document_id}' not found. Make sure you have read the URL with read_url_content first.`,
					),
				)
				return
			}

			// Get the chunk
			const chunk = this.getChunk(document, position)

			if (!chunk) {
				pushToolResult(
					formatResponse.toolError(
						`Chunk position ${position} out of range. Document has ${document.chunks.length} chunks (0-${document.chunks.length - 1}).`,
					),
				)
				return
			}

			const resultText = this.formatChunk(document_id, document.url, chunk)
			pushToolResult(resultText)
		} catch (error) {
			await handleError("viewing content chunk", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** Store a document in cache (called by ReadUrlContentTool) */
	public cacheDocument(documentId: string, url: string, content: string, title?: string): void {
		const chunks = this.splitIntoChunks(content, CHUNK_SIZE)

		this.documentCache.set(documentId, {
			url,
			title,
			chunks,
			fetchedAt: Date.now(),
		})

		// Clean up expired entries
		this.cleanupExpiredDocuments()
	}

	/** Get a document from cache */
	private getDocument(documentId: string): DocumentCache | undefined {
		const document = this.documentCache.get(documentId)

		if (!document) {
			return undefined
		}

		// Check if expired
		if (Date.now() - document.fetchedAt > CACHE_TTL_MS) {
			this.documentCache.delete(documentId)
			return undefined
		}

		return document
	}

	/** Get a specific chunk from a document */
	private getChunk(document: DocumentCache, position: number): DocumentChunk | undefined {
		if (position >= document.chunks.length) {
			return undefined
		}

		return {
			content: document.chunks[position],
			position,
			totalChunks: document.chunks.length,
		}
	}

	/** @internal Exposed for testing */
	public splitIntoChunks(content: string, chunkSize: number): string[] {
		const chunks: string[] = []

		if (!content || content.length === 0) {
			return [""]
		}

		let start = 0
		while (start < content.length) {
			let end = Math.min(start + chunkSize, content.length)

			// Try to break at a paragraph or sentence boundary
			if (end < content.length) {
				const breakPoints = ["\n\n", "\n", ". ", "! ", "? "]
				for (const bp of breakPoints) {
					const lastBreak = content.lastIndexOf(bp, end)
					if (lastBreak > start + chunkSize * 0.5) {
						end = lastBreak + bp.length
						break
					}
				}
			}

			chunks.push(content.slice(start, end))
			start = end
		}

		return chunks
	}

	/** Clean up expired documents */
	private cleanupExpiredDocuments(): void {
		const now = Date.now()
		for (const [id, doc] of this.documentCache.entries()) {
			if (now - doc.fetchedAt > CACHE_TTL_MS) {
				this.documentCache.delete(id)
			}
		}
	}

	/** @internal Exposed for testing */
	public formatChunk(documentId: string, url: string, chunk: DocumentChunk): string {
		const lines: string[] = []

		lines.push(`## Document Chunk`)
		lines.push(`**Document ID:** ${documentId}`)
		lines.push(`**URL:** ${url}`)
		lines.push(`**Chunk:** ${chunk.position + 1} of ${chunk.totalChunks}`)
		lines.push("")

		if (chunk.position < chunk.totalChunks - 1) {
			lines.push(`*Use view_content_chunk with position=${chunk.position + 1} to see the next chunk.*`)
			lines.push("")
		}

		lines.push("**Content:**")
		lines.push("")
		lines.push(chunk.content)

		return lines.join("\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"view_content_chunk">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const viewContentChunkTool = new ViewContentChunkTool()
