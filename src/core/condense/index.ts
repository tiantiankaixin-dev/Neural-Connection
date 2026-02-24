import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@roo-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { supportPrompt } from "../../shared/support-prompt"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { generateFoldedFileContext } from "./foldedFileContext"

export type { FoldedFileContextResult, FoldedFileContextOptions } from "./foldedFileContext"

/**
 * Converts a tool_use block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolUseToText(block: Anthropic.Messages.ToolUseBlockParam): string {
	let input: string
	if (typeof block.input === "object" && block.input !== null) {
		input = Object.entries(block.input)
			.map(([key, value]) => {
				const formattedValue =
					typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)
				return `${key}: ${formattedValue}`
			})
			.join("\n")
	} else {
		input = String(block.input)
	}
	return `[Tool Use: ${block.name}]\n${input}`
}

/**
 * Converts a tool_result block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolResultToText(block: Anthropic.Messages.ToolResultBlockParam): string {
	const errorSuffix = block.is_error ? " (Error)" : ""
	if (typeof block.content === "string") {
		return `[Tool Result${errorSuffix}]\n${block.content}`
	} else if (Array.isArray(block.content)) {
		const contentText = block.content
			.map((contentBlock) => {
				if (contentBlock.type === "text") {
					return contentBlock.text
				}
				if (contentBlock.type === "image") {
					return "[Image]"
				}
				// Handle any other content block types
				return `[${(contentBlock as { type: string }).type}]`
			})
			.join("\n")
		return `[Tool Result${errorSuffix}]\n${contentText}`
	}
	return `[Tool Result${errorSuffix}]`
}

/**
 * Converts all tool_use and tool_result blocks in a message's content to text representations.
 * This is necessary for providers like Bedrock that require the tools parameter when tool blocks are present.
 * By converting to text, we can send the conversation for summarization without the tools parameter.
 *
 * @param content - The message content (string or array of content blocks)
 * @returns The transformed content with tool blocks converted to text blocks
 */
export function convertToolBlocksToText(
	content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
	if (typeof content === "string") {
		return content
	}

	return content.map((block) => {
		if (block.type === "tool_use") {
			return {
				type: "text" as const,
				text: toolUseToText(block),
			}
		}
		if (block.type === "tool_result") {
			return {
				type: "text" as const,
				text: toolResultToText(block),
			}
		}
		return block
	})
}

/**
 * Transforms all messages by converting tool_use and tool_result blocks to text representations.
 * This ensures the conversation can be sent for summarization without requiring the tools parameter.
 *
 * @param messages - The messages to transform
 * @returns The transformed messages with tool blocks converted to text
 */
export function transformMessagesForCondensing<
	T extends { role: string; content: string | Anthropic.Messages.ContentBlockParam[] },
>(messages: T[]): T[] {
	return messages.map((msg) => ({
		...msg,
		content: convertToolBlocksToText(msg.content),
	}))
}

export const MIN_CONDENSE_THRESHOLD = 5 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100 // Maximum percentage of context window to trigger condensing

const SUMMARY_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: This is a summarization-only request. DO NOT call any tools or functions.
Your ONLY task is to analyze the conversation and produce a text summary.
Respond with text only - no tool calls will be processed.

