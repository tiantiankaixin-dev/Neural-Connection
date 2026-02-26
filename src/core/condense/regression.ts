import Anthropic from "@anthropic-ai/sdk"

import { ApiHandler } from "../../api"
import { SummaryPanel, SummaryEntry } from "../webview/SummaryPanel"
import { loadAllSummaryEntries, loadGlobalSummary } from "../task-persistence/memory-persistence"

/**
 * Result of a memory regression drill-down.
 */
export interface RegressionResult {
	/** Whether the regression succeeded */
	success: boolean
	/** The query that triggered the regression */
	query: string
	/** The chain of summaries drilled through (from coarsest to finest) */
	chain: RegressionStep[]
	/** The final original messages retrieved */
	originalMessages: any[]
	/** Error message if regression failed */
	error?: string
}

export interface RegressionStep {
	level: "global" | "individual" | "rolling"
	summaryText: string
	entryId: string
}

/**
 * Extract text content from an Anthropic message content field.
 */
function extractText(content: string | Anthropic.Messages.ContentBlockParam[]): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.filter((block): block is Anthropic.Messages.TextBlockParam => (block as any).type === "text")
			.map((block) => block.text)
			.join("\n")
	}
	return String(content)
}

/**
 * Call the regression model with a prompt and collect the full text response.
 */
async function callRegressionModel(apiHandler: ApiHandler, systemPrompt: string, userMessage: string): Promise<string> {
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: userMessage }]

	let result = ""
	const stream = apiHandler.createMessage(systemPrompt, messages)

	for await (const chunk of stream) {
		if (chunk.type === "text") {
			result += chunk.text
		}
	}

	return result.trim()
}

/**
 * Hierarchical memory regression: drills down from Global Q → Individual Summary → Original Messages.
 *
 * Flow:
 * 1. Collect all summary entries from SummaryPanel
 * 2. If Global Q exists, use it as the starting point
 * 3. Ask the regression model which Individual Summary is most relevant to the query
 * 4. Return the selected summary's sourceMessages (original conversation)
 *
 * @param query - The information the AI needs to recall
 * @param apiHandler - The regression model API handler
 * @returns RegressionResult with the drill-down chain and original messages
 */
