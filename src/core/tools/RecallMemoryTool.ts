import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse, NativeToolArgs } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * RecallMemoryTool — currently disabled.
 * Context compression and summary features have been removed.
 */
export class RecallMemoryTool extends BaseTool<"recall_memory"> {
	readonly name = "recall_memory" as const

	async execute(params: NativeToolArgs["recall_memory"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		pushToolResult(
			formatResponse.toolError(
				"The recall_memory tool is currently unavailable. Context compression and summary features have been removed.",
			),
		)
	}

	override async handlePartial(task: Task, block: ToolUse<"recall_memory">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const recallMemoryTool = new RecallMemoryTool()