CRITICAL: This summarization request is a SYSTEM OPERATION, not a user message.
When analyzing "user requests" and "user intent", completely EXCLUDE this summarization message.
The "most recent user request" and "next step" must be based on what the user was doing BEFORE this system message appeared.
The goal is for work to continue seamlessly after condensation - as if it never happened.`

/**
 * Injects synthetic tool_results for orphan tool_calls that don't have matching results.
 * This is necessary because OpenAI's Responses API rejects conversations with orphan tool_calls.
 * This can happen when the user triggers condense after receiving a tool_call (like attempt_completion)
 * but before responding to it.
 *
 * @param messages - The conversation messages to process
 * @returns The messages with synthetic tool_results appended if needed
 */
export function injectSyntheticToolResults(messages: ApiMessage[]): ApiMessage[] {
	// Find all tool_call IDs in assistant messages
	const toolCallIds = new Set<string>()
	// Find all tool_result IDs in user messages
	const toolResultIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolCallIds.add(block.id)
				}
			}
		}
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result") {
					toolResultIds.add(block.tool_use_id)
				}
			}
		}
	}

	// Find orphans (tool_calls without matching tool_results)
	const orphanIds = [...toolCallIds].filter((id) => !toolResultIds.has(id))

	if (orphanIds.length === 0) {
		return messages
	}

	// Inject synthetic tool_results as a new user message
	const syntheticResults: Anthropic.Messages.ToolResultBlockParam[] = orphanIds.map((id) => ({
		type: "tool_result" as const,
		tool_use_id: id,
		content: "Context condensation triggered. Tool execution deferred.",
	}))

	const syntheticMessage: ApiMessage = {
		role: "user",
		content: syntheticResults,
		ts: Date.now(),
	}

	return [...messages, syntheticMessage]
}

/**
 * Extracts <command> blocks from a message's content.
 * These blocks represent active workflows that must be preserved across condensings.
 *
 * @param message - The message to extract command blocks from
 * @returns A string containing all command blocks found, or empty string if none
 */
export function extractCommandBlocks(message: ApiMessage): string {
	const content = message.content
	let text: string

	if (typeof content === "string") {
		text = content
	} else if (Array.isArray(content)) {
		// Concatenate all text blocks
		text = content
			.filter((block): block is Anthropic.Messages.TextBlockParam => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	} else {
		return ""
	}

	// Match all <command> blocks including their content
	const commandRegex = /<command[^>]*>[\s\S]*?<\/command>/g
	const matches = text.match(commandRegex)

	if (!matches || matches.length === 0) {
		return ""
	}

	return matches.join("\n")
}

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
	errorDetails?: string // Detailed error information including stack trace and API error info
	condenseId?: string // The unique ID of the created Summary message, for linking to condense_context clineMessage
}

export type SummarizeConversationOptions = {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	isAutomaticTrigger?: boolean
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
	/** If provided, the summary heading will include the sub-task title for multi-summary model */
	subtaskTitle?: string
	/** If provided, override the default "since last summary" boundary.
	 * Summarize and tag messages from this index onward (inclusive).
	 * Intermediate summaries within the range are also tagged (replaced by the new comprehensive summary).
	 * Used by task_memory to create a full-quality summary from ALL sub-task messages. */
	summarizeFromIndex?: number
}

/**
 * Summarizes the conversation messages using an LLM call.
 *
 * This implements the "fresh start" model where:
 * - The summary becomes a user message (not assistant)
 * - Post-condense, the model sees only the summary (true fresh start)
 * - All messages are still stored but tagged with condenseParent
 * - <command> blocks from the original task are preserved across condensings
 * - File context (folded code definitions) can be preserved for continuity
 *
 * Environment details handling:
 * - For AUTOMATIC condensing (isAutomaticTrigger=true): Environment details are included
 *   in the summary because the API request is already in progress and the next user
 *   message won't have fresh environment details injected.
 * - For MANUAL condensing (isAutomaticTrigger=false): Environment details are NOT included
 *   because fresh environment details will be injected on the very next turn via
 *   getEnvironmentDetails() in recursivelyMakeClineRequests().
 */
export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeResponse> {
	const {
		messages,
		apiHandler,
		systemPrompt,
		taskId,
		isAutomaticTrigger,
		customCondensingPrompt,
		metadata,
		environmentDetails,
		filesReadByRoo,
		cwd,
		rooIgnoreController,
	} = options
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Determine which messages to summarize:
	// - If summarizeFromIndex is set, use that range (for full-quality sub-task summarization)
	// - Otherwise, use the default "since last summary" logic
	const messagesToSummarize =
		options.summarizeFromIndex !== undefined
			? messages.slice(options.summarizeFromIndex)
			: getMessagesSinceLastSummary(messages)

	if (messagesToSummarize.length <= 1) {
		const error =
			messages.length <= 1
				? t("common:errors.condense_not_enough_messages")
				: t("common:errors.condensed_recently")
		return { ...response, error }
	}

	// Check if there's a recent summary in the messages (edge case)
	// Skip this check when summarizeFromIndex is set (we intentionally include intermediate summaries)
	if (options.summarizeFromIndex === undefined) {
		const recentSummaryExists = messagesToSummarize.some((message: ApiMessage) => message.isSummary)

		if (recentSummaryExists && messagesToSummarize.length <= 2) {
			const error = t("common:errors.condensed_recently")
			return { ...response, error }
		}
	}

	// Use custom prompt if provided and non-empty, otherwise use the default CONDENSE prompt
	// This respects user's custom condensing prompt setting
	const condenseInstructions = customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: condenseInstructions,
	}

	// Inject synthetic tool_results for orphan tool_calls to prevent API rejections
	// (e.g., when user triggers condense after receiving attempt_completion but before responding)
	const messagesWithToolResults = injectSyntheticToolResults(messagesToSummarize)

	// Transform tool_use and tool_result blocks to text representations.
	// This is necessary because some providers (like Bedrock via LiteLLM) require the `tools` parameter
	// when tool blocks are present. By converting them to text, we can send the conversation for
	// summarization without needing to pass the tools parameter.
	const messagesWithTextToolBlocks = transformMessagesForCondensing(
		maybeRemoveImageBlocks([...messagesWithToolResults, finalRequestMessage], apiHandler),
	)

	const requestMessages = messagesWithTextToolBlocks.map(({ role, content }) => ({ role, content }))

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	const promptToUse = SUMMARY_PROMPT

	// Validate that the API handler supports message creation
	if (!apiHandler || typeof apiHandler.createMessage !== "function") {
		console.error("API handler is invalid for condensing. Cannot proceed.")
		const error = t("common:errors.condense_handler_invalid")
		return { ...response, error }
	}

	let summary = ""
	let cost = 0
	let outputTokens = 0

	try {
		const stream = apiHandler.createMessage(promptToUse, requestMessages, metadata)

		for await (const chunk of stream) {
			if (chunk.type === "text") {
				summary += chunk.text
			} else if (chunk.type === "usage") {
				// Record final usage chunk only
				cost = chunk.totalCost ?? 0
				outputTokens = chunk.outputTokens ?? 0
			}
		}
	} catch (error) {
		console.error("Error during condensing API call:", error)
		const errorMessage = error instanceof Error ? error.message : String(error)

		// Capture detailed error information for debugging
		let errorDetails = ""
		if (error instanceof Error) {
			errorDetails = `Error: ${error.message}`
			// Capture any additional API error properties
			const anyError = error as unknown as Record<string, unknown>
			if (anyError.status) {
				errorDetails += `\n\nHTTP Status: ${anyError.status}`
			}
			if (anyError.code) {
				errorDetails += `\nError Code: ${anyError.code}`
			}
			if (anyError.response) {
				try {
					errorDetails += `\n\nAPI Response:\n${JSON.stringify(anyError.response, null, 2)}`
				} catch {
					errorDetails += `\n\nAPI Response: [Unable to serialize]`
				}
			}
			if (anyError.body) {
				try {
					errorDetails += `\n\nResponse Body:\n${JSON.stringify(anyError.body, null, 2)}`
				} catch {
					errorDetails += `\n\nResponse Body: [Unable to serialize]`
				}
			}
		} else {
			errorDetails = String(error)
		}

		return {
			...response,
			cost,
			error: t("common:errors.condense_api_failed", { message: errorMessage }),
			errorDetails,
		}
	}

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error }
	}

	// Extract command blocks from the first message (original task)
	// These represent active workflows that must persist across condensings
	const firstMessage = messages[0]
	const commandBlocks = firstMessage ? extractCommandBlocks(firstMessage) : ""

	// Build the summary content as separate text blocks
	const headingPrefix = options.subtaskTitle ? `Sub-Task Summary: ${options.subtaskTitle}` : "Conversation Summary"
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## ${headingPrefix}\n${summary}` },
	]

	// Add command blocks (active workflows) in their own system-reminder block if present
	if (commandBlocks) {
		summaryContent.push({
			type: "text",
			text: `<system-reminder>
## Active Workflows
The following directives must be maintained across all future condensings:
${commandBlocks}
</system-reminder>`,
		})
	}

	// Generate and add folded file context (smart code folding) if file paths are provided
	// Each file gets its own <system-reminder> block as a separate content block
	if (filesReadByRoo && filesReadByRoo.length > 0 && cwd) {
		try {
			const foldedResult = await generateFoldedFileContext(filesReadByRoo, {
				cwd,
				rooIgnoreController,
			})
			if (foldedResult.sections.length > 0) {
				for (const section of foldedResult.sections) {
					if (section.trim()) {
						summaryContent.push({
							type: "text",
							text: section,
						})
					}
				}
			}
		} catch (error) {
			console.error("[summarizeConversation] Failed to generate folded file context:", error)
			// Continue without folded context - non-critical failure
		}
	}

	// Add environment details as a separate text block if provided AND this is an automatic trigger.
	// For manual condensing, fresh environment details will be injected on the next turn.
	// For automatic condensing, the API request is already in progress so we need them in the summary.
	if (isAutomaticTrigger && environmentDetails?.trim()) {
		summaryContent.push({
			type: "text",
			text: environmentDetails,
		})
	}

	// Generate a unique condenseId for this summary
	const condenseId = crypto.randomUUID()

	// Use the last message's timestamp + 1 to ensure unique timestamp for summary.
	// The summary goes at the end of all messages.
	const lastMsgTs = messages[messages.length - 1]?.ts ?? Date.now()

	const summaryMessage: ApiMessage = {
		role: "user", // Fresh start model: summary is a user message
		content: summaryContent,
		ts: lastMsgTs + 1, // Unique timestamp after last message
		isSummary: true,
		condenseId, // Unique ID for this summary, used to track which messages it replaces
	}

	// NON-DESTRUCTIVE CONDENSE (Multi-Summary Model):
	// Tag only messages SINCE THE LAST SUMMARY with condenseParent.
	// Previous summaries are preserved so the model can see all sub-task summaries.
	//
	// Storage structure after condense:
	// [prev_summary_1, msg_a(parent=X), msg_b(parent=X), ..., new_summary(id=X)]
	//
	// Effective for API (filtered by getEffectiveApiHistory):
	// [prev_summary_1, new_summary]  ← All summaries visible!

	// Determine the tagging boundary:
	// - If summarizeFromIndex is set, tag from that index (including intermediate summaries)
	// - Otherwise, tag from the last summary + 1 (preserving previous summaries)
	let tagStartIndex: number
	if (options.summarizeFromIndex !== undefined) {
		tagStartIndex = options.summarizeFromIndex
	} else {
		let lastSummaryIdx = -1
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].isSummary) {
				lastSummaryIdx = i
				break
			}
		}
		tagStartIndex = lastSummaryIdx >= 0 ? lastSummaryIdx + 1 : 0
	}

	// Tag messages from tagStartIndex onward with condenseParent.
	// When summarizeFromIndex is set, intermediate summaries within the range are also tagged
	// (they get replaced by the new comprehensive summary).
	const newMessages = messages.map((msg, index) => {
		if (index < tagStartIndex) {
			return msg
		}
		// When using default boundary, skip already-tagged messages and summary messages
		if (options.summarizeFromIndex === undefined && (msg.condenseParent || msg.isSummary)) {
			return msg
		}
		// When using summarizeFromIndex, skip already-tagged messages (but DO tag intermediate summaries)
		if (options.summarizeFromIndex !== undefined && msg.condenseParent) {
			return msg
		}
		return { ...msg, condenseParent: condenseId }
	})

	// Append the summary message at the end
	newMessages.push(summaryMessage)

	// Count the tokens in the context for the next API request
	// After condense, the context will contain: system prompt + summary + tool definitions
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	// Count actual summaryMessage content directly instead of using outputTokens as a proxy
	// This ensures we account for wrapper text (## Conversation Summary, <system-reminder>, <environment_details>)
	const contextBlocks = [systemPromptMessage, summaryMessage].flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	const messageTokens = await apiHandler.countTokens(contextBlocks)

	// Count tool definition tokens if tools are provided
	let toolTokens = 0
	if (metadata?.tools && metadata.tools.length > 0) {
		const toolsText = JSON.stringify(metadata.tools)
		toolTokens = await apiHandler.countTokens([{ text: toolsText, type: "text" }])
	}

	const newContextTokens = messageTokens + toolTokens
	return { messages: newMessages, summary, cost, newContextTokens, condenseId }
}

