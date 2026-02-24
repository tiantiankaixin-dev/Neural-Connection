import fs from "fs/promises"
import path from "path"
import { v4 as uuidv4 } from "uuid"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { summarizeConversation, generateGlobalSummaryText } from "../condense"
import crypto from "crypto"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface TaskMemoryParams {
	action: "start" | "end" | "query"
	title?: string | null
	description?: string | null
	previous_context_summary?: string | null
	task_memory_id?: string | null
	task_summary?: string | null
	key_files?: string[] | null
	query?: string | null
	tags?: string[] | null
}

export interface TaskMemoryEntry {
	id: string
	rooTaskId: string
	status: "active" | "completed"
	title: string
	description: string
	previousContextSummary: string
	taskSummary: string
	keyFiles: string[]
	tags: string[]
	startedAt: string
	completedAt: string | null
	conversationRef: {
		taskId: string
		messageCountAtStart: number
		messageCountAtEnd: number | null
	}
}

export interface TaskMemoryStore {
	version: number
	tasks: TaskMemoryEntry[]
}

const TASK_MEMORY_FILE_NAME = ".roo-task-memories.json"
const TASK_MEMORY_STORE_VERSION = 1
const MAX_QUERY_RESULTS = 10

export class TaskMemoryTool extends BaseTool<"task_memory"> {
	readonly name = "task_memory" as const

