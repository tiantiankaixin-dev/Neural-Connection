import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ResumeSubagentsParams {
	summary?: string | null
}

export class ResumeSubagentsTool extends BaseTool<"resume_subagents"> {
	readonly name = "resume_subagents" as const

	async execute(params: ResumeSubagentsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		try {
			const canResume = await task.hasSubagentResumeState()
			if (!canResume) {
				task.consecutiveMistakeCount++
				task.recordToolError("resume_subagents")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError("No interrupted subagent execution state is available to resume."),
				)
				return
			}

			if (!task.todoList || task.todoList.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("resume_subagents")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError("Cannot resume subagents because the current todo list is empty."),
				)
				return
			}

			task.consecutiveMistakeCount = 0
			task.isRefineMode = false
			task.activeRefineTodoItemIds = null
			task.clearSubagentResumeReviewState()
			await task.clearRefineResumeState()
			await task.persistSubagentResumeState()
			task.subagentsPending = true

			const summary = params.summary?.trim()
			pushToolResult(
				formatResponse.toolResult(
					`Subagent resume accepted. The main loop will restart parallel execution for unfinished refined todo items.${summary ? `\n\nReason: ${summary}` : ""}`,
				),
			)
		} catch (error) {
			await handleError("resume subagents", error as Error)
		}
	}
}

export const resumeSubagentsTool = new ResumeSubagentsTool()
