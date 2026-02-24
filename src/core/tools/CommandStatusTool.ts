import delay from "delay"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CommandStatusParams {
	terminal_id: number
	output_limit?: number | null
	wait_seconds?: number | null
}

interface CommandStatusResult {
	status: "running" | "done" | "not_found"
	terminal_id: number
	exit_code?: number
	output?: string
	output_truncated?: boolean
	error?: string
}

const DEFAULT_OUTPUT_LIMIT = 4000
const MAX_WAIT_SECONDS = 60

export class CommandStatusTool extends BaseTool<"command_status"> {
	readonly name = "command_status" as const

	async execute(params: CommandStatusParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		const { terminal_id, output_limit, wait_seconds } = params

		try {
			if (terminal_id === undefined || terminal_id === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("command_status")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("command_status", "terminal_id"))
				return
			}

			task.consecutiveMistakeCount = 0

			const effectiveOutputLimit = output_limit ?? DEFAULT_OUTPUT_LIMIT
			const effectiveWaitSeconds = Math.min(wait_seconds ?? 0, MAX_WAIT_SECONDS)

			// Wait for completion if requested
			if (effectiveWaitSeconds > 0) {
				await this.waitForCompletion(terminal_id, effectiveWaitSeconds)
			}

			const result = this.getTerminalStatus(terminal_id, effectiveOutputLimit)
			const resultText = this.formatResult(result)

			pushToolResult(resultText)
		} catch (error) {
			await handleError("checking command status", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async waitForCompletion(terminalId: number, maxWaitSeconds: number): Promise<void> {
		const startTime = Date.now()
		const maxWaitMs = maxWaitSeconds * 1000
		const checkIntervalMs = 500

		while (Date.now() - startTime < maxWaitMs) {
			const terminals = TerminalRegistry.getTerminals(true) // Get busy terminals
			const terminal = terminals.find((t) => t.id === terminalId)

			if (!terminal) {
				// Terminal not busy anymore (either done or not found)
				return
			}

			await delay(checkIntervalMs)
		}
	}

	private getTerminalStatus(terminalId: number, outputLimit: number): CommandStatusResult {
		// Try to find the terminal in all terminals
		const allBusyTerminals = TerminalRegistry.getTerminals(true)
		const allIdleTerminals = TerminalRegistry.getTerminals(false)

		const busyTerminal = allBusyTerminals.find((t) => t.id === terminalId)
		const idleTerminal = allIdleTerminals.find((t) => t.id === terminalId)

		if (busyTerminal) {
			// Terminal is still running
			const output = TerminalRegistry.getUnretrievedOutput(terminalId)
			const truncated = output.length > outputLimit

			return {
				status: "running",
				terminal_id: terminalId,
				output: truncated ? output.slice(-outputLimit) : output,
				output_truncated: truncated,
			}
		}

		if (idleTerminal) {
			// Terminal finished
			const output = TerminalRegistry.getUnretrievedOutput(terminalId)
			const truncated = output.length > outputLimit

			return {
				status: "done",
				terminal_id: terminalId,
				output: truncated ? output.slice(-outputLimit) : output,
				output_truncated: truncated,
			}
		}

		// Terminal not found
		return {
			status: "not_found",
			terminal_id: terminalId,
			error: `Terminal with ID ${terminalId} not found. It may have been closed or never existed.`,
		}
	}

	/** @internal Exposed for testing */
	public formatResult(result: CommandStatusResult): string {
		const lines: string[] = []

		lines.push(`## Command Status: ${result.status.toUpperCase()}`)
		lines.push(`**Terminal ID:** ${result.terminal_id}`)

		if (result.status === "not_found") {
			lines.push("")
			lines.push(`**Error:** ${result.error}`)
			return lines.join("\n")
		}

		if (result.status === "done" && result.exit_code !== undefined) {
			lines.push(`**Exit Code:** ${result.exit_code}`)
		}

		if (result.output !== undefined) {
			lines.push("")
			if (result.output_truncated) {
				lines.push("**Output (truncated, showing last portion):**")
			} else {
				lines.push("**Output:**")
			}
			lines.push("```")
			lines.push(result.output || "(no output)")
			lines.push("```")
		}

		return lines.join("\n")
	}

	override async handlePartial(task: Task, block: ToolUse<"command_status">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const commandStatusTool = new CommandStatusTool()
