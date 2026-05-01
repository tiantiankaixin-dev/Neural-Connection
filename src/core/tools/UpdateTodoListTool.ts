import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import cloneDeep from "clone-deep"
import crypto from "crypto"
import { TodoItem, TodoStatus, todoStatusSchema } from "@roo-code/types"
import { getLatestTodo } from "../../shared/todo"
import { applyContextSelection, refreshContextSelection } from "../condense/context-selector"

interface UpdateTodoListParams {
	todos: string
	/** Refine mode only: one markdown string per checklist line (same order). */
	item_contexts?: string[]
}

let approvedTodoList: TodoItem[] | undefined = undefined

export class UpdateTodoListTool extends BaseTool<"update_todo_list"> {
	readonly name = "update_todo_list" as const

	async execute(params: UpdateTodoListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks

		try {
			const todosRaw = params.todos

			let todos: TodoItem[]
			try {
				todos = parseMarkdownChecklist(todosRaw || "")
			} catch {
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("The todos parameter is not valid markdown checklist or JSON"))
				return
			}

			const itemContexts = params.item_contexts
			if (itemContexts !== undefined) {
				if (!Array.isArray(itemContexts)) {
					task.consecutiveMistakeCount++
					task.recordToolError("update_todo_list")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("item_contexts must be an array of strings"))
					return
				}
				if (itemContexts.length !== todos.length) {
					task.consecutiveMistakeCount++
					task.recordToolError("update_todo_list")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`item_contexts must have the same length as the checklist (${todos.length} lines), got ${itemContexts.length}`,
						),
					)
					return
				}
				todos = todos.map((t, i) => {
					const raw = itemContexts[i]
					const ctx = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined
					return ctx ? { ...t, context: ctx } : { ...t }
				})
			}

			const { valid, error } = validateTodos(todos)
			if (!valid) {
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(error || "todos parameter validation failed"))
				return
			}

			let normalizedTodos: TodoItem[] = todos.map((t) => ({
				id: t.id,
				content: t.content,
				status: normalizeStatus(t.status),
				...(t.context?.trim() ? { context: t.context.trim() } : {}),
			}))
			const refineCompletionError =
				"Refine mode cannot be completed by marking every todo item as completed. Rewrite the todo list into pending/in-progress architecture-based implementation groups, then call write_todo_plan for each item. Refine mode exits only after all required write_todo_plan calls are recorded."
			const isCompletingRefineTodoList = (candidateTodos: TodoItem[]) =>
				task.isRefineMode &&
				candidateTodos.length > 0 &&
				candidateTodos.every((todo) => todo.status === "completed")

			if (isCompletingRefineTodoList(normalizedTodos)) {
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(refineCompletionError))
				return
			}

			const approvalMsg = JSON.stringify({
				tool: "updateTodoList",
				todos: normalizedTodos,
			})

			approvedTodoList = cloneDeep(normalizedTodos)
			const didApprove = await askApproval("tool", approvalMsg)
			if (!didApprove) {
				pushToolResult("User declined to update the todoList.")
				return
			}

			const isTodoListChanged =
				approvedTodoList !== undefined && JSON.stringify(normalizedTodos) !== JSON.stringify(approvedTodoList)
			if (isTodoListChanged) {
				normalizedTodos = approvedTodoList ?? []
				task.say(
					"user_edit_todos",
					JSON.stringify({
						tool: "updateTodoList",
						todos: normalizedTodos,
					}),
				)
			}
			if (isCompletingRefineTodoList(normalizedTodos)) {
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(refineCompletionError))
				return
			}

			// Track the "active item" — the item currently being worked on.
			// Active = first in_progress item, or if none, first pending item.
			// Emit a divider whenever the active item changes, INCLUDING the
			// very first update_todo_list call. This ensures:
			//   1. First item gets a border immediately when todo list is created
			//   2. Each item gets its own separate bordered box
			//   3. Works regardless of whether AI uses [-] or skips to [x]
			const getActiveItem = (todos: TodoItem[]): TodoItem | undefined => {
				return todos.find((t) => t.status === "in_progress") || todos.find((t) => t.status === "pending")
			}

			// Context selection: if this is the first todo list creation and no context selection
			// has been done yet, trigger selection now (scans existing turn files, asks condensing
			// model to pick relevant turns, replaces old history with selected context blocks).
			// If Phase 1 already ran (contextRefsPath set), just load the existing result for UI.
			// Skipped entirely when autoCondenseContext is enabled (Phase 3 handles compression instead).
			let contextSelectionResult: import("../condense/context-selector").ContextSelectionResult | undefined
			if (task.autoCondenseContext) {
				// In auto-condense mode, if context refs exist (set by Phase 1), refresh for UI display
				if (task.contextRefsPath) {
					try {
						contextSelectionResult = await refreshContextSelection(task, normalizedTodos)
						if (contextSelectionResult) {
							console.log(
								`[UpdateTodoList] Context selection refreshed for UI (autoCondenseContext mode): ${contextSelectionResult.summary.substring(0, 100)}`,
							)
						}
					} catch (err) {
						console.warn("[UpdateTodoList] Context refresh for UI failed (non-critical):", err)
					}
				} else {
					console.log("[UpdateTodoList] Context selection skipped (autoCondenseContext mode, no refs yet)")
				}
			} else if (!task.taskEstablished && !task.contextRefsPath) {
				try {
					contextSelectionResult = await applyContextSelection(task, normalizedTodos)
					if (contextSelectionResult) {
						console.log(
							`[UpdateTodoList] Context selection applied: ${contextSelectionResult.summary.substring(0, 100)}`,
						)
					} else {
						console.log(
							"[UpdateTodoList] Context selection returned no results (no turn files or nothing selected)",
						)
					}
				} catch (err) {
					console.warn("[UpdateTodoList] Context selection failed (non-critical):", err)
				}
			} else if (task.contextRefsPath) {
				try {
					contextSelectionResult = await refreshContextSelection(task, normalizedTodos)
					if (contextSelectionResult) {
						console.log(
							`[UpdateTodoList] Context selection refreshed: ${contextSelectionResult.summary.substring(0, 100)}`,
						)
					}
				} catch (err) {
					console.warn("[UpdateTodoList] Failed to refresh context selection (non-critical):", err)
				}
			}

			const previousActiveItem = task.todoList ? getActiveItem(task.todoList) : undefined
			const currentActiveItem = getActiveItem(normalizedTodos)
			const shouldEmitDivider =
				!!currentActiveItem &&
				!task.isRefineMode &&
				(task.postRefineDividerPending || currentActiveItem.id !== previousActiveItem?.id)

			if (currentActiveItem && shouldEmitDivider) {
				task.todoItemBoundaries.set(currentActiveItem.id, task.apiConversationHistory.length)
				task.postRefineDividerPending = false

				const dividerText = contextSelectionResult
					? JSON.stringify({
							content: currentActiveItem.content,
							todoItemId: currentActiveItem.id,
							summary: contextSelectionResult.summary,
							turns: contextSelectionResult.turns,
							contextSummaryText: contextSelectionResult.contextSummaryText,
						})
					: JSON.stringify({
							content: currentActiveItem.content,
							todoItemId: currentActiveItem.id,
						})

				await task.say("todo_item_divider", dividerText, undefined, undefined, undefined, undefined, {
					isNonInteractive: true,
				})
			}

			await setTodoListForTask(task, normalizedTodos)

			if (task.isRefineMode) {
				const unfinishedRefineTodoIds = normalizedTodos
					.filter((todo) => todo.status !== "completed")
					.map((todo) => todo.id)
				task.activeRefineTodoItemIds = unfinishedRefineTodoIds.length > 0 ? unfinishedRefineTodoIds : null
				await task.persistRefineResumeState(unfinishedRefineTodoIds)

				// Notify webview so it can switch from global to per-item refine indicators
				const provider = task.providerRef.deref()
				if (provider) {
					await provider.postMessageToWebview({
						type: "refineItemIdsUpdate",
						refiningTodoItemIds: unfinishedRefineTodoIds,
					})
				}
			} else {
				await task.clearRefineResumeState()
				await task.clearSubagentResumeState()
			}

			// Task lock: establishing a task unlocks all tools for subsequent API calls
			task.taskEstablished = true

			// Check if all todos are completed
			const allCompleted = normalizedTodos.length > 0 && normalizedTodos.every((t) => t.status === "completed")
			const completionHint =
				allCompleted && !task.isRefineMode
					? "\n\nAll tasks are now completed. If the user has given you a new request, call update_todo_list to create a new task list. Otherwise, call attempt_completion to present the final result."
					: ""
			const todosWithIds = todoListToMarkdown(normalizedTodos, true)

			if (isTodoListChanged) {
				const md = todoListToMarkdown(normalizedTodos)
				pushToolResult(
					formatResponse.toolResult(
						"User edits todo:\n\n" +
							md +
							"\n\nCurrent todo ids:\n" +
							todosWithIds +
							"\n\nUse the ids shown above for any follow-up tool calls that require a todo_item_id." +
							completionHint,
					),
				)
			} else {
				pushToolResult(
					formatResponse.toolResult(
						"Todo list updated successfully.\n\nCurrent todo ids:\n" +
							todosWithIds +
							"\n\nUse the ids shown above for any follow-up tool calls that require a todo_item_id." +
							completionHint,
					),
				)
			}
		} catch (error) {
			await handleError("update todo list", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"update_todo_list">): Promise<void> {
		const todosRaw = block.params.todos

		// Parse the markdown checklist to maintain consistent format with execute()
		let todos: TodoItem[]
		try {
			todos = parseMarkdownChecklist(todosRaw || "")
		} catch {
			// If parsing fails during partial, send empty array
			todos = []
		}

		const approvalMsg = JSON.stringify({
			tool: "updateTodoList",
			todos: todos,
		})
		await task.ask("tool", approvalMsg, block.partial).catch(() => {})
	}
}

