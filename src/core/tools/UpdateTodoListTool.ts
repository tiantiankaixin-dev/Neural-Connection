import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import cloneDeep from "clone-deep"
import crypto from "crypto"
import { TodoItem, TodoStatus, todoStatusSchema } from "@roo-code/types"
import { getLatestTodo } from "../../shared/todo"
import { applyContextSelection, refreshContextSelection } from "../condense/context-selector"
import {
	buildPlanTargetStubContent,
	normalizePlanTargetStubEntry,
	savePlanFiles,
	type PlanTargetStubEntry,
	validatePlanTargetStubEntry,
} from "../task-persistence/plan-persistence"

interface UpdateTodoListPlanTargetParams {
	target?: string
	action?: PlanTargetStubEntry["action"]
}

interface UpdateTodoListParams {
	todos: string
	/** Refine mode only: one markdown string per checklist line (same order). */
	item_contexts?: string[]
	item_plan_targets?: UpdateTodoListPlanTargetParams[][]
}

let approvedTodoList: TodoItem[] | undefined = undefined

export class UpdateTodoListTool extends BaseTool<"update_todo_list"> {
	readonly name = "update_todo_list" as const

	async execute(params: UpdateTodoListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		console.log(
			`[UpdateTodoList.execute] ENTER isRefineMode=${task.isRefineMode}, step1Complete=${task.refineStep1Complete}`,
		)

		try {
			const todosRaw = params.todos

			let todos: TodoItem[]
			try {
				todos = parseMarkdownChecklist(todosRaw || "")
			} catch (parseErr) {
				console.log(`[UpdateTodoList.execute] EARLY RETURN: parse error`, parseErr)
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("The todos parameter is not valid markdown checklist or JSON"))
				return
			}

			const itemContexts = params.item_contexts
			const shouldEnsureTaskContexts = task.isRefineMode || itemContexts !== undefined
			if (itemContexts !== undefined) {
				if (!Array.isArray(itemContexts)) {
					console.log(
						`[UpdateTodoList.execute] EARLY RETURN: item_contexts not array, type=${typeof itemContexts}`,
					)
					task.consecutiveMistakeCount++
					task.recordToolError("update_todo_list")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("item_contexts must be an array of strings"))
					return
				}
				if (itemContexts.length !== todos.length) {
					console.warn(
						`[UpdateTodoList] item_contexts length mismatch; expected ${todos.length}, got ${itemContexts.length}. Missing contexts will be auto-created.`,
					)
				}
			}
			todos = applyTaskContextsToTodos(todos, itemContexts, shouldEnsureTaskContexts)

