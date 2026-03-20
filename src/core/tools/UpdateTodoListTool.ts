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
			}))

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

			// Track the "active item" — the item currently being worked on.
			// Active = first in_progress item, or if none, first pending item.
			// Emit a divider whenever the active item changes, INCLUDING the
			// very first update_todo_list call. This ensures:
			//   1. First item gets a border immediately when todo list is created
			//   2. Each item gets its own separate bordered box
			//   3. Works regardless of whether AI uses [-] or skips to [x]
			const getActiveContent = (todos: { content: string; status: string }[]): string | undefined => {
				const item = todos.find((t) => t.status === "in_progress") || todos.find((t) => t.status === "pending")
				return item?.content
			}

			// Context selection: if this is the first todo list creation and no context selection
			// has been done yet, trigger selection now (scans existing turn files, asks condensing
			// model to pick relevant turns, replaces old history with selected context blocks).
			// If Phase 1 already ran (contextRefsPath set), just load the existing result for UI.
			let contextSelectionResult: import("../condense/context-selector").ContextSelectionResult | undefined
			if (!task.taskEstablished && !task.contextRefsPath) {
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

			const previousActiveContent = task.todoList ? getActiveContent(task.todoList) : undefined
			const currentActiveContent = getActiveContent(normalizedTodos)
			const currentActiveItem = normalizedTodos.find((t) => t.content === currentActiveContent)

			if (currentActiveItem && currentActiveContent !== previousActiveContent) {
				task.todoItemBoundaries.set(currentActiveItem.id, task.apiConversationHistory.length)

				const dividerText = contextSelectionResult
					? JSON.stringify({
							content: currentActiveItem.content,
							summary: contextSelectionResult.summary,
							turns: contextSelectionResult.turns,
							contextSummaryText: contextSelectionResult.contextSummaryText,
						})
					: currentActiveItem.content

				await task.say("todo_item_divider", dividerText, undefined, undefined, undefined, undefined, {
					isNonInteractive: true,
				})
			}

			await setTodoListForTask(task, normalizedTodos)

			// Task lock: establishing a task unlocks all tools for subsequent API calls
			task.taskEstablished = true

			// Check if all todos are completed
			const allCompleted = normalizedTodos.length > 0 && normalizedTodos.every((t) => t.status === "completed")
			const completionHint = allCompleted
				? "\n\nAll tasks are now completed. If the user has given you a new request, call update_todo_list to create a new task list. Otherwise, call attempt_completion to present the final result."
				: ""

			if (isTodoListChanged) {
				const md = todoListToMarkdown(normalizedTodos)
				pushToolResult(formatResponse.toolResult("User edits todo:\n\n" + md + completionHint))
			} else {
				pushToolResult(formatResponse.toolResult("Todo list updated successfully." + completionHint))
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

function todoListToMarkdown(todos: TodoItem[]): string {
	return todos
		.map((t) => {
			let box = "[ ]"
			if (t.status === "completed") box = "[x]"
			else if (t.status === "in_progress") box = "[-]"
			return `${box} ${t.content}`
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
	for (const line of lines) {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) continue
		let status: TodoStatus = "pending"
		if (match[1] === "x" || match[1] === "X") status = "completed"
		else if (match[1] === "-" || match[1] === "~") status = "in_progress"
		const id = crypto
			.createHash("md5")
			.update(match[2] + status)
			.digest("hex")
		todos.push({
			id,
			content: match[2],
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
	}
	return { valid: true }
}

export const updateTodoListTool = new UpdateTodoListTool()