export function addTodoToTask(cline: Task, content: string, status: TodoStatus = "pending", id?: string): TodoItem {
	const todo: TodoItem = {
		id: id ?? crypto.randomUUID(),
		content,
		status,
	}
	if (!cline.todoList) cline.todoList = []
	cline.todoList.push(todo)
	return todo
}

export function updateTodoStatusForTask(cline: Task, id: string, nextStatus: TodoStatus): boolean {
	if (!cline.todoList) return false
	const idx = cline.todoList.findIndex((t) => t.id === id)
	if (idx === -1) return false
	const current = cline.todoList[idx]
	if (
		(current.status === "pending" && nextStatus === "in_progress") ||
		(current.status === "in_progress" && nextStatus === "completed") ||
		current.status === nextStatus
	) {
		cline.todoList[idx] = { ...current, status: nextStatus }
		return true
	}
	return false
}

export function removeTodoFromTask(cline: Task, id: string): boolean {
	if (!cline.todoList) return false
	const idx = cline.todoList.findIndex((t) => t.id === id)
	if (idx === -1) return false
	cline.todoList.splice(idx, 1)
	return true
}

export function getTodoListForTask(cline: Task): TodoItem[] | undefined {
	return cline.todoList?.slice()
}

export async function setTodoListForTask(cline?: Task, todos?: TodoItem[]) {
	if (cline === undefined) return
	cline.todoList = Array.isArray(todos) ? todos : []
}

