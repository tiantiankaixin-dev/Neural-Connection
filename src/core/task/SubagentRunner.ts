/**
 * SubagentRunner — lightweight parallel execution unit for a single todo item.
 *
 * After the refine phase completes (all plans written), the parent Task spawns
 * one SubagentRunner per todo item. Each runner:
 *   1. Builds an isolated conversation context from the todo item's plan.
 *   2. Makes streaming API calls using the parent's ApiHandler.
 *   3. Executes tool calls via the parent Task's executeToolForSubagent().
 *   4. Pushes ClineMessages to the parent, tagged with `subagentId`.
 *
 * All runners execute concurrently, producing parallel UI boxes in the webview.
 */

import { Anthropic } from "@anthropic-ai/sdk"
import * as fs from "fs/promises"
import * as path from "path"
import { buildApiHandler, type ApiHandler, type ApiHandlerCreateMessageMetadata } from "../../api"
import type { ClineApiReqInfo, ClineMessage, ClineSay, TodoItem, ToolName } from "@roo-code/types"
import { parsePlanTargetHeader, type PlanFile } from "../task-persistence/plan-persistence"
import type { ToolUse } from "../../shared/tools"
import type { Task } from "./Task"
import { ContextInspectorPanel } from "../webview/ContextInspectorPanel"