export async function regressMemory(
	query: string,
	apiHandler: ApiHandler,
	options?: { globalStoragePath?: string; taskId?: string },
): Promise<RegressionResult> {
	// Load entries: prefer disk (memory/summaries/) if globalStoragePath+taskId provided, fall back to SummaryPanel
	let entries: SummaryEntry[] = []
	if (options?.globalStoragePath && options?.taskId) {
		try {
			entries = await loadAllSummaryEntries(options.globalStoragePath, options.taskId)
			// Also load Global Q from disk and prepend if not already in entries
			const globalQ = await loadGlobalSummary(options.globalStoragePath, options.taskId)
			if (globalQ && !entries.some((e) => e.isGlobal)) {
				entries.unshift({
					id: globalQ.condenseId,
					timestamp: globalQ.timestamp,
					text: globalQ.text,
					isGlobal: true,
				})
			}
		} catch (err) {
			console.warn("[regressMemory] Failed to load entries from disk, falling back to SummaryPanel:", err)
		}
	}
	// Fall back to in-memory SummaryPanel if disk load returned nothing
	if (entries.length === 0) {
		entries = SummaryPanel.getInstance().getEntries()
	}

	if (entries.length === 0) {
		return {
			success: false,
			query,
			chain: [],
			originalMessages: [],
			error: "No summary entries available for regression",
		}
	}

	const chain: RegressionStep[] = []

	// Step 1: Find the Global Q (if exists)
	const globalEntry = entries.find((e) => e.isGlobal)
	if (globalEntry) {
		chain.push({
			level: "global",
			summaryText: globalEntry.text,
			entryId: globalEntry.id,
		})
	}

	// Step 2: Collect Individual and Rolling summaries
	const individualEntries = entries.filter((e) => !e.isGlobal && !e.isRolling)
	const rollingEntries = entries.filter((e) => e.isRolling)

	// If only one non-global summary exists, return its sourceMessages directly
	const allNonGlobal = [...individualEntries, ...rollingEntries]
	if (allNonGlobal.length === 0) {
		// Only a Global Q exists, return its sourceMessages
		if (globalEntry?.sourceMessages?.length) {
			return {
				success: true,
				query,
				chain,
				originalMessages: globalEntry.sourceMessages,
			}
		}
		return {
			success: false,
			query,
			chain,
			originalMessages: [],
			error: "No detailed summaries available to drill into",
		}
	}

	if (allNonGlobal.length === 1) {
		// Only one summary, no need to ask the model which one
		const only = allNonGlobal[0]
		chain.push({
			level: only.isRolling ? "rolling" : "individual",
			summaryText: only.text,
			entryId: only.id,
		})
		return {
			success: true,
			query,
			chain,
			originalMessages: only.sourceMessages || [],
		}
	}

	// Step 3: Multiple summaries — ask the regression model which one is most relevant
	try {
		const summaryList = allNonGlobal
			.map((entry, idx) => {
				const tag = entry.isRolling ? "[Rolling]" : "[Individual]"
				const time = new Date(entry.timestamp).toISOString()
				return `### Summary ${idx + 1} ${tag} (${time})\n${entry.text}`
			})
			.join("\n\n")

		const systemPrompt = `You are a memory retrieval assistant. Given a query and a list of conversation summaries, determine which summary is MOST relevant to the query. Reply with ONLY the summary number (e.g. "1", "2", "3"). Do not explain.`

		const userMessage = `Query: ${query}\n\n---\n\n${summaryList}\n\n---\n\nWhich summary number (1-${allNonGlobal.length}) is most relevant to the query? Reply with the number only.`

		const response = await callRegressionModel(apiHandler, systemPrompt, userMessage)

		// Parse the number from the response
		const match = response.match(/(\d+)/)
		if (!match) {
			return {
				success: false,
				query,
				chain,
				originalMessages: [],
				error: `Regression model returned unparseable response: "${response}"`,
			}
		}

		const selectedIdx = parseInt(match[1], 10) - 1
		if (selectedIdx < 0 || selectedIdx >= allNonGlobal.length) {
			return {
				success: false,
				query,
				chain,
				originalMessages: [],
				error: `Regression model selected out-of-range index: ${selectedIdx + 1}`,
			}
		}

		const selected = allNonGlobal[selectedIdx]
		chain.push({
			level: selected.isRolling ? "rolling" : "individual",
			summaryText: selected.text,
			entryId: selected.id,
		})

		// Step 4: If the selected summary has sourceMessages, we have the original messages
		if (selected.sourceMessages?.length) {
			return {
				success: true,
				query,
				chain,
				originalMessages: selected.sourceMessages,
			}
		}

		// No sourceMessages on the selected summary
		return {
			success: true,
			query,
			chain,
			originalMessages: [],
			error: "Selected summary has no source messages attached",
		}
	} catch (error) {
		return {
			success: false,
			query,
			chain,
			originalMessages: [],
			error: `Regression model call failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

/**
 * Format regression result as a context string that can be injected into the AI's conversation.
 */
export function formatRegressionResult(result: RegressionResult): string {
	if (!result.success || result.originalMessages.length === 0) {
		return `[Memory Regression] No relevant original messages found for query: "${result.query}"${result.error ? ` (${result.error})` : ""}`
	}

	const chainDesc = result.chain
		.map((step) => {
			const label =
				step.level === "global"
					? "Global Q"
					: step.level === "individual"
						? "Individual Summary"
						: "Rolling Summary"
			return `${label}: ${step.summaryText.slice(0, 100)}...`
		})
		.join(" → ")

	const messagesText = result.originalMessages
		.map((msg) => {
			const role = msg.role || "unknown"
			const content = typeof msg.content === "string" ? msg.content : extractText(msg.content)
			const time = msg.ts ? new Date(msg.ts).toISOString() : ""
			return `[${role}${time ? " " + time : ""}]: ${content}`
		})
		.join("\n\n")

	return `[Memory Regression] Drill-down: ${chainDesc}\n\n--- Original Messages ---\n${messagesText}`
}