export function restoreTodoListForTask(cline: Task, todoList?: TodoItem[]) {
	if (todoList) {
		cline.todoList = Array.isArray(todoList) ? todoList : []
		return
	}
	cline.todoList = getLatestTodo(cline.clineMessages)
}

function todoListToMarkdown(todos: TodoItem[], includeIds = false): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return includeIds ? `${box} [${t.id}] ${t.content}` : `${box} ${t.content}`
		})
		.join("\n")
}

function normalizeStatus(status: string | undefined): TodoStatus {
	if (status === "completed") return "completed"
	if (status === "in_progress") return "in_progress"
	return "pending"
}

export function parseMarkdownChecklist(md: string): TodoItem[] {
	if (typeof md !== "string") return []
	const lines = md
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
	const todos: TodoItem[] = []
	const contentOccurrences = new Map<string, number>()
	for (const line of lines) {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) continue
		let status: TodoStatus = "pending"
		if (match[1] === "x" || match[1] === "X") status = "completed"
		else if (match[1] === "-" || match[1] === "~") status = "in_progress"
		const content = match[2]
		const occurrence = (contentOccurrences.get(content) ?? 0) + 1
		contentOccurrences.set(content, occurrence)
		const id = crypto.createHash("md5").update(`${content}#${occurrence}`).digest("hex")
		todos.push({
			id,
			content,
			status,
		})
	}
	return todos
}

export function setPendingTodoList(todos: TodoItem[]) {
	approvedTodoList = todos
}

function validateTodos(todos: any[]): { valid: boolean; error?: string } {
	if (!Array.isArray(todos)) return { valid: false, error: "todos must be an array" }
	for (const [i, t] of todos.entries()) {
		if (!t || typeof t !== "object") return { valid: false, error: `Item ${i + 1} is not an object` }
		if (!t.id || typeof t.id !== "string") return { valid: false, error: `Item ${i + 1} is missing id` }
		if (!t.content || typeof t.content !== "string")
			return { valid: false, error: `Item ${i + 1} is missing content` }
		if (t.status && !todoStatusSchema.options.includes(t.status as TodoStatus))
			return { valid: false, error: `Item ${i + 1} has invalid status` }
		if (t.context !== undefined && typeof t.context !== "string")
			return { valid: false, error: `Item ${i + 1} context must be a string` }
	}
	return { valid: true }
}

export const updateTodoListTool = new UpdateTodoListTool()