const MAX_CONSECUTIVE_SUBAGENT_API_ERRORS = 2
const MAX_SUBAGENT_BROAD_EXPLORATION_TOOL_CALLS = 2
const MAX_SUBAGENT_READ_INSPECTION_TOOL_CALLS = 8
const ROOCODE_BASE_SYSTEM_PROMPT_MARKERS = [
	"You are Roo,",
	"TOOL USE",
	"TOOL USE GUIDELINES",
	"CAPABILITIES",
	"SYSTEM INFORMATION",
	"OBJECTIVE",
	"You accomplish a given task iteratively",
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentConfig {
	/** The parent Task instance that owns this subagent. */
	parentTask: Task
	/** The todo item this subagent is responsible for. */
	todoItem: TodoItem
	/** Pre-built plan files for this todo item (loaded from disk). */
	planFiles: PlanFile[]
	/** The system prompt to use for this subagent (build mode). */
	systemPrompt: string
	/** The set of tools available to this subagent. */
	tools: import("openai").default.Chat.ChatCompletionTool[]
}

export interface SubagentResult {
	todoItemId: string
	success: boolean
	completionResult?: string
	error?: string
}

type WorkspaceMemoryEntry = {
	title?: string
	content?: string
	tags?: string[]
}

type WorkspaceMemoryStore = {
	memories?: WorkspaceMemoryEntry[]
}

// ---------------------------------------------------------------------------
// SubagentRunner
// ---------------------------------------------------------------------------

export class SubagentRunner {
	readonly subagentId: string
	readonly todoItem: TodoItem

	private parentTask: Task
	private api: ApiHandler
	private systemPrompt: string
	private tools: import("openai").default.Chat.ChatCompletionTool[]
	private planFiles: PlanFile[]
	private memoryContext?: string
	private completedWriteTargets = new Set<string>()
	private repeatedReadToolCalls = new Map<string, number>()
	private broadExplorationToolCallCount = 0
	private readInspectionToolCallCount = 0
	private generatedToolUseIdCounter = 0
	private consecutiveApiErrors = 0

	/** Isolated conversation history for this subagent. */
	private apiConversationHistory: Anthropic.Messages.MessageParam[] = []

	/** Set to true when the runner should stop. */
	abort = false

	constructor(config: SubagentConfig) {
		this.subagentId = config.todoItem.id ?? `subagent-${Date.now()}`
		this.todoItem = config.todoItem
		this.parentTask = config.parentTask
		this.api = buildApiHandler(config.parentTask.apiConfiguration)
		this.assertDetachedSystemPrompt(config.systemPrompt)
		this.systemPrompt = config.systemPrompt
		this.tools = config.tools
		this.planFiles = config.planFiles
	}

	private assertDetachedSystemPrompt(systemPrompt: string): void {
		const matchedMarker = ROOCODE_BASE_SYSTEM_PROMPT_MARKERS.find((marker) => systemPrompt.includes(marker))
		if (matchedMarker) {
			throw new Error(
				`Subagent system prompt must stay detached from RooCode base SYSTEM_PROMPT while detached mode is active. Matched marker: ${matchedMarker}`,
			)
		}
	}

	private logDebug(event: string, details: Record<string, unknown> = {}): void {
		console.log(`[SubagentRunner] ${event}`, {
			subagentId: this.subagentId,
			todoItemId: this.todoItem.id,
			...details,
		})
	}

	private hasRefineMarkers(text: string): boolean {
		return (
			text.includes("Plan mode ACTIVE") || text.includes("write_todo_plan") || text.includes("update_todo_list")
		)
	}

	private summarizeMessageContent(content: Anthropic.Messages.MessageParam["content"]): Record<string, unknown> {
		if (typeof content === "string") {
			return { textPreview: content.slice(0, 240) }
		}

		const partTypes = content.map((part) => (part as { type?: string }).type ?? "unknown")
		const preview = content
			.map((part) => {
				const block = part as unknown as Record<string, unknown>
				const type = typeof block.type === "string" ? block.type : "unknown"
				if (type === "text") {
					return `text:${String(block.text ?? "").slice(0, 120)}`
				}
				if (type === "tool_use") {
					return `tool_use:${String(block.name ?? "")}`
				}
				if (type === "tool_result") {
					const rawContent = block.content
					const resultText =
						typeof rawContent === "string"
							? rawContent
							: Array.isArray(rawContent)
								? rawContent
										.map((item) => {
											const entry = item as unknown as Record<string, unknown>
											return entry.type === "text" ? String(entry.text ?? "") : ""
										})
										.join("\n")
								: ""
					return `tool_result:${String(block.tool_use_id ?? "")}:${resultText.slice(0, 120)}`
				}
				if (type === "image") {
					return "image"
				}
				return type
			})
			.join(" | ")

		return {
			partTypes,
			preview: preview.slice(0, 400),
		}
	}

	private summarizeHistory(messages: Anthropic.Messages.MessageParam[]): Array<Record<string, unknown>> {
		const startIndex = Math.max(0, messages.length - 6)
		return messages.slice(startIndex).map((message, offset) => ({
			index: startIndex + offset,
			role: message.role,
			...this.summarizeMessageContent(message.content),
		}))
	}

	private summarizeToolCalls(toolCalls: ToolUse[]): Array<Record<string, unknown>> {
		return toolCalls.map((toolCall) => ({
			id: toolCall.id,
			name: toolCall.name,
			params: toolCall.params,
		}))
	}

	private normalizePathForProgress(filePath: string): string {
		return filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
	}

	private isPathMatchingRequiredTarget(filePath: string, target: string): boolean {
		const normalizedPath = this.normalizePathForProgress(filePath)
		const normalizedTarget = this.normalizePathForProgress(target)
		return normalizedPath === normalizedTarget || normalizedPath.endsWith(`/${normalizedTarget}`)
	}

	private getRequiredWriteTargets(): string[] {
		const targets: string[] = []
		const seen = new Set<string>()
		for (const plan of this.planFiles) {
			const parsed = parsePlanTargetHeader(plan.content)
			if (parsed?.action === "GENERAL" || parsed?.action === "DELETE") {
				continue
			}

			const target = (parsed?.path ?? plan.filePath).trim().replace(/\\/g, "/")
			const normalized = this.normalizePathForProgress(target)
			if (target && !seen.has(normalized)) {
				seen.add(normalized)
				targets.push(target)
			}
		}
		return targets
	}

	private markWriteTargetCompleted(filePath: string): boolean {
		let didMatchTarget = false
		for (const target of this.getRequiredWriteTargets()) {
			if (this.isPathMatchingRequiredTarget(filePath, target)) {
				didMatchTarget = true
				const normalized = this.normalizePathForProgress(target)
				if (!this.completedWriteTargets.has(normalized)) {
					this.completedWriteTargets.add(normalized)
				}
			}
		}
		return didMatchTarget
	}

	private buildContinuationContent(lines: string[]): Anthropic.Messages.TextBlockParam[] {
		const content = lines
			.map((line) => line.trim())
			.filter(Boolean)
			.join("\n\n")
		return content ? [{ type: "text" as const, text: content }] : []
	}

	private async prepareConversationForRequest(toolResults: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		if (this.apiConversationHistory.length === 0) {
			this.apiConversationHistory.push({ role: "user", content: await this.buildInitialMessage() })
			return
		}

		if (toolResults.length > 0) {
			this.apiConversationHistory.push({ role: "user", content: toolResults })
		}
	}

	private appendAssistantMessage(assistantMessage: string, toolCalls: ToolUse[]): void {
		const content: Anthropic.Messages.ContentBlockParam[] = []
		const text = assistantMessage.trim()
		if (text) {
			content.push({ type: "text" as const, text })
		}

		for (const toolCall of toolCalls) {
			const toolUseId = this.ensureToolUseId(toolCall)
			content.push({
				type: "tool_use",
				id: toolUseId,
				name: toolCall.name,
				input: toolCall.params || {},
			} as Anthropic.Messages.ToolUseBlockParam)
		}

		if (content.length > 0) {
			this.apiConversationHistory.push({ role: "assistant", content })
		}
	}

	private ensureToolUseId(toolCall: ToolUse): string {
		const existingId = toolCall.id?.trim()
		if (existingId) {
			return existingId
		}

		const generatedId = `tool-${this.subagentId}-${++this.generatedToolUseIdCounter}`
		toolCall.id = generatedId
		return generatedId
	}

	private buildToolResultBlock(
		toolUseId: string,
		content: string,
		isError = false,
	): Anthropic.Messages.ToolResultBlockParam {
		return {
			type: "tool_result",
			tool_use_id: toolUseId,
			content,
			is_error: isError,
		}
	}

	private isReadInspectionTool(toolName: string): boolean {
		return [
			"list_files",
			"find_by_name",
			"search_files",
			"codebase_search",
			"read_file",
			"read_notebook",
			"read_command_output",
		].includes(toolName)
	}

	private isBroadExplorationTool(toolName: string): boolean {
		return ["list_files", "find_by_name", "search_files", "codebase_search"].includes(toolName)
	}

	private normalizeToolParams(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map((item) => this.normalizeToolParams(item))
		}
		if (!value || typeof value !== "object") {
			return value
		}

		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nestedValue]) => [key, this.normalizeToolParams(nestedValue)]),
		)
	}

	private recordReadInspectionToolCall(toolName: string, toolParams: Record<string, unknown>): number {
		const signature = `${toolName}:${JSON.stringify(this.normalizeToolParams(toolParams))}`
		const count = (this.repeatedReadToolCalls.get(signature) ?? 0) + 1
		this.repeatedReadToolCalls.set(signature, count)
		return count
	}

	private getReadInspectionBlockReason(toolName: string, toolParams: Record<string, unknown>): string | undefined {
		if (!this.isReadInspectionTool(toolName)) {
			return undefined
		}

		if (toolName === "list_files") {
			return (
				`Directory listing is disabled for subagent execution. ` +
				`You are a child execution subagent; the parent agent already scoped the task. ` +
				`Use the assigned refined todo item, relevant memories, and targeted read/search/edit tools to proceed directly.`
			)
		}

		this.readInspectionToolCallCount++
		if (this.isBroadExplorationTool(toolName)) {
			this.broadExplorationToolCallCount++
		}

		const repeatedReadCount = this.recordReadInspectionToolCall(toolName, toolParams)
		if (repeatedReadCount > 1) {
			return (
				`Repeated read/search tool call blocked for "${toolName}" with identical parameters. ` +
				`Use the result already present in this subagent conversation history and proceed with the assigned refined todo item.`
			)
		}

		if (this.broadExplorationToolCallCount > MAX_SUBAGENT_BROAD_EXPLORATION_TOOL_CALLS) {
			return (
				`Broad exploration budget exceeded after ${MAX_SUBAGENT_BROAD_EXPLORATION_TOOL_CALLS} directory/search calls. ` +
				`Stop exploring folders and proceed with targeted file edits for the assigned refined todo item.`
			)
		}

		if (this.readInspectionToolCallCount > MAX_SUBAGENT_READ_INSPECTION_TOOL_CALLS) {
			return (
				`Read/search budget exceeded after ${MAX_SUBAGENT_READ_INSPECTION_TOOL_CALLS} inspection calls. ` +
				`Stop reading more context and proceed with implementation or attempt_completion.`
			)
		}

		return undefined
	}

	private noteTurnWriteProgress(didWriteRequiredTarget: boolean, didAttemptWrite = false): void {
		void didWriteRequiredTarget
		void didAttemptWrite
	}

	private isEditTool(toolName: string): boolean {
		return [
			"write_to_file",
			"apply_diff",
			"apply_patch",
			"edit",
			"edit_notebook",
			"search_and_replace",
			"search_replace",
			"insert_content",
			"edit_file",
			"multi_edit",
		].includes(toolName)
	}

	private getEditToolPaths(toolName: string, toolParams: Record<string, unknown>): string[] {
		if (toolName === "apply_patch" && typeof toolParams.patch === "string") {
			const paths: string[] = []
			const markers = ["*** Add File: ", "*** Delete File: ", "*** Update File: ", "*** Move to: "]
			for (const rawLine of toolParams.patch.split("\n")) {
				const line = rawLine.trim()
				for (const marker of markers) {
					if (line.startsWith(marker)) {
						const filePath = line.substring(marker.length).trim()
						if (filePath) {
							paths.push(filePath)
						}
					}
				}
			}
			return Array.from(new Set(paths))
		}
		if (toolName === "edit_notebook") {
			return typeof toolParams.absolute_path === "string" ? [toolParams.absolute_path] : []
		}
		if (["search_replace", "edit_file", "multi_edit"].includes(toolName)) {
			return typeof toolParams.file_path === "string" ? [toolParams.file_path] : []
		}
		return typeof toolParams.path === "string" ? [toolParams.path] : []
	}

	private getRequestTools(): import("openai").default.Chat.ChatCompletionTool[] {
		return this.tools
	}

	private getRequestToolChoice(): ApiHandlerCreateMessageMetadata["tool_choice"] {
		return "auto"
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	async run(): Promise<SubagentResult> {
		try {
			// 1. Build initial user message from plan
			const initialMessage = await this.buildInitialMessage()
			this.logDebug("start", {
				planFiles: this.planFiles.map((file) => file.filePath),
				systemPromptHasRefineMarkers: this.hasRefineMarkers(this.systemPrompt),
				systemPromptPreview: this.systemPrompt.slice(0, 320),
				initialMessagePreview: initialMessage
					.map((block) => block.text)
					.join("\n")
					.slice(0, 500),
			})

			// 2. Emit todo_item_divider so the webview creates a box for this subagent
			await this.emitMessage(
				"todo_item_divider",
				JSON.stringify({
					content: this.todoItem.content,
					todoItemId: this.subagentId,
				}),
			)

			// 3. Run the agentic loop
			let userContent: Anthropic.Messages.ContentBlockParam[] = []
			let maxIterations = 50 // Safety limit
			let isFirstIteration = true
			let lastAssistantText = ""

			while (!this.abort && maxIterations-- > 0) {
				const result = await this.makeApiRequestAndProcessResponse(isFirstIteration ? [] : userContent)
				isFirstIteration = false
				if (result.assistantText?.trim()) {
					lastAssistantText = result.assistantText.trim()
				}

				if (result.error) {
					return {
						todoItemId: this.subagentId,
						success: false,
						completionResult: lastAssistantText
							? `Subagent stopped after API errors. Last assistant response:\n\n${lastAssistantText}`
							: undefined,
						error: result.error,
					}
				}

				if (result.done) {
					await this.emitMessage("completion_result", result.completionText ?? "Subagent completed")
					return {
						todoItemId: this.subagentId,
						success: true,
						completionResult: result.completionText,
					}
				}

				userContent = result.nextUserContent
				if (userContent.length === 0) {
					// No tool results and no completion — done
					break
				}
			}

			const fallbackCompletionResult = lastAssistantText
				? `Subagent stopped without calling attempt_completion. Last assistant response:\n\n${lastAssistantText}`
				: undefined
			return {
				todoItemId: this.subagentId,
				success: false,
				completionResult: fallbackCompletionResult,
				error: this.abort ? "Aborted" : "Max iterations reached without attempt_completion",
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err)
			await this.emitMessage("error", `[Subagent ${this.subagentId}] Error: ${errorMsg}`)
			return {
				todoItemId: this.subagentId,
				success: false,
				error: errorMsg,
			}
		}
	}

	// ------------------------------------------------------------------
	// Core streaming + tool execution loop (one API round-trip)
	// ------------------------------------------------------------------

	private async makeApiRequestAndProcessResponse(toolResults: Anthropic.Messages.ContentBlockParam[]): Promise<{
		done: boolean
		completionText?: string
		nextUserContent: Anthropic.Messages.ContentBlockParam[]
		assistantText?: string
		error?: string
	}> {
		await this.prepareConversationForRequest(toolResults)
		this.logDebug("request_prepared", {
			systemPromptHasRefineMarkers: this.hasRefineMarkers(this.systemPrompt),
			historyLength: this.apiConversationHistory.length,
			historySummary: this.summarizeHistory(this.apiConversationHistory),
			incomingToolResults: this.summarizeMessageContent(toolResults),
		})

		await this.emitMessage(
			"api_req_started",
			JSON.stringify({ apiProtocol: "openai", subagentId: this.subagentId } satisfies ClineApiReqInfo),
			true,
		)

		// Make API call
		const requestTools = this.getRequestTools()
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: "code",
			behaviorRole: "subagent",
			taskId: `${this.parentTask.taskId}:${this.subagentId}`,
			subagentId: this.subagentId,
			tools: requestTools,
			tool_choice: this.getRequestToolChoice(),
			parallelToolCalls: false,
		}

		this.captureRequestContext(metadata)

		const stream = this.api.createMessage(this.systemPrompt, this.apiConversationHistory, metadata)

		let assistantMessage = ""
		let reasoningMessage = ""
		let inputTokens = 0
		let outputTokens = 0
		let interruptedToolName = ""

		// Collect tool calls for this turn
		const toolCalls: ToolUse[] = []
		let currentToolUse: (ToolUse & { _rawArgs?: string }) | undefined

		try {
			for await (const chunk of stream) {
				if (this.abort) break

				switch (chunk.type) {
					case "reasoning":
						reasoningMessage += chunk.text
						await this.emitMessage("reasoning", reasoningMessage, true)
						break

					case "usage":
						inputTokens += chunk.inputTokens
						outputTokens += chunk.outputTokens
						break

					case "tool_call_start": {
						// New tool call starting
						currentToolUse = {
							type: "tool_use",
							name: (chunk as any).name || "",
							params: {},
							partial: true,
							id: (chunk as any).id,
							_rawArgs: "",
						}
						// Show tool progress in UI
						await this.emitMessage(
							"tool",
							JSON.stringify({
								tool: (chunk as any).name,
								status: "streaming...",
							}),
							true,
						)
						break
					}

					case "tool_call_delta": {
						const rawDelta = (chunk as any).delta ?? (chunk as any).arguments
						if (currentToolUse && typeof rawDelta === "string") {
							currentToolUse._rawArgs = (currentToolUse._rawArgs || "") + rawDelta
						}
						break
					}

					case "tool_call_end": {
						if (currentToolUse) {
							currentToolUse.partial = false
							if (currentToolUse._rawArgs) {
								try {
									currentToolUse.params = JSON.parse(currentToolUse._rawArgs)
								} catch {
									// keep empty params
								}
								delete currentToolUse._rawArgs
							}
							toolCalls.push(currentToolUse)
							currentToolUse = undefined
						}
						break
					}

					case "tool_call": {
						// Complete tool call in one chunk
						const toolUse: ToolUse = {
							type: "tool_use",
							name: ((chunk as any).name || "") as ToolName,
							params: {},
							partial: false,
							id: (chunk as any).id,
						}
						try {
							toolUse.params =
								typeof (chunk as any).arguments === "string"
									? JSON.parse((chunk as any).arguments)
									: (chunk as any).arguments || {}
						} catch {
							// keep empty params
						}
						toolCalls.push(toolUse)
						break
					}

					case "text": {
						assistantMessage += chunk.text
						await this.emitMessage("text", assistantMessage, true)
						break
					}
				}
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err)
			this.consecutiveApiErrors++
			this.logDebug("api_error", { error: errorMsg })
			await this.emitMessage(
				"api_req_started",
				JSON.stringify({
					apiProtocol: "openai",
					subagentId: this.subagentId,
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cost: 0,
					streamingFailedMessage: errorMsg,
				} satisfies ClineApiReqInfo),
			)
			await this.emitMessage("error", `API error: ${errorMsg}`)
			this.noteTurnWriteProgress(false)
			if (this.consecutiveApiErrors >= MAX_CONSECUTIVE_SUBAGENT_API_ERRORS) {
				return {
					done: false,
					nextUserContent: [],
					assistantText: assistantMessage,
					error: `Subagent API request failed ${this.consecutiveApiErrors} time(s) in a row: ${errorMsg}`,
				}
			}
			return {
				done: false,
				nextUserContent: this.buildContinuationContent([
					`The previous API stream failed before this isolated subtask finished: ${errorMsg}`,
					assistantMessage.trim() ? `Last partial assistant response:\n${assistantMessage.trim()}` : "",
					"Continue the same subtask from the current execution state.",
				]),
				assistantText: assistantMessage,
			}
		}
		this.consecutiveApiErrors = 0

		if (currentToolUse) {
			interruptedToolName = currentToolUse.name
		}

		// Finalize partial messages
		if (reasoningMessage) {
			await this.emitMessage("reasoning", reasoningMessage, false)
		}
		if (assistantMessage) {
			await this.emitMessage("text", assistantMessage, false)
		}

		// Update api_req_started with token info
		await this.emitMessage(
			"api_req_started",
			JSON.stringify({
				apiProtocol: "openai",
				subagentId: this.subagentId,
				tokensIn: inputTokens,
				tokensOut: outputTokens,
				cost: 0,
			} satisfies ClineApiReqInfo),
		)

		this.logDebug("response_received", {
			reasoningPreview: reasoningMessage.slice(0, 320),
			assistantPreview: assistantMessage.slice(0, 320),
			toolCalls: this.summarizeToolCalls(toolCalls),
			historyLengthAfterAssistantMessage: this.apiConversationHistory.length,
			historySummaryAfterAssistantMessage: this.summarizeHistory(this.apiConversationHistory),
		})

		if (interruptedToolName) {
			this.appendAssistantMessage(assistantMessage, [])
			this.noteTurnWriteProgress(false)
			return {
				done: false,
				nextUserContent: this.buildContinuationContent([
					`The previous API response ended while streaming tool "${interruptedToolName}", so that partial tool call was not executed.`,
					assistantMessage.trim() ? `Last partial assistant response:\n${assistantMessage.trim()}` : "",
					"Continue this same isolated subtask and issue a complete tool call if needed.",
				]),
				assistantText: assistantMessage,
			}
		}

		const completionToolCall = toolCalls.find((tc) => tc.name === "attempt_completion")

		// Execute tool calls and collect results
		if (toolCalls.length === 0) {
			this.appendAssistantMessage(assistantMessage, [])
			return { done: false, nextUserContent: [], assistantText: assistantMessage }
		}

		this.appendAssistantMessage(assistantMessage, toolCalls)

		const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = []
		let didWriteRequiredTarget = false
		let didAttemptWrite = false
		for (const tc of toolCalls) {
			if (tc.name === "attempt_completion") {
				continue
			}

			const toolName = tc.name
			const toolParams = (tc.params || {}) as Record<string, unknown>
			const toolId = this.ensureToolUseId(tc)
			const readInspectionBlockReason = this.getReadInspectionBlockReason(toolName, toolParams)

			if (readInspectionBlockReason) {
				toolResultBlocks.push(this.buildToolResultBlock(toolId, readInspectionBlockReason, true))
				await this.emitMessage(
					"tool",
					JSON.stringify({
						tool: toolName,
						path: String(toolParams.path || toolParams.file_path || ""),
						status: "blocked read loop",
					}),
				)
				continue
			}

			const isEditTool = this.isEditTool(toolName)
			const editToolPaths = isEditTool ? this.getEditToolPaths(toolName, toolParams) : []

			if (isEditTool) {
				didAttemptWrite = true
			}

			// Execute via parent Task
			try {
				const result = await this.parentTask.executeToolForSubagent(
					toolName,
					toolParams,
					toolId,
					this.subagentId,
				)
				if (isEditTool && !result.startsWith("[ERROR]")) {
					for (const editToolPath of editToolPaths) {
						didWriteRequiredTarget = this.markWriteTargetCompleted(editToolPath) || didWriteRequiredTarget
					}
				}
				const displayPath = editToolPaths.join(", ") || String(toolParams.path || "")
				toolResultBlocks.push(
					this.buildToolResultBlock(toolId, `Tool "${toolName}" completed for "${displayPath}".\n${result}`),
				)

				// Emit tool result to UI
				await this.emitMessage(
					"tool",
					JSON.stringify({
						tool: toolName,
						path: displayPath,
						status: "done",
					}),
				)
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				toolResultBlocks.push(this.buildToolResultBlock(toolId, `[ERROR] ${errorMsg}`, true))
			}
		}
		this.logDebug("tool_results_prepared", {
			toolResults: this.summarizeMessageContent(toolResultBlocks),
		})
		this.noteTurnWriteProgress(didWriteRequiredTarget, didAttemptWrite)

		if (completionToolCall) {
			const completionText =
				typeof (completionToolCall.params as any)?.result === "string"
					? ((completionToolCall.params as any).result as string).trim()
					: ""
			if (!completionText) {
				const toolId = this.ensureToolUseId(completionToolCall)
				return {
					done: false,
					nextUserContent: [
						this.buildToolResultBlock(
							toolId,
							"attempt_completion result was empty. Continue the assigned plan work, or call attempt_completion again with a non-empty result that summarizes completed work or concrete blockers.",
							true,
						),
					],
					assistantText: assistantMessage,
				}
			}
			return { done: true, completionText, nextUserContent: [], assistantText: assistantMessage }
		}

		return {
			done: false,
			nextUserContent: toolResultBlocks,
			assistantText: assistantMessage,
		}
	}

	// ------------------------------------------------------------------
	// Message emission — push to parent Task's clineMessages with subagentId
	// ------------------------------------------------------------------

	private async emitMessage(type: ClineSay, text?: string, partial?: boolean): Promise<void> {
		const msg: ClineMessage = {
			ts: Date.now(),
			type: "say",
			say: type,
			text,
			partial,
			subagentId: this.subagentId,
		}
		await this.parentTask.pushSubagentMessage(msg)
	}

	private captureRequestContext(metadata: ApiHandlerCreateMessageMetadata): void {
		const inspector = ContextInspectorPanel.getInstance()
		inspector.show()
		inspector.logCapturedContext({
			systemPrompt: this.systemPrompt,
			messages: this.apiConversationHistory as any[],
			metadata,
			modelId: this.api.getModel().id,
			provider: this.parentTask.apiConfiguration?.apiProvider,
		})
	}

	// ------------------------------------------------------------------
	// Initial message builder
	// ------------------------------------------------------------------

	private async loadMemoryContext(): Promise<string> {
		if (this.memoryContext !== undefined) {
			return this.memoryContext
		}

		try {
			const memoryFilePath = path.join(this.parentTask.cwd, ".roo-memories.json")
			const rawMemoryStore = await fs.readFile(memoryFilePath, "utf8")
			const memoryStore = JSON.parse(rawMemoryStore) as WorkspaceMemoryStore
			const memories = Array.isArray(memoryStore.memories) ? memoryStore.memories : []
			this.memoryContext = memories
				.map((memory, index) => {
					const title = memory.title?.trim() || `Memory ${index + 1}`
					const content = memory.content?.trim()
					const tags = Array.isArray(memory.tags)
						? memory.tags
								.map((tag) => tag.trim())
								.filter(Boolean)
								.join(", ")
						: ""

					if (!content) {
						return ""
					}

					return tags ? `- ${title} [${tags}]\n${content}` : `- ${title}\n${content}`
				})
				.filter(Boolean)
				.join("\n\n")
		} catch {
			this.memoryContext = ""
		}

		return this.memoryContext
	}

	private buildPlanFilesContext(): string {
		if (this.planFiles.length === 0) {
			return "No plan files were loaded for this todo item. Report this as a blocker instead of inventing work."
		}

		return this.planFiles
			.map((plan, index) => {
				const parsed = parsePlanTargetHeader(plan.content)
				const targetLines = parsed ? [`Action: ${parsed.action}`, `Target: ${parsed.path}`] : []
				return [
					`### Plan ${index + 1}: ${plan.filePath}`,
					...targetLines,
					"",
					"```md",
					plan.content.trim() || "(empty plan file)",
					"```",
				].join("\n")
			})
			.join("\n\n")
	}

	private buildRequiredWriteTargetsContext(): string {
		const targets = this.getRequiredWriteTargets()
		return targets.length > 0
			? targets.map((target) => `- ${target}`).join("\n")
			: "(none; follow GENERAL/DELETE plans only)"
	}

	private async buildInitialMessage(): Promise<Anthropic.Messages.TextBlockParam[]> {
		const parts: string[] = []

		parts.push(
			[
				"Subagent execution directive:",
				"You are an isolated child execution subagent for exactly one refined todo item.",
				"The parent agent has already decomposed and scoped the work.",
				"The assigned todo context and plan files are your primary source of truth.",
				"You must implement or report blockers for the loaded plan files below.",
				"Do not call attempt_completion with an empty result.",
				"Do not list workspace directories or inspect the project tree just to orient yourself.",
				"If the plan names concrete target files, symbols, routes, types, or components, do not start by reading files just to re-confirm the plan.",
				"Start from the assigned refined todo item and act directly on the named files, symbols, routes, types, or components.",
				"Only read a target file when the edit requires current surrounding text that is not already present in the plan.",
				"If the assigned item lacks an exact target, use one precise file/symbol/content search to locate it, then implement immediately.",
			].join("\n"),
		)

		const assignedTodo: Record<string, string> = {
			id: this.todoItem.id,
			status: this.todoItem.status,
			content: this.todoItem.content,
		}
		if (this.todoItem.context?.trim()) {
			assignedTodo.context = this.todoItem.context.trim()
		}

		parts.push(`Assigned refined todo item:\n${JSON.stringify(assignedTodo, null, 2)}`)
		parts.push(`Required write targets:\n${this.buildRequiredWriteTargetsContext()}`)
		parts.push(`Loaded plan files:\n${this.buildPlanFilesContext()}`)

		const memoryContext = await this.loadMemoryContext()
		parts.push(`Relevant memories:\n${memoryContext || "None."}`)

		return [{ type: "text" as const, text: parts.join("\n\n") }]
	}
}