			const { valid, error } = validateTodos(todos)
			if (!valid) {
				console.log(`[UpdateTodoList.execute] EARLY RETURN: validateTodos failed: ${error}`)
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(error || "todos parameter validation failed"))
				return
			}

			let normalizedTodos: TodoItem[] = normalizeTodoItems(todos, shouldEnsureTaskContexts)
			let itemPlanTargetGroupsResult = normalizeItemPlanTargets(
				params.item_plan_targets,
				normalizedTodos,
				task.isRefineMode,
			)
			if (itemPlanTargetGroupsResult.error) {
				console.log(
					`[UpdateTodoList.execute] EARLY RETURN: normalizeItemPlanTargets error: ${itemPlanTargetGroupsResult.error}`,
				)
				const retryError = task.isRefineMode
					? formatItemPlanTargetsRetryError(itemPlanTargetGroupsResult.error, normalizedTodos)
					: itemPlanTargetGroupsResult.error
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list", retryError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(retryError))
				return
			}
			const refineCompletionError =
				"Refine mode cannot be completed by marking every todo item as completed. Rewrite the todo list into pending/in-progress architecture-based implementation groups, then call write_todo_plan for each item. Refine mode exits only after all required write_todo_plan calls are recorded."
			const isCompletingRefineTodoList = (candidateTodos: TodoItem[]) =>
				task.isRefineMode &&
				candidateTodos.length > 0 &&
				candidateTodos.every((todo) => todo.status === "completed")

			if (isCompletingRefineTodoList(normalizedTodos)) {
				console.log(`[UpdateTodoList.execute] EARLY RETURN: refine completion blocked (all todos completed)`)
				task.consecutiveMistakeCount++
				task.recordToolError("update_todo_list")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(refineCompletionError))
				return
			}

			const approvalMsg = JSON.stringify({
				tool: "updateTodoList",
				todos: normalizedTodos,
				planTargets: itemPlanTargetGroupsResult.groups,
			})

			approvedTodoList = cloneDeep(normalizedTodos)
			console.log(`[UpdateTodoList.execute] BEFORE askApproval, todoCount=${normalizedTodos.length}`)
			const didApprove = await askApproval("tool", approvalMsg)
			console.log(`[UpdateTodoList.execute] AFTER askApproval, didApprove=${didApprove}`)
			if (!didApprove) {
				pushToolResult("User declined to update the todoList.")
				return
			}

			const isTodoListChanged =
				approvedTodoList !== undefined && JSON.stringify(normalizedTodos) !== JSON.stringify(approvedTodoList)
			if (isTodoListChanged) {
				normalizedTodos = normalizeTodoItems(approvedTodoList ?? [], shouldEnsureTaskContexts)
				itemPlanTargetGroupsResult = normalizeItemPlanTargets(
					params.item_plan_targets,
					normalizedTodos,
					task.isRefineMode,
				)
				if (itemPlanTargetGroupsResult.error) {
					const retryError = task.isRefineMode
						? formatItemPlanTargetsRetryError(itemPlanTargetGroupsResult.error, normalizedTodos)
						: itemPlanTargetGroupsResult.error
					task.consecutiveMistakeCount++
					task.recordToolError("update_todo_list", retryError)
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(retryError))
					return
				}
				task.say(
					"user_edit_todos",
					JSON.stringify({
						tool: "updateTodoList",
						todos: normalizedTodos,
						planTargets: itemPlanTargetGroupsResult.groups,
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

			console.log(`[UpdateTodoList.execute] BEFORE setTodoListForTask, isRefineMode=${task.isRefineMode}`)
			await setTodoListForTask(task, normalizedTodos)
			let seededPlanTargets: Array<{ todo: TodoItem; targets: PlanTargetStubEntry[]; savedPaths: string[] }> = []
			if (task.isRefineMode) {
				try {
					seededPlanTargets = await savePlanTargetStubsForTodos(
						task,
						normalizedTodos,
						itemPlanTargetGroupsResult.groups,
					)
				} catch (err) {
					console.warn("[UpdateTodoList] savePlanTargetStubsForTodos failed (non-fatal):", err)
				}
			}

			if (task.isRefineMode) {
				const unfinishedRefineTodoIds = normalizedTodos
					.filter((todo) => todo.status !== "completed")
					.map((todo) => todo.id)
				task.activeRefineTodoItemIds = unfinishedRefineTodoIds.length > 0 ? unfinishedRefineTodoIds : null
				task.refineStep1Complete = true
				console.log(
					`[UpdateTodoList] refineStep1Complete SET to true, unfinishedIds=${JSON.stringify(unfinishedRefineTodoIds)}`,
				)
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
			const planTargetSkeletonHint =
				seededPlanTargets.length > 0
					? "\n\nSTEP 1 plan target skeletons recorded:\n" +
						seededPlanTargets
							.map(
								(entry) =>
									`- ${entry.todo.content}:\n${entry.targets.map((target) => `  - ${target.action} ${target.target}`).join("\n")}`,
							)
							.join("\n") +
						"\n\nIn STEP 2, call write_todo_plan for the current todo_item_id and fill these same targets with detailed plan bodies."
					: ""

			if (isTodoListChanged) {
				const md = todoListToMarkdown(normalizedTodos)
				pushToolResult(
					formatResponse.toolResult(
						"User edits todo:\n\n" +
							md +
							"\n\nCurrent todo ids:\n" +
							todosWithIds +
							"\n\nUse the ids shown above for any follow-up tool calls that require a todo_item_id." +
							planTargetSkeletonHint +
							completionHint,
					),
				)
			} else {
				pushToolResult(
					formatResponse.toolResult(
						"Todo list updated successfully.\n\nCurrent todo ids:\n" +
							todosWithIds +
							"\n\nUse the ids shown above for any follow-up tool calls that require a todo_item_id." +
							planTargetSkeletonHint +
							completionHint,
					),
				)
			}
		} catch (error) {
			console.log(`[UpdateTodoList.execute] OUTER CATCH error:`, error)
			await handleError("update todo list", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"update_todo_list">): Promise<void> {
		const todosRaw = block.params.todos
		const rawItemContexts = block.params.item_contexts
		const rawItemPlanTargets = block.params.item_plan_targets

		// Parse the markdown checklist to maintain consistent format with execute()
		let todos: TodoItem[]
		try {
			todos = parseMarkdownChecklist(todosRaw || "")
		} catch {
			// If parsing fails during partial, send empty array
			todos = []
		}
		const itemContexts = Array.isArray(rawItemContexts) ? rawItemContexts : undefined
		const shouldEnsureTaskContexts = task.isRefineMode || itemContexts !== undefined
		todos = normalizeTodoItems(
			applyTaskContextsToTodos(todos, itemContexts, shouldEnsureTaskContexts),
			shouldEnsureTaskContexts,
		)

		const approvalMsg = JSON.stringify({
			tool: "updateTodoList",
			todos: todos,
			planTargets: Array.isArray(rawItemPlanTargets) ? rawItemPlanTargets : undefined,
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

function applyTaskContextsToTodos(
	todos: TodoItem[],
	itemContexts: string[] | undefined,
	shouldEnsureTaskContexts: boolean,
): TodoItem[] {
	return todos.map((todo, index) => {
		const rawContext = itemContexts?.[index]
		const context =
			typeof rawContext === "string" && rawContext.trim().length > 0 ? rawContext.trim() : todo.context
		if (context?.trim()) {
			return { ...todo, context: context.trim() }
		}
		if (!shouldEnsureTaskContexts) {
			return { ...todo }
		}
		return { ...todo, context: buildDefaultTaskContext(todo) }
	})
}

function normalizeTodoItems(todos: TodoItem[], shouldEnsureTaskContexts: boolean): TodoItem[] {
	return todos.map((todo) => {
		const normalized: TodoItem = {
			id: todo.id,
			content: todo.content,
			status: normalizeStatus(todo.status),
		}
		const context = todo.context?.trim()
		if (context) {
			normalized.context = context
		} else if (shouldEnsureTaskContexts) {
			normalized.context = buildDefaultTaskContext(normalized)
		}
		return normalized
	})
}

function buildDefaultTaskContext(todo: TodoItem): string {
	return [
		"## Task Context",
		`- Assigned implementation unit: ${todo.content}`,
		"- Scope: Implement only the files, modules, and behavior explicitly owned by this todo item.",
		"- Boundaries: Do not assume access to sibling todo contexts or plans.",
		"- Coordination: Preserve file ownership boundaries and follow any concrete file paths, APIs, routes, types, storage keys, or environment keys named in this todo item.",
	].join("\n")
}

function normalizePlanTargetKey(target: string): string {
	return target.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase()
}

function formatItemPlanTargetsRetryError(error: string, todos: TodoItem[]): string {
	const todoShape = todos
		.map((todo, index) => {
			const status =
				todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending"
			return `${index}: ${status} — ${todo.content}`
		})
		.join("\n")
	return [
		"RETRY REFINE STEP 1: `update_todo_list` failed because `item_plan_targets` is missing or invalid.",
		"",
		`Validation error: ${error}`,
		"",
		"Next action: Retry exactly one `update_todo_list` call. Do not call `write_todo_plan`, `attempt_completion`, or any implementation tool before this succeeds.",
		"",
		"The retry call MUST include all three top-level arguments:",
		"1. `todos`: full replacement markdown checklist with architecture/subsystem classification groups.",
		'2. `item_contexts`: array aligned 1:1 with `todos`; every active/pending item starts with "## Task Context".',
		'3. `item_plan_targets`: array aligned 1:1 with `todos`; every active/pending item has a non-empty inner array of `{ "target": "relative/project/path.ext", "action": "CREATE|MODIFY|DELETE" }` objects.',
		"",
		"Before retrying, extract exact files from the previous task list, existing contexts, conversation requirements, and known codebase context; classify those files by architecture/subsystem ownership; then put each classified file group into the matching `item_plan_targets` inner array.",
		"",
		"Current attempted todo rows that require aligned `item_contexts` and `item_plan_targets`:",
		todoShape || "(no todo rows parsed)",
	].join("\n")
}

function normalizeItemPlanTargets(
	rawItemPlanTargets: UpdateTodoListPlanTargetParams[][] | undefined,
	todos: TodoItem[],
	required: boolean,
): { groups: PlanTargetStubEntry[][]; error?: string } {
	if (rawItemPlanTargets === undefined) {
		if (required) {
			return {
				groups: [],
				error: "item_plan_targets is required in refine mode and must be aligned 1:1 with todos.",
			}
		}
		return { groups: todos.map(() => []) }
	}

	if (!Array.isArray(rawItemPlanTargets)) {
		return { groups: [], error: "item_plan_targets must be an array of arrays" }
	}

	if (rawItemPlanTargets.length !== todos.length) {
		return {
			groups: [],
			error: `item_plan_targets length must match todos length. Expected ${todos.length}, got ${rawItemPlanTargets.length}.`,
		}
	}

	const groups: PlanTargetStubEntry[][] = []
	const targetOwners = new Map<string, number>()

	for (const [todoIndex, rawGroup] of rawItemPlanTargets.entries()) {
		if (!Array.isArray(rawGroup)) {
			return { groups: [], error: `item_plan_targets[${todoIndex}] must be an array` }
		}

		const group: PlanTargetStubEntry[] = []
		const seenInGroup = new Set<string>()
		for (const [targetIndex, rawTarget] of rawGroup.entries()) {
			const normalized = normalizePlanTargetStubEntry(rawTarget)
			const validationError = validatePlanTargetStubEntry(normalized)
			if (validationError) {
				return { groups: [], error: `item_plan_targets[${todoIndex}][${targetIndex}]: ${validationError}` }
			}

			const targetKey = normalizePlanTargetKey(normalized.target)
			if (seenInGroup.has(targetKey)) {
				continue
			}
			seenInGroup.add(targetKey)

			if (todos[todoIndex]?.status !== "completed") {
				const existingOwner = targetOwners.get(targetKey)
				if (existingOwner !== undefined && existingOwner !== todoIndex) {
					return {
						groups: [],
						error: `File target "${normalized.target}" appears in multiple unfinished todo item plan target groups. Each file target must be owned by exactly one unfinished todo item.`,
					}
				}
				targetOwners.set(targetKey, todoIndex)
			}

			group.push(normalized)
		}
		if (required && todos[todoIndex]?.status !== "completed" && group.length === 0) {
			return {
				groups: [],
				error: `item_plan_targets[${todoIndex}] must contain at least one exact file target for active or pending todo "${todos[todoIndex]?.content ?? todoIndex}". Refine STEP 1 must extract and classify files before updating the todo list.`,
			}
		}
		groups.push(group)
	}

	return { groups }
}

async function savePlanTargetStubsForTodos(
	task: Task,
	todos: TodoItem[],
	groups: PlanTargetStubEntry[][],
): Promise<Array<{ todo: TodoItem; targets: PlanTargetStubEntry[]; savedPaths: string[] }>> {
	const seeded: Array<{ todo: TodoItem; targets: PlanTargetStubEntry[]; savedPaths: string[] }> = []

	for (const [index, todo] of todos.entries()) {
		if (todo.status === "completed") {
			continue
		}
		const targets = groups[index] ?? []
		if (targets.length === 0) {
			continue
		}

		const { savedPaths } = await savePlanFiles(
			task.globalStoragePath,
			task.taskId,
			task.taskTimestamp,
			todo.id,
			todo.content,
			targets.map((target) => ({
				filePath: target.target,
				content: buildPlanTargetStubContent(target),
			})),
			"file",
			todo.context,
		)

		seeded.push({ todo, targets, savedPaths })
	}

	return seeded
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
