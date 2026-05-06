import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import type { TodoItem } from "@roo-code/types"
import {
	buildPlanEntryContent,
	normalizeStructuredPlanEntry,
	readPlanFiles,
	savePlanFiles,
	type PlanFile,
	type PlanType,
	type StructuredPlanEntry,
	validateStructuredPlanEntry,
} from "../task-persistence/plan-persistence"

interface WriteTodoPlanParams {
	todo_item_id: string
	plan_type: PlanType
	plans: StructuredPlanEntry[]
}

const PROJECT_FILE_TARGET_PATTERN =
	/(?:^|[\s:：,，;；()[\]{}"'`])((?:\.\/)?[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)+\.[A-Za-z0-9_-]{1,12})(?=$|[\s,，;；)）\]】}>"'`])/g

function normalizeTargetForComparison(value: string): string {
	return value
		.trim()
		.replace(/^`|`$/g, "")
		.replace(/^["']|["']$/g, "")
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/")
		.toLowerCase()
}

function collectExpectedFileTargets(todoItem: TodoItem): string[] {
	const targets = new Set<string>()
	const text = todoItem.content ?? ""
	for (const match of text.matchAll(PROJECT_FILE_TARGET_PATTERN)) {
		const target = normalizeTargetForComparison(match[1])
		if (target) {
			targets.add(target)
		}
	}
	return [...targets]
}

function inferPlanCompletion(
	planType: PlanType,
	todoItem: TodoItem,
	savedPlans: PlanFile[],
	stubPlans: PlanFile[] = [],
): { isComplete: boolean; expectedTargets: string[]; missingTargets: string[] } {
	if (planType === "general") {
		return { isComplete: savedPlans.length > 0, expectedTargets: [], missingTargets: [] }
	}

	const expectedTargetsFromStubs = [
		...new Set(stubPlans.map((plan) => normalizeTargetForComparison(plan.filePath)).filter(Boolean)),
	]
	const expectedTargets =
		expectedTargetsFromStubs.length > 0 ? expectedTargetsFromStubs : collectExpectedFileTargets(todoItem)
	if (expectedTargets.length === 0) {
		return { isComplete: savedPlans.length > 0, expectedTargets: [], missingTargets: [] }
	}

	const savedTargets = new Set(savedPlans.map((plan) => normalizeTargetForComparison(plan.filePath)))
	const missingTargets = expectedTargets.filter((target) => !savedTargets.has(target))
	return { isComplete: missingTargets.length === 0, expectedTargets, missingTargets }
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

			const activeIds = task.activeRefineTodoItemIds ?? []
			if (activeIds.length > 0 && activeIds[0] !== todo_item_id) {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`write_todo_plan must continue the current active refine todo item first. Expected todo_item_id "${activeIds[0]}", but received "${todo_item_id}". Do not skip ahead; finish the current todo's remaining plan batch and STEP 3 before moving to the next todo.`,
					),
				)
				return
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

			const planReadResult = await readPlanFiles(
				task.globalStoragePath,
				task.taskId,
				task.taskTimestamp,
				todo_item_id,
				todoItem.content,
			)
			const completion = inferPlanCompletion(planType, todoItem, planReadResult.plans, planReadResult.stubPlans)
			const emitRefineResult = async (stage: "step2" | "step3", isComplete: boolean, replacePlans = false) => {
				const latestTodoItem = task.todoList?.find((todo) => todo.id === todo_item_id) ?? todoItem
				const plansForDisplay = task.applyTaskContextAgreementsToPlanEntries(
					normalizedPlanEntries,
					latestTodoItem.context,
				).plans

				await task.say(
					"refine_result",
					JSON.stringify({
						todoItemId: todo_item_id,
						todoContent: latestTodoItem.content,
						savedPath: savedPaths[0],
						savedPaths,
						planType,
						stage,
						replacePlans,
						isComplete,
						missingTargets: completion.missingTargets,
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
			}

			await emitRefineResult("step2", false)

			const agreementPass = await task.enqueuePostRefineAgreementPass(todoItem, normalizedPlanEntries)
			const agreementPassFailed = agreementPass.error || !agreementPass.executed
			const isComplete = !agreementPassFailed && completion.isComplete

			if (agreementPassFailed) {
				const activeIds = task.activeRefineTodoItemIds
				if (!activeIds || activeIds.length === 0) {
					task.activeRefineTodoItemIds = [todo_item_id]
					await task.persistRefineResumeState([todo_item_id])
				} else {
					await task.persistRefineResumeState(
						activeIds.includes(todo_item_id) ? activeIds : [todo_item_id, ...activeIds],
					)
				}
				task.isRefineMode = true
			} else if (completion.isComplete) {
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
			} else {
				const activeIds = task.activeRefineTodoItemIds
				if (!activeIds || activeIds.length === 0) {
					task.activeRefineTodoItemIds = [todo_item_id]
					await task.persistRefineResumeState([todo_item_id])
				} else {
					await task.persistRefineResumeState(activeIds)
				}
				task.isRefineMode = true
			}

			const allPlansWritten = isComplete && !task.isRefineMode
			await emitRefineResult("step3", isComplete, true)

			const label = planType === "general" ? "general plan section(s)" : "plan file(s)"
			const fileList = normalizedPlanEntries.map((e) => `  - ${e.filePath}`).join("\n")
			const savedPathList = savedPaths.map((p) => `  - ${p}`).join("\n")
			const step3FailureMessage = agreementPass.error
				? `STEP 3 agreement pass failed after writing the plan for "${todoItem.content}": ${agreementPass.error}`
				: !agreementPass.executed
					? `STEP 3 agreement pass did not run after writing the plan for "${todoItem.content}": ${agreementPass.skippedReason ?? "unknown reason"}`
					: undefined
			const missingTargetList = completion.missingTargets.map((target) => `  - ${target}`).join("\n")

			pushToolResult(
				formatResponse.toolResult(
					`Successfully wrote ${normalizedPlanEntries.length} ${label} for todo item "${todoItem.content}":\n${fileList}\n\nSaved plan files:\n${savedPathList}\n\nThese plans will be automatically injected into context when working on this todo item.${
						step3FailureMessage
							? `\n\n[STEP 3 FAILED AFTER PLAN SAVE]\n${step3FailureMessage}\n\nThe plan batch has already been recorded. Do NOT call write_todo_plan again just to repeat the same plan content; wait for the provider/API issue to recover or ask the user before retrying agreement extraction. Refine mode remains active and parallel execution will not start until STEP 3 succeeds for the final plan batch.`
							: isComplete
								? allPlansWritten
									? "\n\n[ALL PLANS RECORDED — Launching parallel execution...]"
									: "\n\n[TODO PLAN COMPLETE — Continue with the next refine todo item.]"
								: `\n\n[PLAN BATCH RECORDED — Continue the same refine todo item.]${
										missingTargetList
											? `\nRemaining expected plan target(s) for this todo:\n${missingTargetList}`
											: "\nThe system could not infer all expected file targets from the todo text, so continue this same todo only if more plan entries are still needed."
									}`
					}`,
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
