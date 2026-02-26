import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { regressMemory, formatRegressionResult } from "../condense/regression"
import type { ToolUse, NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * RecallMemoryTool — drills down through the summary hierarchy
 * (Global Q → Individual Summary → Rolling Summary → Original Messages)
 * using a dedicated local regression model to retrieve deep memories.
 *
 * The user must configure a regression model in the Condensing Model panel
 * ("Models To Regress" section) before this tool can be used.
 */
export class RecallMemoryTool extends BaseTool<"recall_memory"> {
	readonly name = "recall_memory" as const

	async execute(params: NativeToolArgs["recall_memory"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		const { query } = params

		try {
			if (!query?.trim()) {
				task.consecutiveMistakeCount++
				task.recordToolError("recall_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("recall_memory", "query"))
				return
			}

			task.consecutiveMistakeCount = 0

			const regressionApi = await task.getRegressionApiHandler()
			if (!regressionApi) {
				pushToolResult(
					formatResponse.toolError(
						"No regression model configured. Please set a regression model in the Condensing Model panel (Models To Regress section).",
					),
				)
				return
			}

			console.log("[RecallMemoryTool] query =", query)
			const result = await regressMemory(query, regressionApi, {
				globalStoragePath: task.globalStoragePath,
				taskId: task.taskId,
			})
			const formatted = formatRegressionResult(result)
			console.log(
				"[RecallMemoryTool] result: success =",
				result.success,
				"chain =",
				result.chain.length,
				"originalMessages =",
				result.originalMessages.length,
			)

			task.recordToolUsage("recall_memory")
			pushToolResult(formatted)
		} catch (error) {
			console.error("[RecallMemoryTool] error:", error)
			await handleError("recalling memory", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"recall_memory">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const recallMemoryTool = new RecallMemoryTool()
