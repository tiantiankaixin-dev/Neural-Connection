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

			// Force final token usage update before emitting TaskCompleted
			task.emitFinalTokenUsageUpdate()

			TelemetryService.instance.captureTaskCompleted(task.taskId)
			task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				// Task accepted — mark boundary and continue in same conversation
				await task.say("task_completed", result)

				// Assemble all per-turn files into a final result JSON (non-critical)
				if (task.taskTimestamp && task.turnCounter > 0) {
					try {
						await assembleTurns(task.globalStoragePath, task.taskId, task.taskTimestamp)
					} catch (err) {
						console.warn("[AttemptCompletionTool] assembleTurns failed (non-critical):", err)
					}
				}

				// Mark task boundary: next messages belong to a new sub-task
				task.currentTaskStartIndex = task.apiConversationHistory.length
				// Reset task lock so model must re-establish task for next work
				task.taskEstablished = false

				pushToolResult("Task marked as complete. Awaiting user's next instruction.")
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			// Task lock: re-lock tools after completion feedback so model must re-establish task
			task.taskEstablished = false

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