/**
 * Generates a global summary Q by merging multiple sub-task summaries via LLM.
 *
 * @param summaries - Array of {title, summary} for each completed sub-task
 * @param apiHandler - The API handler for LLM calls
 * @returns The merged global summary text, or null if generation fails
 */
export async function generateGlobalSummaryText(
	summaries: Array<{ title: string; summary: string }>,
	apiHandler: ApiHandler,
): Promise<{ text: string; cost: number } | null> {
	if (summaries.length === 0) {
		return null
	}

	// Single summary: just return it directly (no LLM call needed)
	if (summaries.length === 1) {
		return { text: summaries[0].summary, cost: 0 }
	}

	const formattedSummaries = summaries.map((s, i) => `### Sub-Task ${i + 1}: ${s.title}\n${s.summary}`).join("\n\n")

	const mergePrompt = `Below are summaries of completed sub-tasks in chronological order.
Merge them into a single comprehensive global summary that captures:
1. The overall progress and key decisions made
2. Important technical details, patterns, and architecture decisions
3. Current state of the work and what has been accomplished
4. Key files that were modified or created

Sub-Task Summaries:
${formattedSummaries}

Generate a concise but comprehensive global summary. Do NOT use headers or bullet points for the top level - write flowing prose with technical details. Keep it under 2000 words.`

	const requestMessages: Anthropic.MessageParam[] = [{ role: "user", content: mergePrompt }]

	const systemPrompt =
		"You are a technical summarizer. Merge the provided sub-task summaries into one comprehensive global summary that preserves all important context for continuing the work."

	try {
		let text = ""
		let cost = 0

		const stream = apiHandler.createMessage(systemPrompt, requestMessages)

		for await (const chunk of stream) {
			if (chunk.type === "text") {
				text += chunk.text
			} else if (chunk.type === "usage") {
				cost = chunk.totalCost ?? 0
			}
		}

		text = text.trim()
		if (text.length === 0) {
			return null
		}

		return { text, cost }
	} catch (error) {
		console.error("[generateGlobalSummaryText] Failed to generate global summary:", error)
		return null
	}
}

