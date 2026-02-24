import axios from "axios"
import * as cheerio from "cheerio"

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface SearchWebParams {
	query: string
	domain?: string | null
	max_results?: number | null
}

interface SearchResult {
	title: string
	url: string
	snippet: string
}

interface SearchWebResult {
	status: "success" | "error"
	query: string
	domain?: string
	results?: SearchResult[]
	error?: string
}

const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS_LIMIT = 10
const REQUEST_TIMEOUT = 15000

export class SearchWebTool extends BaseTool<"search_web"> {
	readonly name = "search_web" as const

	async execute(params: SearchWebParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const { query, domain, max_results } = params

		try {
			if (!query) {
				task.consecutiveMistakeCount++
				task.recordToolError("search_web")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("search_web", "query"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Ask for approval before making external request
			const didApprove = await askApproval(
				"tool",
				JSON.stringify({ tool: "searchWeb", query, domain: domain || undefined }),
			)
			if (!didApprove) {
				return
			}

			const effectiveMaxResults = Math.min(max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT)
			const result = await this.performSearch(query, domain || undefined, effectiveMaxResults)
			const resultText = this.formatResult(result)

			pushToolResult(resultText)
		} catch (error) {
			await handleError("performing web search", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async performSearch(
		query: string,
		domain: string | undefined,
		maxResults: number,
	): Promise<SearchWebResult> {
		try {
			// Build search query with optional site restriction
			const searchQuery = domain ? `site:${domain} ${query}` : query

			// Use DuckDuckGo HTML search (no API key required)
			const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`

			const response = await axios.get(searchUrl, {
				timeout: REQUEST_TIMEOUT,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; RooCode/1.0; +https://roocode.com)",
					Accept: "text/html",
				},
			})

			const results = this.parseDuckDuckGoResults(response.data, maxResults)

			return {
				status: "success",
				query,
				domain: domain || undefined,
				results,
			}
		} catch (error) {
			if (axios.isAxiosError(error)) {
				if (error.code === "ECONNABORTED") {
					return { status: "error", query, error: "Search request timed out" }
				}
				return { status: "error", query, error: error.message }
			}
			return {
				status: "error",
				query,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	private parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
		const results: SearchResult[] = []

		try {
			const $ = cheerio.load(html)

			$(".result").each((_index, element) => {
				if (results.length >= maxResults) return

				const $result = $(element)
				const titleElement = $result.find(".result__title a")
				const snippetElement = $result.find(".result__snippet")

				const title = titleElement.text().trim()
				const url = titleElement.attr("href") || ""
				const snippet = snippetElement.text().trim()

				// Extract actual URL from DuckDuckGo redirect
				const actualUrl = this.extractActualUrl(url)

				if (title && actualUrl) {
					results.push({
						title,
						url: actualUrl,
						snippet: snippet || "(No description available)",
					})
				}
			})
		} catch {
			// Return empty results on parse error
		}

		return results
	}

	/** @internal Exposed for testing */
	public extractActualUrl(ddgUrl: string): string {
		try {
			// DuckDuckGo wraps URLs like //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
			if (ddgUrl.includes("uddg=")) {
				const match = ddgUrl.match(/uddg=([^&]+)/)
				if (match) {
					return decodeURIComponent(match[1])
				}
			}
			// If it's already a normal URL
			if (ddgUrl.startsWith("http://") || ddgUrl.startsWith("https://")) {
				return ddgUrl
			}
			// Handle protocol-relative URLs
			if (ddgUrl.startsWith("//")) {
				return "https:" + ddgUrl
			}
			return ddgUrl
		} catch {
			return ddgUrl
		}
	}

	/** @internal Exposed for testing */
	public formatResult(result: SearchWebResult): string {
		const lines: string[] = []

		if (result.status === "error") {
			lines.push(`## Search Failed`)
			lines.push(`**Query:** ${result.query}`)
			lines.push("")
			lines.push(`**Error:** ${result.error}`)
			return lines.join("\n")
		}

		lines.push(`## Search Results`)
		lines.push(`**Query:** ${result.query}`)

		if (result.domain) {
			lines.push(`**Domain Filter:** ${result.domain}`)
		}

		if (!result.results || result.results.length === 0) {
			lines.push("")
			lines.push("No results found.")
			return lines.join("\n")
		}

		lines.push(`**Results:** ${result.results.length}`)
		lines.push("")

		result.results.forEach((r, index) => {
			lines.push(`### ${index + 1}. ${r.title}`)
			lines.push(`**URL:** ${r.url}`)
			lines.push(`${r.snippet}`)
			lines.push("")
		})

		return lines.join("\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"search_web">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const searchWebTool = new SearchWebTool()
