import axios from "axios"
import * as cheerio from "cheerio"

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ReadUrlContentParams {
	url: string
	max_length?: number | null
}

interface ReadUrlContentResult {
	status: "success" | "error"
	url: string
	title?: string
	content?: string
	content_truncated?: boolean
	error?: string
}

const DEFAULT_MAX_LENGTH = 10000
const REQUEST_TIMEOUT = 30000

export class ReadUrlContentTool extends BaseTool<"read_url_content"> {
	readonly name = "read_url_content" as const

	async execute(params: ReadUrlContentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const { url, max_length } = params

		try {
			if (!url) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_url_content")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("read_url_content", "url"))
				return
			}

			// Validate URL format
			if (!this.isValidUrl(url)) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_url_content")
				pushToolResult(`Error: Invalid URL format. URL must start with http:// or https://`)
				return
			}

			task.consecutiveMistakeCount = 0

			// Ask for approval before making external request
			const didApprove = await askApproval("tool", JSON.stringify({ tool: "readUrlContent", url }))
			if (!didApprove) {
				return
			}

			const effectiveMaxLength = max_length ?? DEFAULT_MAX_LENGTH
			const result = await this.fetchAndParseUrl(url, effectiveMaxLength)
			const resultText = this.formatResult(result)

			pushToolResult(resultText)
		} catch (error) {
			await handleError("reading URL content", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** @internal Exposed for testing */
	public isValidUrl(url: string): boolean {
		try {
			const parsed = new URL(url)
			return parsed.protocol === "http:" || parsed.protocol === "https:"
		} catch {
			return false
		}
	}

	private async fetchAndParseUrl(url: string, maxLength: number): Promise<ReadUrlContentResult> {
		try {
			const response = await axios.get(url, {
				timeout: REQUEST_TIMEOUT,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; RooCode/1.0; +https://roocode.com)",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
				maxContentLength: 5 * 1024 * 1024, // 5MB max
				responseType: "text",
			})

			const contentType = response.headers["content-type"] || ""

			if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
				return this.parseHtmlContent(url, response.data, maxLength)
			} else if (contentType.includes("text/") || contentType.includes("application/json")) {
				// Plain text or JSON
				const content =
					typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2)
				const truncated = content.length > maxLength

				return {
					status: "success",
					url,
					content: truncated ? content.slice(0, maxLength) : content,
					content_truncated: truncated,
				}
			} else {
				return {
					status: "error",
					url,
					error: `Unsupported content type: ${contentType}. Only HTML, text, and JSON are supported.`,
				}
			}
		} catch (error) {
			if (axios.isAxiosError(error)) {
				if (error.code === "ECONNABORTED") {
					return { status: "error", url, error: "Request timed out" }
				}
				if (error.response) {
					return {
						status: "error",
						url,
						error: `HTTP ${error.response.status}: ${error.response.statusText}`,
					}
				}
				return { status: "error", url, error: error.message }
			}
			return {
				status: "error",
				url,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	private parseHtmlContent(url: string, html: string, maxLength: number): ReadUrlContentResult {
		try {
			const $ = cheerio.load(html)

			// Remove unwanted elements
			$("script, style, nav, footer, header, aside, iframe, noscript").remove()

			// Get title
			const title = $("title").text().trim() || $("h1").first().text().trim()

			// Get main content - try common content selectors
			let content = ""
			const contentSelectors = ["main", "article", '[role="main"]', ".content", "#content", ".post", "body"]

			for (const selector of contentSelectors) {
				const element = $(selector)
				if (element.length > 0) {
					content = element.text()
					break
				}
			}

			// Clean up whitespace
			content = content
				.replace(/\s+/g, " ")
				.replace(/\n\s*\n/g, "\n\n")
				.trim()

			const truncated = content.length > maxLength

			return {
				status: "success",
				url,
				title: title || undefined,
				content: truncated ? content.slice(0, maxLength) : content,
				content_truncated: truncated,
			}
		} catch (error) {
			return {
				status: "error",
				url,
				error: `Failed to parse HTML: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/** @internal Exposed for testing */
	public formatResult(result: ReadUrlContentResult): string {
		const lines: string[] = []

		if (result.status === "error") {
			lines.push(`## Failed to Read URL`)
			lines.push(`**URL:** ${result.url}`)
			lines.push("")
			lines.push(`**Error:** ${result.error}`)
			return lines.join("\n")
		}

		lines.push(`## URL Content`)
		lines.push(`**URL:** ${result.url}`)

		if (result.title) {
			lines.push(`**Title:** ${result.title}`)
		}

		if (result.content !== undefined) {
			lines.push("")
			if (result.content_truncated) {
				lines.push("**Content (truncated):**")
			} else {
				lines.push("**Content:**")
			}
			lines.push("")
			lines.push(result.content || "(no content)")
		}

		return lines.join("\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"read_url_content">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const readUrlContentTool = new ReadUrlContentTool()
