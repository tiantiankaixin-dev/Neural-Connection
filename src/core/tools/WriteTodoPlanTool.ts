import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import {
	buildPlanEntryContent,
	normalizeStructuredPlanEntry,
	savePlanFiles,
	type PlanType,
	type StructuredPlanEntry,
	validateStructuredPlanEntry,
} from "../task-persistence/plan-persistence"

interface WriteTodoPlanParams {
	todo_item_id: string
	plan_type: PlanType
	plans: StructuredPlanEntry[]
}

export class WriteTodoPlanTool extends BaseTool<"write_todo_plan"> {
	readonly name = "write_todo_plan" as const

	async execute(params: WriteTodoPlanParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		try {
			const { todo_item_id, plan_type: planType, plans } = params

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

			const taskContext = todoItem.context?.trim() ?? ""

			if (planType !== "file" && planType !== "general") {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError('plan_type must be exactly "file" or "general"'))
				return
			}

			if (!Array.isArray(plans) || plans.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("plans must be a non-empty array"))
				return
			}

			if (!task.isRefineMode && !task.activeRefineTodoItemIds) {
				const restored = await task.restoreRefineModeFromResumeState()
				if (!restored) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					await task.clearRefineResumeState()
					pushToolResult(
						formatResponse.toolError("write_todo_plan is only available while refine mode is active"),
					)
					return
				}
			}

			const normalizedStructuredEntries = plans.map((entry) => normalizeStructuredPlanEntry(planType, entry))

			for (const [i, entry] of normalizedStructuredEntries.entries()) {
				if (!entry.target || typeof entry.target !== "string") {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(`Plan entry ${i + 1} is missing a valid target`))
					return
				}
				if (!entry.body || typeof entry.body !== "string") {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(`Plan entry ${i + 1} is missing body`))
					return
				}

				const validationError = validateStructuredPlanEntry(entry, planType)
				if (validationError) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError(validationError))
					return
				}
			}

			const normalizedPlanEntries = normalizedStructuredEntries.map((entry) => ({
				filePath: entry.target,
				content: buildPlanEntryContent(entry),
			}))

			// Auto-approved: this tool only writes internal plan files (.md),
			// it does not modify actual project source code.

			const { savedPaths } = await savePlanFiles(
				task.globalStoragePath,
				task.taskId,
				task.taskTimestamp,
				todo_item_id,
				todoItem.content,
				normalizedPlanEntries,
				planType,
				taskContext,
			)

			task.consecutiveMistakeCount = 0

			if (task.activeRefineTodoItemIds) {
				const remainingTodoItemIds = task.activeRefineTodoItemIds.filter((id) => id !== todo_item_id)
				task.activeRefineTodoItemIds = remainingTodoItemIds.length > 0 ? remainingTodoItemIds : null
				task.isRefineMode = remainingTodoItemIds.length > 0
				await task.persistRefineResumeState(remainingTodoItemIds)
				if (remainingTodoItemIds.length === 0) {
					task.postRefineDividerPending = true
				}
			} else {
				// Fallback for unexpected single-item refine flows
				task.isRefineMode = false
				task.postRefineDividerPending = true
				await task.persistRefineResumeState([])
			}

			const allPlansWritten = !task.isRefineMode
			await task.enqueuePostRefineAgreementPass(todoItem, normalizedPlanEntries)
			const latestTodoItem = task.todoList?.find((todo) => todo.id === todo_item_id) ?? todoItem
			const plansForDisplay = task.applyTaskContextAgreementsToPlanEntries(
				normalizedPlanEntries,
				latestTodoItem.context,
			).plans

			// Emit refine_result say message so the UI can show a collapsible plan block
			await task.say(
				"refine_result",
				JSON.stringify({
					todoItemId: todo_item_id,
					todoContent: latestTodoItem.content,
					savedPath: savedPaths[0],
					savedPaths,
					planType,
					context: latestTodoItem.context?.trim() || "",
					plans: plansForDisplay.map((e, index) => ({
						filePath: e.filePath,
						content: e.content,
						target: normalizedStructuredEntries[index]?.target,
						action: normalizedStructuredEntries[index]?.action,
						body: normalizedStructuredEntries[index]?.body,
					})),
				}),
				undefined,
				undefined,
				undefined,
				undefined,
				{ isNonInteractive: true },
			)

			const label = planType === "general" ? "general plan section(s)" : "plan file(s)"
			const fileList = normalizedPlanEntries.map((e) => `  - ${e.filePath}`).join("\n")
			const savedPathList = savedPaths.map((p) => `  - ${p}`).join("\n")

			pushToolResult(
				formatResponse.toolResult(
					`Successfully wrote ${normalizedPlanEntries.length} ${label} for todo item "${todoItem.content}":\n${fileList}\n\nSaved plan files:\n${savedPathList}\n\nThese plans will be automatically injected into context when working on this todo item.${allPlansWritten ? "\n\n[ALL PLANS RECORDED — Launching parallel execution...]" : ""}`,
				),
			)

			// When all plans are written (refine mode exited), signal the main loop to exit
			// so that initiateTaskLoop can launch parallel subagents without interference.
			if (allPlansWritten) {
				await task.clearSubagentResumeState()
				await task.persistSubagentResumeState(
					(task.todoList ?? []).map((todo) => todo.id),
					[],
				)
				task.subagentsPending = true
			}
		} catch (error) {
			await handleError("write todo plan", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_todo_plan">): Promise<void> {
		const todoItemId = block.params.todo_item_id
		const plansPreview = Array.isArray(block.params.plans) ? block.params.plans : []

		const previewMsg = JSON.stringify({
			tool: "writeTodoPlan",
			todoItemId,
			files: plansPreview.map((e: StructuredPlanEntry) => e.target).filter(Boolean),
		})
		await task.say("tool", previewMsg, undefined, block.partial).catch(() => {})
	}
}

export const writeTodoPlanTool = new WriteTodoPlanTool()
