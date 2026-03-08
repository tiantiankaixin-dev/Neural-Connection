/**
 * Todo Context Generator
 *
 * When the AI creates a new todo list while an old one already exists (todo list transition),
 * this module uses the condensing/summary model to compress the old task's conversation
 * messages into an optimal context summary for the new task.
 *
 * Flow:
 * 1. Collect all messages from apiConversationHistory (the old task's conversation)
 * 2. Count tokens per message block using tiktoken
 * 3. Greedily pack whole message blocks into batches that fit the model's context window
 * 4. Call the summary model for each batch to produce partial summaries
 * 5. Concatenate partial summaries and inject as a context summary message pair
 * 6. Replace OLD messages with the summary pair, preserving the current request's messages
 */

import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler } from "../../api"
import { tiktoken } from "../../utils/tiktoken"
import { type ApiMessage } from "../task-persistence/apiMessages"
import type { Task } from "../task/Task"
import type { TodoItem } from "@roo-code/types"

// Reserve tokens for: system prompt + todo list description + output buffer
const RESERVED_TOKENS = 3000
// Fallback context window size if model info is unavailable
const DEFAULT_CONTEXT_WINDOW = 32_000

const SYSTEM_PROMPT = `你是一个上下文分析助手。你会收到一段之前任务的对话消息和一个新的任务列表。
请从对话消息中提取与新任务最相关的信息，包括：
- 项目结构和关键文件路径
- 已做出的技术决策和架构选择
- 已完成的工作和当前状态
- 遇到的问题和解决方案
- 与新任务直接相关的代码片段和上下文

输出格式：简洁的结构化上下文总结，方便 AI 快速理解项目现状并开始新任务。
不要输出多余的解释，直接给出总结内容。`

/**
 * Extract text content from an ApiMessage for display purposes.
 */
function extractMessageText(msg: ApiMessage): string {
	const content = msg.content
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((block: any) => {
				if (block.type === "text") return block.text || ""
				if (block.type === "tool_use") return `[Tool: ${block.name}]`
				if (block.type === "tool_result") {
					const resultContent = block.content
					if (typeof resultContent === "string") return resultContent
					if (Array.isArray(resultContent)) {
						return resultContent
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text || "")
							.join("\n")
					}
					return "[tool_result]"
				}
				return ""
			})
			.filter(Boolean)
			.join("\n")
	}
	return String(content)
}

/**
 * Count tokens for a single ApiMessage using tiktoken.
 */
async function countMessageTokens(msg: ApiMessage): Promise<number> {
	const content = msg.content
	if (typeof content === "string") {
		return tiktoken([{ type: "text", text: content }])
	}
	if (Array.isArray(content)) {
		return tiktoken(content as Anthropic.Messages.ContentBlockParam[])
	}
	return tiktoken([{ type: "text", text: String(content) }])
}

/**
 * Format the todo list as a readable string for the summary prompt.
 */
function formatTodoList(todos: TodoItem[]): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return `${box} ${t.content}`
		})
		.join("\n")
}

/**
 * Call the summary model and collect the full text response.
 */
async function callSummaryModel(apiHandler: ApiHandler, systemPrompt: string, userMessage: string): Promise<string> {
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
 * Pack messages into batches where each batch fits within the given token capacity.
 * Messages are kept whole — never split mid-block.
 *
 * Example: capacity=50, blocks=[45, 2, 4] → batch1=[0,1] (47 tokens), batch2=[2] (4 tokens)
 */
function packIntoBatches(messages: ApiMessage[], tokenCounts: number[], capacity: number): number[][] {
	const batches: number[][] = []
	let currentBatch: number[] = []
	let currentSize = 0

	for (let i = 0; i < messages.length; i++) {
		const blockTokens = tokenCounts[i]

		// If adding this block would exceed capacity and we already have items, start a new batch
		if (currentSize + blockTokens > capacity && currentBatch.length > 0) {
			batches.push(currentBatch)
			currentBatch = []
			currentSize = 0
		}

		currentBatch.push(i)
		currentSize += blockTokens
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch)
	}

	return batches
}

/**
 * Find the boundary index where the user's current (new) request starts.
 * Everything before this index belongs to the old task and should be compressed.
 * Everything from this index onward is the current conversation turn and must be preserved.
 *
 * Walks backwards to find the last user message with real text content
 * (not just tool_result blocks or auto-injected environment_details).
 */
function findPreserveBoundary(messages: ApiMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.role !== "user") continue

		const content = msg.content
		if (typeof content === "string" && content.trim().length > 0) {
			return i
		}
		if (Array.isArray(content)) {
			const hasUserText = content.some((block: any) => {
				if (block.type !== "text") return false
				const text = block.text?.trim() || ""
				// environment_details is auto-injected, not real user content
				if (text.startsWith("<environment_details>")) return false
				return text.length > 0
			})
			if (hasUserText) return i
		}
	}
	// No real user message found — don't compress anything
	return messages.length
}

