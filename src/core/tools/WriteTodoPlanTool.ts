import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { savePlanFiles, type PlanType } from "../task-persistence/plan-persistence"

interface WriteTodoPlanParams {
	todo_item_id: string
	plan_type?: string
	plans: string
}

interface PlanEntry {
	filePath: string
	content: string
}

export class WriteTodoPlanTool extends BaseTool<"write_todo_plan"> {
	readonly name = "write_todo_plan" as const

	async execute(params: WriteTodoPlanParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks

		try {
			const { todo_item_id, plan_type: planTypeRaw, plans: plansRaw } = params
			const planType: PlanType = planTypeRaw === "general" ? "general" : "file"

			if (!todo_item_id || typeof todo_item_id !== "string") {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("todo_item_id parameter is required and must be a string"))
				return
			}

			// Validate the todo item exists
			const todoItem = task.todoList?.find((t) => t.id === todo_item_id)
			if (!todoItem) {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Todo item with id "${todo_item_id}" not found. Available ids: ${(task.todoList ?? []).map((t) => t.id).join(", ")}`,
					),
				)
				return
			}

			// Parse plans JSON
			let planEntries: PlanEntry[]
			try {
				planEntries = JSON.parse(plansRaw || "[]")
			} catch {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("The plans parameter is not valid JSON"))
				return
			}

			if (!Array.isArray(planEntries) || planEntries.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("plans must be a non-empty JSON array"))
				return
			}

			// Validate each plan entry
			for (const [i, entry] of planEntries.entries()) {
				if (!entry.filePath || typeof entry.filePath !== "string") {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(`Plan entry ${i + 1} is missing a valid filePath`))
					return
				}
				if (!entry.content || typeof entry.content !== "string") {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(`Plan entry ${i + 1} is missing content`))
					return
				}
			}

			// Auto-approved: this tool only writes internal plan files (.md),
			// it does not modify actual project source code.

			// Save all plan entries into a single .md file
			const savedPath = await savePlanFiles(
				task.globalStoragePath,
				task.taskId,
				task.taskTimestamp,
				todo_item_id,
				todoItem.content,
				planEntries,
				planType,
			)

			task.consecutiveMistakeCount = 0

			if (task.activeRefineTodoItemIds) {
				const remainingTodoItemIds = task.activeRefineTodoItemIds.filter((id) => id !== todo_item_id)
				task.activeRefineTodoItemIds = remainingTodoItemIds.length > 0 ? remainingTodoItemIds : null
				task.isRefineMode = remainingTodoItemIds.length > 0
			} else {
				// Fallback for unexpected single-item refine flows
				task.isRefineMode = false
			}

			// Emit refine_result say message so the UI can show a collapsible plan block
			await task.say(
				"refine_result",
				JSON.stringify({
					todoItemId: todo_item_id,
					todoContent: todoItem.content,
					savedPath,
					planType,
					plans: planEntries.map((e) => ({ filePath: e.filePath, content: e.content })),
				}),
				undefined,
				undefined,
				undefined,
				undefined,
				{ isNonInteractive: true },
			)

			const label = planType === "general" ? "general plan section(s)" : "plan file(s)"
			const fileList = planEntries.map((e) => `  - ${e.filePath}`).join("\n")
			pushToolResult(
				formatResponse.toolResult(
					`Successfully wrote ${planEntries.length} ${label} for todo item "${todoItem.content}":\n${fileList}\n\nThese plans will be automatically injected into context when working on this todo item.`,
				),
			)
		} catch (error) {
			await handleError("write todo plan", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_todo_plan">): Promise<void> {
		const todoItemId = block.params.todo_item_id
		let plansPreview: PlanEntry[] = []
		try {
			plansPreview = JSON.parse(block.params.plans || "[]")
		} catch {
			plansPreview = []
		}

		const previewMsg = JSON.stringify({
			tool: "writeTodoPlan",
			todoItemId,
			files: plansPreview.map((e: PlanEntry) => e.filePath).filter(Boolean),
		})
		await task.say("tool", previewMsg, undefined, block.partial).catch(() => {})
	}
}

export const writeTodoPlanTool = new WriteTodoPlanTool()
