import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { assembleTurns } from "../task-persistence/turn-persistence"
import { setTodoListForTask } from "./UpdateTodoListTool"
import { compressOnCompletion } from "../condense/context-selector"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult } = callbacks

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			// Compress ALL conversation messages into a summary.
			// Uses the same compression mechanism as compressInTaskContext (Phase 3 safety net),
			// but runs unconditionally at task completion.
			// Result: apiConversationHistory is replaced with [summary pair].
			// Summary is also saved to summary/task/<timestamp>/task_summary.json.
			try {
				await compressOnCompletion(task)
			} catch (err) {
				console.warn("[AttemptCompletionTool] compressOnCompletion failed (non-critical):", err)
			}

			// Force final token usage update before emitting TaskCompleted
			task.emitFinalTokenUsageUpdate()

			TelemetryService.instance.captureTaskCompleted(task.taskId)
			task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				// Task accepted — mark boundary and continue in same conversation
				await task.say("task_completed", result)

				// Assemble all per-turn files (including context_refs.json) into a final result JSON
				if (task.taskTimestamp) {
					try {
						await assembleTurns(task.globalStoragePath, task.taskId, task.taskTimestamp)
					} catch (err) {
						console.warn("[AttemptCompletionTool] assembleTurns failed (non-critical):", err)
					}
				}

				// Mark task boundary: next messages belong to a new sub-task
				task.currentTaskStartIndex = task.apiConversationHistory.length
				// Clear todo list so next turn doesn't see stale "ALL TASKS COMPLETED"
				await setTodoListForTask(task, [])
				// Reset task lock so model must re-establish task for next work
				task.taskEstablished = false
				// Flag for attemptApiRequest to do history replacement on next call
				task.needsContextCompression = true
				console.log(
					`[AttemptCompletionTool] yesButtonClicked: needsContextCompression=${task.needsContextCompression}, taskTimestamp=${task.taskTimestamp}`,
				)

				pushToolResult("Task marked as complete. Awaiting user's next instruction.")
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			// Clear todo list so next turn doesn't see stale "ALL TASKS COMPLETED"
			await setTodoListForTask(task, [])
			// Task lock: re-lock tools after completion feedback so model must re-establish task
			task.taskEstablished = false
			// Flag for attemptApiRequest to do history replacement on next call
			task.needsContextCompression = true
			console.log(
				`[AttemptCompletionTool] userFeedback: needsContextCompression=${task.needsContextCompression}, taskTimestamp=${task.taskTimestamp}`,
			)

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)

				task.emitFinalTokenUsageUpdate()

				TelemetryService.instance.captureTaskCompleted(task.taskId)
				task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)

				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