/**
 * Generate context summary for a todo list transition.
 *
 * Called when update_todo_list detects that a previous todo list already existed.
 * Compresses the old task's conversation into a concise context for the new task,
 * while preserving the current request's messages so the AI doesn't lose context.
 *
 * @param task - The current Task instance
 * @param newTodos - The new todo list items
 */
export async function generateTodoTransitionContext(task: Task, newTodos: TodoItem[]): Promise<void> {
	const allMessages = task.apiConversationHistory
	if (!allMessages || allMessages.length === 0) {
		console.log("[TodoContextGen] No old messages to summarize, skipping")
		return
	}

	// Find boundary: preserve messages from the current request onward
	const preserveBoundary = findPreserveBoundary(allMessages)
	const messagesToCompress = allMessages.slice(0, preserveBoundary)
	const messagesToPreserve = allMessages.slice(preserveBoundary)

	if (messagesToCompress.length === 0) {
		console.log("[TodoContextGen] No old messages to compress (all belong to current request), skipping")
		return
	}

	console.log(
		`[TodoContextGen] Will compress ${messagesToCompress.length} old messages, preserve ${messagesToPreserve.length} current messages`,
	)

	// Get the condensing API handler
	const apiHandler = await task.getCondensingApiHandler()

	// Determine model context window
	let contextWindow = DEFAULT_CONTEXT_WINDOW
	try {
		const modelInfo = apiHandler.getModel().info
		if (modelInfo && typeof (modelInfo as any).contextWindow === "number") {
			contextWindow = (modelInfo as any).contextWindow
		}
	} catch {
		// Use default
	}

	const availableCapacity = contextWindow - RESERVED_TOKENS
	if (availableCapacity <= 0) {
		console.warn("[TodoContextGen] Context window too small, skipping")
		return
	}

	// Count tokens for each message to compress
	const tokenCounts: number[] = []
	for (const msg of messagesToCompress) {
		const count = await countMessageTokens(msg)
		tokenCounts.push(count)
	}

	const totalTokens = tokenCounts.reduce((sum, c) => sum + c, 0)
	console.log(
		`[TodoContextGen] ${messagesToCompress.length} messages to compress, ${totalTokens} total tokens, capacity=${availableCapacity}`,
	)

	// Pack messages into batches
	const batches = packIntoBatches(messagesToCompress, tokenCounts, availableCapacity)
	console.log(`[TodoContextGen] Split into ${batches.length} batch(es)`)

	// Format the new todo list
	const todoListText = formatTodoList(newTodos)

	// Process each batch
	const partialSummaries: string[] = []
	for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
		const batchIndices = batches[batchIdx]
		const batchMessages = batchIndices.map((i) => messagesToCompress[i])

		// Build the message content for this batch
		const messageTexts = batchMessages.map((msg, localIdx) => {
			const globalIdx = batchIndices[localIdx]
			const role = msg.role === "assistant" ? "Assistant" : "User"
			const text = extractMessageText(msg)
			return `[Message ${globalIdx + 1}] (${role}):\n${text}`
		})

		const batchLabel = batches.length > 1 ? ` (batch ${batchIdx + 1}/${batches.length})` : ""

		const userMessage = `## 之前任务的对话消息${batchLabel}\n\n${messageTexts.join("\n\n---\n\n")}\n\n## 新任务列表\n\n${todoListText}`

		try {
			const summary = await callSummaryModel(apiHandler, SYSTEM_PROMPT, userMessage)
			if (summary) {
				partialSummaries.push(summary)
			}
		} catch (err) {
			console.warn(`[TodoContextGen] Batch ${batchIdx + 1} failed:`, err)
		}
	}

	if (partialSummaries.length === 0) {
		console.warn("[TodoContextGen] All batches failed, no context generated")
		return
	}

	// Combine partial summaries
	const finalSummary =
		partialSummaries.length === 1
			? partialSummaries[0]
			: partialSummaries.map((s, i) => `### Part ${i + 1}\n\n${s}`).join("\n\n")

	// Generate a unique condenseId for the context summary
	const condenseId = `ctx_${crypto.randomUUID().slice(0, 8)}`

	// Build the new history: summary replaces old messages, current request is preserved
	const summaryUserMessage: ApiMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: `<context_summary source="previous_task">\n${finalSummary}\n</context_summary>`,
			},
		],
		ts: Date.now(),
		isSummary: true,
		condenseId,
		isContextSummary: true,
	}

	const summaryAssistantMessage: ApiMessage = {
		role: "assistant",
		content: [
			{
				type: "text",
				text: "I have reviewed the previous task context and the new task list. I'm ready to proceed with the new tasks.",
			},
		],
		ts: Date.now(),
		isContextSummary: true,
	}

	// Replace old messages with summary, then append preserved current-request messages
	await task.overwriteApiConversationHistory([summaryUserMessage, summaryAssistantMessage, ...messagesToPreserve])

	// Reset boundaries since old messages are gone
	task.todoItemBoundaries.clear()

	console.log(`[TodoContextGen] Context generated: ${finalSummary.length} chars from ${batches.length} batch(es)`)
}