/**
 * Auto-updates the Global Summary Q after auto-condense creates a new summary.
 * Called automatically by manageContext after summarizeConversation succeeds.
 *
 * - If only 1 visible summary: promotes it to Global Q (no LLM call)
 * - If 2+ visible summaries: merges them into a new Global Q via LLM
 *
 * The LLM merge call uses minimal context: only a merge instruction and summary texts.
 *
 * @param messages - The messages after summarizeConversation has run
 * @param apiHandler - The API handler for LLM calls
 * @returns Updated messages with Global Q, and additional cost
 */
export async function autoUpdateGlobalSummary(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
): Promise<{ messages: ApiMessage[]; cost: number }> {
	// Build ID sets matching getEffectiveApiHistory logic
	const existingSummaryIds = new Set<string>()
	const summaryPositions = new Map<string, number>()
	const existingTruncationIds = new Set<string>()

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
			summaryPositions.set(msg.condenseId, i)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Find visible summaries using the same logic as getEffectiveApiHistory
	const visibleSummaries: Array<{ index: number; msg: ApiMessage }> = []
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (!msg.isSummary) continue
		// Hidden by condenseParent?
		if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
			const parentPos = summaryPositions.get(msg.condenseParent)
			if (parentPos !== undefined && i < parentPos) {
				continue
			}
		}
		// Hidden by truncationParent?
		if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
			continue
		}
		visibleSummaries.push({ index: i, msg })
	}

	if (visibleSummaries.length === 0) {
		return { messages, cost: 0 }
	}

	// Case 1: Single visible summary → promote to Global Q (no LLM call)
	if (visibleSummaries.length === 1) {
		const { index, msg } = visibleSummaries[0]
		if (msg.isGlobalSummary) {
			return { messages, cost: 0 } // already a Global Q
		}
		const updated = [...messages]
		const cloned: ApiMessage = { ...msg, isGlobalSummary: true }
		// Update heading in content
		if (Array.isArray(cloned.content)) {
			const content = [...(cloned.content as Anthropic.Messages.ContentBlockParam[])]
			if (content.length > 0 && content[0].type === "text") {
				const tb = content[0] as Anthropic.Messages.TextBlockParam
				content[0] = {
					type: "text",
					text: tb.text.replace(
						/^## (Conversation Summary|Sub-Task Summary:[^\n]*)/,
						"## Global Task Summary",
					),
				}
			}
			cloned.content = content
		}
		updated[index] = cloned
		return { messages: updated, cost: 0 }
	}

	// Case 2: 2+ visible summaries → merge into new Global Q via LLM
	const summaryInputs: Array<{ title: string; summary: string }> = visibleSummaries.map(({ msg }, i) => {
		let text = ""
		if (Array.isArray(msg.content)) {
			const blocks = msg.content as Anthropic.Messages.ContentBlockParam[]
			const firstTextBlock = blocks.find((b): b is Anthropic.Messages.TextBlockParam => b.type === "text")
			text = firstTextBlock?.text ?? ""
		} else if (typeof msg.content === "string") {
			text = msg.content
		}
		const headingMatch = text.match(/^## (?:Global Task Summary|Conversation Summary|Sub-Task Summary: ([^\n]*))\n/)
		const title = headingMatch?.[1] || `Summary ${i + 1}`
		const cleanText = text.replace(/^## [^\n]*\n/, "").trim()
		return { title, summary: cleanText }
	})

	const globalResult = await generateGlobalSummaryText(summaryInputs, apiHandler)
	if (!globalResult) {
		return { messages, cost: 0 }
	}

	const newQId = crypto.randomUUID()
	const lastTs = messages[messages.length - 1]?.ts ?? Date.now()

	// Preserve auxiliary content blocks (command, folded files, env) from the latest summary
	const latestSummary = visibleSummaries[visibleSummaries.length - 1].msg
	const auxiliaryBlocks: Anthropic.Messages.ContentBlockParam[] = []
	if (Array.isArray(latestSummary.content)) {
		const blocks = latestSummary.content as Anthropic.Messages.ContentBlockParam[]
		let skippedFirst = false
		for (const block of blocks) {
			if (!skippedFirst && block.type === "text") {
				skippedFirst = true
				continue
			}
			auxiliaryBlocks.push(block)
		}
	}

	// Tag all visible summaries with new Q's condenseId
	const visibleIndices = new Set(visibleSummaries.map((vs) => vs.index))
	const updatedMessages = messages.map((msg, index) => {
		if (visibleIndices.has(index)) {
			return { ...msg, condenseParent: newQId }
		}
		return msg
	})

	// Append new Global Q
	const qContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Global Task Summary\n${globalResult.text}` },
		...auxiliaryBlocks,
	]
	const qMessage: ApiMessage = {
		role: "user",
		content: qContent,
		ts: lastTs + 1,
		isSummary: true,
		isGlobalSummary: true,
		condenseId: newQId,
	}
	updatedMessages.push(qMessage)

	return { messages: updatedMessages, cost: globalResult.cost }
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 *
 * Note: Summary messages are always created with role: "user" (fresh-start model),
 * so the first message since the last summary is guaranteed to be a user message.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	return messages.slice(lastSummaryIndex)
}

/**
 * Filters the API conversation history to get the "effective" messages to send to the API.
 *
 * Fresh Start Model:
 * - When a summary exists, return only messages from the summary onwards (fresh start)
 * - Messages with a condenseParent pointing to an existing summary are filtered out
 *
 * Messages with a truncationParent that points to an existing truncation marker are also filtered out,
 * as they have been hidden by sliding window truncation.
 *
 * This allows non-destructive condensing and truncation where messages are tagged but not deleted,
 * enabling accurate rewind operations while still sending condensed/truncated history to the API.
 *
 * @param messages - The full API conversation history including tagged messages
 * @returns The filtered history that should be sent to the API
 */
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
	// Multi-Summary Model: keep ALL summary messages visible, filter out condensed/truncated messages.
	// This supports task_memory sub-task condensing where each sub-task gets its own summary
	// and the model sees: [summary_1, summary_2, ..., summary_N, current_raw_messages]
	//
	// Backward compatible with old "Fresh Start" data: if old condensation tagged ALL messages
	// (including previous summaries) with condenseParent, those summaries are correctly hidden
	// because their condenseParent points to a newer summary that exists.

	// Collect all condenseIds of summaries that exist in the current history, and their positions
	const existingSummaryIds = new Set<string>()
	const summaryPositions = new Map<string, number>()
	// Collect all truncationIds of truncation markers that exist in the current history
	const existingTruncationIds = new Set<string>()

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
			summaryPositions.set(msg.condenseId, i)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Filter out messages whose condenseParent points to an existing summary
	// AND that appear BEFORE their summary in the array (position-aware).
	// Messages AFTER their summary are kept for backward compatibility with old data
	// where ALL messages were tagged with condenseParent (including post-summary ones).
	// Messages with orphaned parents (summary/marker was deleted) are included (rewind support).
	let effective = messages.filter((msg, index) => {
		// Filter out condensed messages if their summary exists AND message is before the summary
		if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
			const summaryPos = summaryPositions.get(msg.condenseParent)
			if (summaryPos !== undefined && index < summaryPos) {
				return false
			}
			// Message is after its summary → keep (backward compat with old tagging)
		}
		// Filter out truncated messages if their truncation marker exists
		if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
			return false
		}
		return true
	})

	// Handle orphan tool_result blocks: tool_use was condensed away but tool_result remains.
	// Collect all tool_use IDs from assistant messages in the effective set.
	const toolUseIds = new Set<string>()
	for (const msg of effective) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && (block as Anthropic.Messages.ToolUseBlockParam).id) {
					toolUseIds.add((block as Anthropic.Messages.ToolUseBlockParam).id)
				}
			}
		}
	}

	// Filter out orphan tool_result blocks from user messages
	effective = effective
		.map((msg) => {
			if (msg.role === "user" && Array.isArray(msg.content)) {
				const filteredContent = msg.content.filter((block) => {
					if (block.type === "tool_result") {
						return toolUseIds.has((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id)
					}
					return true
				})
				// If all content was filtered out, mark for removal
				if (filteredContent.length === 0) {
					return null
				}
				// If some content was filtered, return updated message
				if (filteredContent.length !== msg.content.length) {
					return { ...msg, content: filteredContent }
				}
			}
			return msg
		})
		.filter((msg): msg is ApiMessage => msg !== null)

	return effective
}

/**
 * Cleans up orphaned condenseParent and truncationParent references after a truncation operation (rewind/delete).
 * When a summary message or truncation marker is deleted, messages that were tagged with its ID
 * should have their parent reference cleared so they become active again.
 *
 * This function should be called after any operation that truncates the API history
 * to ensure messages are properly restored when their summary or truncation marker is deleted.
 *
 * @param messages - The API conversation history after truncation
 * @returns The cleaned history with orphaned condenseParent and truncationParent fields cleared
 */
export function cleanupAfterTruncation(messages: ApiMessage[]): ApiMessage[] {
	// Collect all condenseIds of summaries that still exist
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that still exist
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Clear orphaned parent references for messages whose summary or truncation marker was deleted
	return messages.map((msg) => {
		let needsUpdate = false

		// Check for orphaned condenseParent
		if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
			needsUpdate = true
		}

		// Check for orphaned truncationParent
		if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
			needsUpdate = true
		}

		if (needsUpdate) {
			// Create a new object without orphaned parent references
			const { condenseParent, truncationParent, ...rest } = msg
			const result: ApiMessage = rest as ApiMessage

			// Keep condenseParent if its summary still exists
			if (condenseParent && existingSummaryIds.has(condenseParent)) {
				result.condenseParent = condenseParent
			}

			// Keep truncationParent if its truncation marker still exists
			if (truncationParent && existingTruncationIds.has(truncationParent)) {
				result.truncationParent = truncationParent
			}

			return result
		}
		return msg
	})
}
