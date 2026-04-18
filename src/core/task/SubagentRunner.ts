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
import { buildApiHandler, type ApiHandler, type ApiHandlerCreateMessageMetadata } from "../../api"
import type { ClineMessage, ClineSay, TodoItem, ToolName } from "@roo-code/types"
import type { PlanFile } from "../task-persistence/plan-persistence"
import type { ToolUse } from "../../shared/tools"
import type { Task } from "./Task"

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
	/** Allowed file paths — only these files may be edited. */
	ownedFiles: string[]
}

export interface SubagentResult {
	todoItemId: string
	success: boolean
	completionResult?: string
	error?: string
}

// ---------------------------------------------------------------------------
// SubagentRunner
// ---------------------------------------------------------------------------

export class SubagentRunner {
	readonly subagentId: string
	readonly todoItem: TodoItem
	readonly ownedFiles: string[]

	private parentTask: Task
	private api: ApiHandler
	private systemPrompt: string
	private tools: import("openai").default.Chat.ChatCompletionTool[]
	private planFiles: PlanFile[]

	/** Isolated conversation history for this subagent. */
	private apiConversationHistory: Anthropic.Messages.MessageParam[] = []

	/** Set to true when the runner should stop. */
	abort = false

	constructor(config: SubagentConfig) {
		this.subagentId = config.todoItem.id ?? `subagent-${Date.now()}`
		this.todoItem = config.todoItem
		this.parentTask = config.parentTask
		this.api = buildApiHandler(config.parentTask.apiConfiguration)
		this.systemPrompt = config.systemPrompt
		this.tools = config.tools
		this.planFiles = config.planFiles
		this.ownedFiles = config.ownedFiles
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

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	async run(): Promise<SubagentResult> {
		try {
			// 1. Build initial user message from plan
			const initialMessage = this.buildInitialMessage()
			this.apiConversationHistory.push({ role: "user", content: initialMessage })
			this.logDebug("start", {
				ownedFiles: this.ownedFiles,
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

			while (!this.abort && maxIterations-- > 0) {
				const result = await this.makeApiRequestAndProcessResponse(isFirstIteration ? [] : userContent)
				isFirstIteration = false

				if (result.done) {
					await this.emitMessage("completion_result", result.completionText ?? "Subagent completed")
					return {
						todoItemId: this.subagentId,
						success: true,
						completionResult: result.completionText,
					}
				}

				// Prepare next iteration with accumulated tool results
				userContent = result.nextUserContent
				if (userContent.length === 0) {
					// No tool results and no completion — done
					break
				}
			}

			return {
				todoItemId: this.subagentId,
				success: false,
				error: this.abort ? "Aborted" : "Max iterations reached",
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
	}> {
		// Add tool results to history if any
		if (toolResults.length > 0) {
			this.apiConversationHistory.push({ role: "user", content: toolResults })
		}
		this.logDebug("request_prepared", {
			systemPromptHasRefineMarkers: this.hasRefineMarkers(this.systemPrompt),
			historyLength: this.apiConversationHistory.length,
			historySummary: this.summarizeHistory(this.apiConversationHistory),
			incomingToolResults: this.summarizeMessageContent(toolResults),
		})

		// Emit api_req_started (partial so the post-stream token update finalizes this row in place)
		await this.emitMessage("api_req_started", JSON.stringify({ apiProtocol: "openai" }), true)

		// Make API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: "code",
			behaviorRole: "code",
			taskId: `${this.parentTask.taskId}:${this.subagentId}`,
			tools: this.tools,
			tool_choice: "auto",
			parallelToolCalls: false,
		}

		const stream = this.api.createMessage(this.systemPrompt, this.apiConversationHistory, metadata)

		let assistantMessage = ""
		let reasoningMessage = ""
		let inputTokens = 0
		let outputTokens = 0

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
			this.logDebug("api_error", { error: errorMsg })
			await this.emitMessage("error", `API error: ${errorMsg}`)
			// Don't throw — return as failed iteration
			return { done: false, nextUserContent: [] }
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
				tokensIn: inputTokens,
				tokensOut: outputTokens,
				cost: 0,
			}),
		)

		// Save assistant message to conversation history
		const assistantContent: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam> = []
		if (assistantMessage) {
			assistantContent.push({ type: "text" as const, text: assistantMessage })
		}
		for (const tc of toolCalls) {
			assistantContent.push({
				type: "tool_use" as const,
				id: tc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				name: tc.name || "",
				input: tc.params || {},
			})
		}
		if (assistantContent.length > 0) {
			this.apiConversationHistory.push({ role: "assistant", content: assistantContent })
		}
		this.logDebug("response_received", {
			reasoningPreview: reasoningMessage.slice(0, 320),
			assistantPreview: assistantMessage.slice(0, 320),
			toolCalls: this.summarizeToolCalls(toolCalls),
			historyLengthAfterAssistantMessage: this.apiConversationHistory.length,
			historySummaryAfterAssistantMessage: this.summarizeHistory(this.apiConversationHistory),
		})

		// Check for attempt_completion
		for (const tc of toolCalls) {
			if (tc.name === "attempt_completion") {
				const completionText = ((tc.params as any)?.result as string) ?? "Task completed"
				return { done: true, completionText, nextUserContent: [] }
			}
		}

		// Execute tool calls and collect results
		if (toolCalls.length === 0) {
			return { done: false, nextUserContent: [] }
		}

		const toolResultContent: Anthropic.Messages.ToolResultBlockParam[] = []
		for (const tc of toolCalls) {
			const toolName = tc.name
			const toolParams = (tc.params || {}) as Record<string, unknown>
			const toolId = tc.id || `tool-${Date.now()}`

			// File ownership check for edit tools
			const editTools = new Set([
				"write_to_file",
				"apply_diff",
				"edit",
				"search_and_replace",
				"search_replace",
				"insert_content",
				"edit_file",
			])
			if (editTools.has(toolName)) {
				const filePath = toolParams.path as string
				if (filePath && this.ownedFiles.length > 0) {
					const isOwned = this.ownedFiles.some(
						(owned) => filePath.includes(owned) || owned.includes(filePath),
					)
					if (!isOwned) {
						const errResult = `[ERROR] File "${filePath}" is not owned by this subagent. Owned files: ${this.ownedFiles.join(", ")}`
						toolResultContent.push({ type: "tool_result", tool_use_id: toolId, content: errResult })
						await this.emitMessage(
							"tool",
							JSON.stringify({ tool: toolName, path: filePath, error: "file ownership denied" }),
						)
						continue
					}
				}
			}

			// Execute via parent Task
			try {
				const result = await this.parentTask.executeToolForSubagent(
					toolName,
					toolParams,
					toolId,
					this.subagentId,
				)
				toolResultContent.push({ type: "tool_result", tool_use_id: toolId, content: result })

				// Emit tool result to UI
				await this.emitMessage(
					"tool",
					JSON.stringify({
						tool: toolName,
						path: toolParams.path || "",
						status: "done",
					}),
				)
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err)
				toolResultContent.push({
					type: "tool_result",
					tool_use_id: toolId,
					content: `[ERROR] ${errorMsg}`,
				})
			}
		}
		this.logDebug("tool_results_prepared", {
			toolResults: this.summarizeMessageContent(toolResultContent),
		})

		return { done: false, nextUserContent: toolResultContent }
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

	// ------------------------------------------------------------------
	// Initial message builder
	// ------------------------------------------------------------------

	private buildInitialMessage(): Anthropic.Messages.TextBlockParam[] {
		// Mirrors opencode's TaskTool pass-through semantics.
		// See sst/opencode packages/opencode/src/tool/task.ts:
		//   const parts = yield* ops.resolvePromptParts(params.prompt)
		// i.e. the parent's prompt is forwarded to the subagent with zero wrapping.
		// We concatenate the refine-phase artifacts verbatim so the subagent sees
		// exactly what the planning agent wrote, without extra framing.
		const parts: string[] = []

		const taskText = this.todoItem.content?.trim() ?? ""
		if (taskText) parts.push(taskText)

		const taskContext = this.todoItem.context?.trim() ?? ""
		if (taskContext) parts.push(taskContext)

		const planText = this.planFiles.map((f) => `${f.filePath}:\n${f.content.trim()}`).join("\n\n")
		if (planText) parts.push(planText)

		// File-scope guard has no opencode equivalent but is required by this
		// project's ownership model. Kept terse so it does not re-introduce a wrapper.
		if (this.ownedFiles.length > 0) {
			parts.push(`Files you may modify:\n${this.ownedFiles.map((f) => `- ${f}`).join("\n")}`)
		}

		return [{ type: "text" as const, text: parts.join("\n\n") }]
	}
}
