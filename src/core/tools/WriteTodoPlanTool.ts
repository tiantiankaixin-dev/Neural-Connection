import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import type { TodoItem } from "@roo-code/types"
import {
	buildPlanEntryContent,
	normalizeStructuredPlanEntry,
	parsePlanTargetHeader,
	readPlanFiles,
	savePlanFiles,
	type PlanFile,
	type PlanReadResult,
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

function stripPlanTargetHeader(content: string): string {
	const stripped = content.replace(
		/^<<<PLAN_TARGET>>>\r?\nACTION: .*\r?\nPATH: .*\r?\n<<<END_PLAN_TARGET>>>(?:\r?\n)*/,
		"",
	)

	return stripped.trim() || content
}

function formatPlanForDisplay(plan: PlanFile) {
	const parsedHeader = parsePlanTargetHeader(plan.content)
	const target = parsedHeader?.path ?? plan.filePath

	return {
		filePath: target,
		content: plan.content,
		target,
		action: parsedHeader?.action,
		body: stripPlanTargetHeader(plan.content),
	}
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

function inferPlanTypeFromReadResult(readResult: PlanReadResult, fallback: PlanType): PlanType {
	if (readResult.plans.length === 0) {
		return fallback
	}
	return readResult.plans.every((plan) => parsePlanTargetHeader(plan.content)?.action === "GENERAL")
		? "general"
		: "file"
}

async function emitRefineResultForPlanRead(
	task: Task,
	todoItem: TodoItem,
	todoItemId: string,
	readResult: PlanReadResult,
	savedPaths: string[],
	planType: PlanType,
	stage: "step2" | "step3",
	isComplete: boolean,
	missingTargets: string[],
	replacePlans = false,
): Promise<void> {
	const latestTodoItem = task.todoList?.find((todo) => todo.id === todoItemId) ?? todoItem
	const plansForDisplay = task.applyTaskContextAgreementsToPlanEntries(readResult.plans, latestTodoItem.context).plans

	await task.say(
		"refine_result",
		JSON.stringify({
			todoItemId,
			todoContent: latestTodoItem.content,
			savedPath: savedPaths[0],
			savedPaths,
			planType,
			stage,
			replacePlans,
			isComplete,
			missingTargets,
			context: latestTodoItem.context?.trim() || "",
			plans: plansForDisplay.map(formatPlanForDisplay),
		}),
		undefined,
		undefined,
		undefined,
		undefined,
		{ isNonInteractive: true },
	)
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

			if (task.pendingRefineStep3RetryTodoItemId) {
				if (task.pendingRefineStep3RetryTodoItemId !== todo_item_id) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`STEP 3 must be retried for the current refine todo item before any other todo can proceed. Expected todo_item_id "${task.pendingRefineStep3RetryTodoItemId}", but received "${todo_item_id}". Retry STEP 3 by calling write_todo_plan again for the expected todo_item_id; the saved plan batch will be reused and no new plan should be created.`,
						),
					)
					return
				}

				const retryPlanReadResult = await readPlanFiles(
					task.globalStoragePath,
					task.taskId,
					task.taskTimestamp,
					todo_item_id,
					todoItem.content,
				)
				if (retryPlanReadResult.plans.length === 0) {
					task.pendingRefineStep3RetryTodoItemId = null
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`STEP 3 retry was requested for todo item "${todoItem.content}", but no saved plan entries were found. Re-run STEP 2 for this same todo_item_id with the required plan entries before moving to any other todo.`,
						),
					)
					return
				}

				const retryPlanType = inferPlanTypeFromReadResult(retryPlanReadResult, planType)
				const retryCompletion = inferPlanCompletion(
					retryPlanType,
					todoItem,
					retryPlanReadResult.plans,
					retryPlanReadResult.stubPlans,
				)
				const retryAgreementPass = await task.enqueuePostRefineAgreementPass(
					todoItem,
					retryPlanReadResult.plans,
				)
				const retryAgreementPassFailed = retryAgreementPass.error || !retryAgreementPass.executed
				const retryIsComplete = !retryAgreementPassFailed && retryCompletion.isComplete

				if (retryAgreementPassFailed) {
					task.pendingRefineStep3RetryTodoItemId = todo_item_id
					task.activeRefineTodoItemIds = activeIds.length > 0 ? activeIds : [todo_item_id]
					task.isRefineMode = true
					await task.persistRefineResumeState(task.activeRefineTodoItemIds)
				} else {
					task.pendingRefineStep3RetryTodoItemId = null
					if (retryCompletion.isComplete) {
						if (task.activeRefineTodoItemIds) {
							const remainingTodoItemIds = task.activeRefineTodoItemIds.filter(
								(id) => id !== todo_item_id,
							)
							task.activeRefineTodoItemIds = remainingTodoItemIds.length > 0 ? remainingTodoItemIds : null
							task.isRefineMode = remainingTodoItemIds.length > 0
							await task.persistRefineResumeState(remainingTodoItemIds)
							if (remainingTodoItemIds.length === 0) {
								task.postRefineDividerPending = true
							}
						} else {
							task.isRefineMode = false
							task.postRefineDividerPending = true
							await task.persistRefineResumeState([])
						}
					} else {
						task.activeRefineTodoItemIds = activeIds.length > 0 ? activeIds : [todo_item_id]
						task.isRefineMode = true
						await task.persistRefineResumeState(task.activeRefineTodoItemIds)
					}
				}

				const step3RetryPlanReadResult = await readPlanFiles(
					task.globalStoragePath,
					task.taskId,
					task.taskTimestamp,
					todo_item_id,
					todoItem.content,
				)
				await emitRefineResultForPlanRead(
					task,
					todoItem,
					todo_item_id,
					step3RetryPlanReadResult,
					[],
					retryPlanType,
					"step3",
					retryIsComplete,
					retryCompletion.missingTargets,
					true,
				)

				const retryFailureMessage = retryAgreementPass.error
					? `STEP 3 agreement pass retry failed for "${todoItem.content}": ${retryAgreementPass.error}`
					: !retryAgreementPass.executed
						? `STEP 3 agreement pass retry did not run for "${todoItem.content}": ${retryAgreementPass.skippedReason ?? "unknown reason"}`
						: undefined
				const allPlansWritten = retryIsComplete && !task.isRefineMode
				if (retryFailureMessage) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan", retryFailureMessage)
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`[STEP 3 RETRY FAILED]\n${retryFailureMessage}\n\nDo not move to another todo item. The next action must be another write_todo_plan call for the same todo_item_id "${todo_item_id}" to retry STEP 3 against the already saved plans. Do not add new plan content unless the saved plans are missing.`,
						),
					)
				} else {
					const missingTargetList = retryCompletion.missingTargets.map((target) => `  - ${target}`).join("\n")
					const retrySuccessMessage = `STEP 3 retry succeeded for todo item "${todoItem.content}" using the already saved plans.${
						retryIsComplete
							? allPlansWritten
								? "\n\n[ALL PLANS RECORDED — Launching parallel execution...]"
								: "\n\n[TODO PLAN COMPLETE — Continue with the next refine todo item.]"
							: `\n\n[STEP 3 RETRY COMPLETE — Continue the same refine todo item.]${
									missingTargetList
										? `\nRemaining expected plan target(s) for this todo:\n${missingTargetList}\n\nNext action: call write_todo_plan again for the SAME todo_item_id and cover only these remaining targets.`
										: ""
								}`
					}`
					pushToolResult(formatResponse.toolResult(retrySuccessMessage))
				}

				if (allPlansWritten) {
					await task.clearSubagentResumeState()
					await task.persistSubagentResumeState(
						(task.todoList ?? []).map((todo) => todo.id),
						[],
					)
					task.subagentsPending = true
				}
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

			const existingPlanReadResult = await readPlanFiles(
				task.globalStoragePath,
				task.taskId,
				task.taskTimestamp,
				todo_item_id,
				todoItem.content,
			)
			const expectedTargetsByKey = new Map<string, { target: string; action?: string }>()
			for (const stubPlan of existingPlanReadResult.stubPlans) {
				const parsedHeader = parsePlanTargetHeader(stubPlan.content)
				const target = parsedHeader?.path ?? stubPlan.filePath
				const key = normalizeTargetForComparison(target)
				if (key) {
					expectedTargetsByKey.set(key, { target, action: parsedHeader?.action })
				}
			}
			if (expectedTargetsByKey.size > 0) {
				const expectedTargetList = [...expectedTargetsByKey.values()]
					.map((entry) => `  - ${entry.action ? `${entry.action} ` : ""}${entry.target}`)
					.join("\n")
				if (planType !== "file") {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`STEP 2 must fill the current todo item's STEP 1 file targets with plan_type="file"; it cannot create a general plan for this todo.\n\nAllowed STEP 1 targets:\n${expectedTargetList}`,
						),
					)
					return
				}

				const invalidTargets = normalizedStructuredEntries.filter(
					(entry) => !expectedTargetsByKey.has(normalizeTargetForComparison(entry.target)),
				)
				if (invalidTargets.length > 0) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`STEP 2 cannot create new plan targets. Every write_todo_plan plans[].target must exactly match one STEP 1 item_plan_targets file for the current todo item. Put subtopics such as file purpose, dependencies, routes, exports, functions, or Task Context inside the owning file target's body instead of creating separate plan entries.\n\nInvalid target(s):\n${invalidTargets.map((entry) => `  - ${entry.target}`).join("\n")}\n\nAllowed STEP 1 targets:\n${expectedTargetList}`,
						),
					)
					return
				}

				const actionMismatches = normalizedStructuredEntries.filter((entry) => {
					const expected = expectedTargetsByKey.get(normalizeTargetForComparison(entry.target))
					return expected?.action && expected.action !== entry.action
				})
				if (actionMismatches.length > 0) {
					task.consecutiveMistakeCount++
					task.recordToolError("write_todo_plan")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`STEP 2 plans[].action must match the action seeded by STEP 1 item_plan_targets.\n\nMismatched target(s):\n${actionMismatches
								.map((entry) => {
									const expected = expectedTargetsByKey.get(
										normalizeTargetForComparison(entry.target),
									)
									return `  - ${entry.target}: received ${entry.action}, expected ${expected?.action}`
								})
								.join("\n")}\n\nAllowed STEP 1 targets:\n${expectedTargetList}`,
						),
					)
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
			const emitRefineResult = async (
				stage: "step2" | "step3",
				isComplete: boolean,
				replacePlans = false,
				readResult = planReadResult,
			) => {
				const latestTodoItem = task.todoList?.find((todo) => todo.id === todo_item_id) ?? todoItem
				const plansForDisplay = task.applyTaskContextAgreementsToPlanEntries(
					readResult.plans,
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
						plans: plansForDisplay.map(formatPlanForDisplay),
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}

			await emitRefineResult("step2", false, true)

			const agreementPass = await task.enqueuePostRefineAgreementPass(todoItem, normalizedPlanEntries)
			const agreementPassFailed = agreementPass.error || !agreementPass.executed
			const isComplete = !agreementPassFailed && completion.isComplete

			if (agreementPassFailed) {
				task.pendingRefineStep3RetryTodoItemId = todo_item_id
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
				task.pendingRefineStep3RetryTodoItemId = null
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
				task.pendingRefineStep3RetryTodoItemId = null
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
			const step3PlanReadResult = await readPlanFiles(
				task.globalStoragePath,
				task.taskId,
				task.taskTimestamp,
				todo_item_id,
				todoItem.content,
			)
			await emitRefineResult("step3", isComplete, true, step3PlanReadResult)

			const label = planType === "general" ? "general plan section(s)" : "plan file(s)"
			const fileList = normalizedPlanEntries.map((e) => `  - ${e.filePath}`).join("\n")
			const savedPathList = savedPaths.map((p) => `  - ${p}`).join("\n")
			const step3FailureMessage = agreementPass.error
				? `STEP 3 agreement pass failed after writing the plan for "${todoItem.content}": ${agreementPass.error}`
				: !agreementPass.executed
					? `STEP 3 agreement pass did not run after writing the plan for "${todoItem.content}": ${agreementPass.skippedReason ?? "unknown reason"}`
					: undefined
			const missingTargetList = completion.missingTargets.map((target) => `  - ${target}`).join("\n")
			const resultIntro = step3FailureMessage
				? `Plan batch was saved, but STEP 3 failed for todo item "${todoItem.content}":\n${fileList}`
				: `Successfully wrote ${normalizedPlanEntries.length} ${label} for todo item "${todoItem.content}":\n${fileList}`
			const resultMessage = `${resultIntro}\n\nSaved plan files:\n${savedPathList}\n\nThese plans will be automatically injected into context when working on this todo item.${
				step3FailureMessage
					? `\n\n[STEP 3 FAILED AFTER PLAN SAVE — RETRY REQUIRED]\n${step3FailureMessage}\n\nThe plan batch has already been recorded, but STEP 3 has not succeeded. Do not move to another todo item. The next action must be another write_todo_plan call for the same todo_item_id "${todo_item_id}" to retry STEP 3. During this retry, the saved plans will be reused and no new plan file will be created. Refine mode remains locked on this todo item until STEP 3 succeeds.`
					: isComplete
						? allPlansWritten
							? "\n\n[ALL PLANS RECORDED — Launching parallel execution...]"
							: "\n\n[TODO PLAN COMPLETE — Continue with the next refine todo item.]"
						: `\n\n[PLAN BATCH RECORDED — Continue the same refine todo item.]${
								missingTargetList
									? `\nRemaining expected plan target(s) for this todo:\n${missingTargetList}\n\nNext action: call write_todo_plan again for the SAME todo_item_id and cover only a coherent subset of these remaining targets if needed. Previously recorded plan entries are already saved and accumulate; do not repeat them.`
									: "\nThe system could not infer all expected file targets from the todo text, so continue this same todo only if more plan entries are still needed. Previously recorded plan entries are already saved and accumulate; do not repeat them."
							}`
			}`

			if (step3FailureMessage) {
				task.consecutiveMistakeCount++
				task.recordToolError("write_todo_plan", step3FailureMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(resultMessage))
			} else {
				pushToolResult(formatResponse.toolResult(resultMessage))
			}

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