	async execute(params: TaskMemoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const { action } = params

		try {
			if (!action) {
				task.consecutiveMistakeCount++
				task.recordToolError("task_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("task_memory", "action"))
				return
			}

			task.consecutiveMistakeCount = 0

			const memoryFilePath = this.getMemoryFilePath(task.cwd)
			let store = await this.loadMemoryStore(memoryFilePath)

			switch (action) {
				case "start":
					await this.handleStart(params, task, store, memoryFilePath, callbacks)
					break
				case "end":
					await this.handleEnd(params, task, store, memoryFilePath, callbacks)
					break
				case "query":
					await this.handleQuery(params, store, callbacks)
					break
				default:
					task.consecutiveMistakeCount++
					task.recordToolError("task_memory")
					pushToolResult(
						formatResponse.toolError(`Invalid action: "${action}". Must be "start", "end", or "query".`),
					)
					return
			}

			task.recordToolUsage("task_memory")
		} catch (error) {
			await handleError("managing task memory", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async handleStart(
		params: TaskMemoryParams,
		task: Task,
		store: TaskMemoryStore,
		memoryFilePath: string,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { pushToolResult, askApproval } = callbacks
		const { title, description, previous_context_summary, tags } = params

		// Validate required params for "start"
		if (!title) {
			task.consecutiveMistakeCount++
			task.recordToolError("task_memory")
			pushToolResult(formatResponse.toolError('Parameter "title" is required for action "start".'))
			return
		}
		if (!description) {
			task.consecutiveMistakeCount++
			task.recordToolError("task_memory")
			pushToolResult(formatResponse.toolError('Parameter "description" is required for action "start".'))
			return
		}
		if (!previous_context_summary) {
			task.consecutiveMistakeCount++
			task.recordToolError("task_memory")
			pushToolResult(
				formatResponse.toolError('Parameter "previous_context_summary" is required for action "start".'),
			)
			return
		}

		const taskMemoryId = uuidv4()
		const messageCount = task.apiConversationHistory?.length ?? 0

		const entry: TaskMemoryEntry = {
			id: taskMemoryId,
			rooTaskId: task.taskId,
			status: "active",
			title,
			description,
			previousContextSummary: previous_context_summary,
			taskSummary: "",
			keyFiles: [],
			tags: tags || [],
			startedAt: new Date().toISOString(),
			completedAt: null,
			conversationRef: {
				taskId: task.taskId,
				messageCountAtStart: messageCount,
				messageCountAtEnd: null,
			},
		}

		store.tasks.push(entry)

		// Ask approval
		const didApprove = await askApproval("tool", JSON.stringify({ tool: "task_memory", action: "start", title }))

		if (!didApprove) {
			pushToolResult("Task memory start was cancelled.")
			return
		}

		await this.saveMemoryStore(memoryFilePath, store)

		pushToolResult(
			`Task memory started.\n` +
				`- ID: ${taskMemoryId}\n` +
				`- Title: ${title}\n` +
				`- Status: active\n` +
				`\nUse this ID with action "end" when the task is complete.`,
		)
	}

	private async handleEnd(
		params: TaskMemoryParams,
		task: Task,
		store: TaskMemoryStore,
		memoryFilePath: string,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { pushToolResult, askApproval } = callbacks
		const { task_memory_id, task_summary, key_files, tags } = params

		// Validate required params for "end"
		if (!task_memory_id) {
			task.consecutiveMistakeCount++
			task.recordToolError("task_memory")
			pushToolResult(formatResponse.toolError('Parameter "task_memory_id" is required for action "end".'))
			return
		}
		if (!task_summary) {
			task.consecutiveMistakeCount++
			task.recordToolError("task_memory")
			pushToolResult(formatResponse.toolError('Parameter "task_summary" is required for action "end".'))
			return
		}

		// Find the task memory entry
		const entryIndex = store.tasks.findIndex((t) => t.id === task_memory_id)
		if (entryIndex === -1) {
			pushToolResult(formatResponse.toolError(`Task memory with id "${task_memory_id}" not found.`))
			return
		}

		const entry = store.tasks[entryIndex]
		if (entry.status === "completed") {
			pushToolResult(formatResponse.toolError(`Task memory "${task_memory_id}" is already completed.`))
			return
		}

		const messageCount = task.apiConversationHistory?.length ?? 0

		// Update the entry
		store.tasks[entryIndex] = {
			...entry,
			status: "completed",
			taskSummary: task_summary,
			keyFiles: key_files || [],
			tags: [...new Set([...(entry.tags || []), ...(tags || [])])],
			completedAt: new Date().toISOString(),
			conversationRef: {
				...entry.conversationRef,
				messageCountAtEnd: messageCount,
			},
		}

		// Ask approval
		const didApprove = await askApproval(
			"tool",
			JSON.stringify({ tool: "task_memory", action: "end", title: entry.title }),
		)

		if (!didApprove) {
			pushToolResult("Task memory end was cancelled.")
			return
		}

		await this.saveMemoryStore(memoryFilePath, store)

		// === Global Summary Q Model ===
		// When a sub-task completes, we:
		// 1. Generate individual summary D from all messages since last global Q (LLM call 1)
		// 2. Store summary D in task_memory
		// 3. Collect all completed sub-task summaries
		// 4. Generate global summary Q from all summaries (LLM call 2, or reuse if only 1)
		// 5. Tag old Q + summary D with new Q's condenseId → append new Q
		//
		// Result: model sees [Q] + [current task stacked partials] + [current messages]
		let condenseSummary = ""
		let condenseError = ""
		let condenseMode = ""
		try {
			const messages = task.apiConversationHistory

			// Find position of the last global summary Q (if any)
			let lastGlobalQIdx = -1
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].isGlobalSummary) {
					lastGlobalQIdx = i
					break
				}
			}

			// Determine where to start summarization for individual summary D:
			// From after the last global Q (covers between-task chat + task D messages)
			// If no Q exists, from beginning or from task start
			const summarizeStartIdx = lastGlobalQIdx >= 0 ? lastGlobalQIdx + 1 : 0

			// Estimate token count of messages to summarize
			const messagesToSummarize = messages.slice(summarizeStartIdx)
			let estimatedTokens = 0
			for (const msg of messagesToSummarize) {
				const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
				estimatedTokens += Math.ceil(content.length / 4)
			}

			let contextWindow = 128000
			try {
				contextWindow = task.api.getModel().info.contextWindow ?? 128000
			} catch {
				// Use default if model info unavailable
			}
			const tokenThreshold = Math.floor(contextWindow * 0.5)

			// --- Step 1: Generate individual summary D ---
			let individualSummaryText = ""
			let condenseResult
			if (estimatedTokens <= tokenThreshold) {
				// FULL-QUALITY: all messages since last Q fit
				condenseResult = await summarizeConversation({
					messages,
					apiHandler: task.api,
					systemPrompt: "",
					taskId: task.taskId,
					isAutomaticTrigger: false,
					subtaskTitle: entry.title,
					summarizeFromIndex: summarizeStartIdx,
				})
				condenseMode = "full"
			} else {
				// INCREMENTAL: too many messages → summarize from last summary only
				condenseResult = await summarizeConversation({
					messages,
					apiHandler: task.api,
					systemPrompt: "",
					taskId: task.taskId,
					isAutomaticTrigger: false,
					subtaskTitle: entry.title,
				})
				condenseMode = "incremental"
			}

			if (condenseResult.error) {
				condenseError = condenseResult.error
			} else if (condenseResult.messages !== messages) {
				// Step 1 succeeded: update history with individual summary + tagging
				await task.overwriteApiConversationHistory(condenseResult.messages)
				individualSummaryText = condenseResult.summary
			}

			// --- Step 2: Store individual summary in task_memory ---
			if (individualSummaryText) {
				store.tasks[entryIndex] = {
					...store.tasks[entryIndex],
					taskSummary: individualSummaryText,
				}
				await this.saveMemoryStore(memoryFilePath, store)
			}

			// --- Step 3: Collect all completed sub-task summaries ---
			const allSummaries = store.tasks
				.filter((t) => t.status === "completed" && t.taskSummary)
				.map((t) => ({ title: t.title, summary: t.taskSummary }))

			// --- Step 4: Generate global summary Q ---
			if (allSummaries.length > 0 && individualSummaryText) {
				const globalResult = await generateGlobalSummaryText(allSummaries, task.api)

				if (globalResult) {
					// --- Step 5: Tag old Q + individual summary D, append new Q ---
					const currentMessages = task.apiConversationHistory
					const newQId = crypto.randomUUID()

					// Find positions of old global Q and the individual summary just created
					let oldQIdx = -1
					for (let i = currentMessages.length - 1; i >= 0; i--) {
						if (currentMessages[i].isGlobalSummary) {
							oldQIdx = i
							break
						}
					}

					const tagFrom = oldQIdx >= 0 ? oldQIdx : 0

					// Tag messages from tagFrom that don't already have condenseParent
					const updatedMessages = currentMessages.map((msg, index) => {
						if (index < tagFrom) return msg
						if (msg.condenseParent) return msg // already tagged
						return { ...msg, condenseParent: newQId }
					})

					// Create new Q message
					const lastTs = currentMessages[currentMessages.length - 1]?.ts ?? Date.now()
					const qMessage = {
						role: "user" as const,
						content: [{ type: "text" as const, text: `## Global Task Summary\n${globalResult.text}` }],
						ts: lastTs + 1,
						isSummary: true,
						isGlobalSummary: true,
						condenseId: newQId,
					}
					updatedMessages.push(qMessage)

					await task.overwriteApiConversationHistory(updatedMessages)
					condenseSummary = globalResult.text
					condenseMode += "+global"
				}
			}
		} catch (error) {
			console.error("[TaskMemoryTool] Failed to condense sub-task messages:", error)
			condenseError = error instanceof Error ? error.message : String(error)
			// Non-critical: condensation failure shouldn't fail the tool
		}

		const condenseStatus = condenseSummary
			? `\n- Condensed: ✅ Global summary Q updated (${condenseMode})`
			: condenseError
				? `\n- Condensed: ⚠️ ${condenseError}`
				: ""

		pushToolResult(
			`Task memory completed.\n` +
				`- ID: ${task_memory_id}\n` +
				`- Title: ${entry.title}\n` +
				`- Status: completed\n` +
				`- Summary: ${task_summary}\n` +
				`- Previous Context: ${entry.previousContextSummary.substring(0, 200)}${entry.previousContextSummary.length > 200 ? "..." : ""}\n` +
				`- Conversation: ${entry.conversationRef.messageCountAtStart} → ${messageCount} messages\n` +
				`- Key Files: ${(key_files || []).join(", ") || "none"}` +
				condenseStatus,
		)
	}

	private async handleQuery(
		params: TaskMemoryParams,
		store: TaskMemoryStore,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { pushToolResult } = callbacks
		const { query, tags } = params

		let results = [...store.tasks]

		// Filter by tags if provided
		if (tags && tags.length > 0) {
			results = results.filter((t) => tags.some((tag) => t.tags.includes(tag)))
		}

		// Filter by query (simple text search across title, description, taskSummary, previousContextSummary)
		if (query && query.trim()) {
			const q = query.toLowerCase()
			results = results.filter(
				(t) =>
					t.title.toLowerCase().includes(q) ||
					t.description.toLowerCase().includes(q) ||
					t.taskSummary.toLowerCase().includes(q) ||
					t.previousContextSummary.toLowerCase().includes(q) ||
					t.keyFiles.some((f) => f.toLowerCase().includes(q)),
			)
		}

		// Sort by most recent first
		results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

		// Limit results
		results = results.slice(0, MAX_QUERY_RESULTS)

		if (results.length === 0) {
			pushToolResult("No task memories found matching the query.")
			return
		}

		const formatted = results
			.map((t, i) => {
				return (
					`[${i + 1}] ${t.status === "active" ? "🔄" : "✅"} ${t.title}\n` +
					`    ID: ${t.id}\n` +
					`    Status: ${t.status}\n` +
					`    Started: ${t.startedAt}\n` +
					(t.completedAt ? `    Completed: ${t.completedAt}\n` : "") +
					`    Description: ${t.description}\n` +
					(t.taskSummary ? `    Summary: ${t.taskSummary}\n` : "") +
					`    Previous Context: ${t.previousContextSummary.substring(0, 150)}${t.previousContextSummary.length > 150 ? "..." : ""}\n` +
					`    Conversation Ref: taskId=${t.conversationRef.taskId}, messages ${t.conversationRef.messageCountAtStart}→${t.conversationRef.messageCountAtEnd ?? "ongoing"}\n` +
					(t.keyFiles.length > 0 ? `    Key Files: ${t.keyFiles.join(", ")}\n` : "") +
					(t.tags.length > 0 ? `    Tags: ${t.tags.join(", ")}` : "")
				)
			})
			.join("\n\n")

		pushToolResult(`Found ${results.length} task ${results.length === 1 ? "memory" : "memories"}:\n\n${formatted}`)
	}

	/** @internal Exposed for testing */
	public getMemoryFilePath(cwd: string): string {
		return path.join(cwd, TASK_MEMORY_FILE_NAME)
	}

	/** @internal Exposed for testing */
	public async loadMemoryStore(filePath: string): Promise<TaskMemoryStore> {
		try {
			const content = await fs.readFile(filePath, "utf8")
			const store = JSON.parse(content) as TaskMemoryStore

			if (store.version !== TASK_MEMORY_STORE_VERSION) {
				return { version: TASK_MEMORY_STORE_VERSION, tasks: store.tasks || [] }
			}

			return store
		} catch (error) {
			return { version: TASK_MEMORY_STORE_VERSION, tasks: [] }
		}
	}

	/** @internal Exposed for testing */
	public async saveMemoryStore(filePath: string, store: TaskMemoryStore): Promise<void> {
		await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf8")
	}

	/** @internal Exposed for testing - search task memories */
	public searchTasks(store: TaskMemoryStore, query?: string, tags?: string[]): TaskMemoryEntry[] {
		let results = [...store.tasks]

		if (tags && tags.length > 0) {
			results = results.filter((t) => tags.some((tag) => t.tags.includes(tag)))
		}

		if (query && query.trim()) {
			const q = query.toLowerCase()
			results = results.filter(
				(t) =>
					t.title.toLowerCase().includes(q) ||
					t.description.toLowerCase().includes(q) ||
					t.taskSummary.toLowerCase().includes(q) ||
					t.previousContextSummary.toLowerCase().includes(q),
			)
		}

		return results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
	}

	override async handlePartial(task: Task, block: ToolUse<"task_memory">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const taskMemoryTool = new TaskMemoryTool()
