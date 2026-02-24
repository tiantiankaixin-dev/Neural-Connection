import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ReadTerminalParams {
	terminal_id: number
	output_limit?: number | null
}

interface ReadTerminalResult {
	status: "found" | "not_found"
	terminal_id: number
	is_busy?: boolean
	last_command?: string
	output?: string
	output_truncated?: boolean
	error?: string
}

const DEFAULT_OUTPUT_LIMIT = 8000

export class ReadTerminalTool extends BaseTool<"read_terminal"> {
	readonly name = "read_terminal" as const

	async execute(params: ReadTerminalParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks
		const { terminal_id, output_limit } = params

		try {
			if (terminal_id === undefined || terminal_id === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("read_terminal")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("read_terminal", "terminal_id"))
				return
			}

			task.consecutiveMistakeCount = 0

			const effectiveOutputLimit = output_limit ?? DEFAULT_OUTPUT_LIMIT
			const result = this.getTerminalContent(terminal_id, effectiveOutputLimit)
			const resultText = this.formatResult(result)

			pushToolResult(resultText)
		} catch (error) {
			await handleError("reading terminal", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private getTerminalContent(terminalId: number, outputLimit: number): ReadTerminalResult {
		// Try to find the terminal in all terminals
		const allBusyTerminals = TerminalRegistry.getTerminals(true)
		const allIdleTerminals = TerminalRegistry.getTerminals(false)

		const busyTerminal = allBusyTerminals.find((t) => t.id === terminalId)
		const idleTerminal = allIdleTerminals.find((t) => t.id === terminalId)
		const terminal = busyTerminal || idleTerminal

		if (terminal) {
			const output = terminal.getUnretrievedOutput()
			const truncated = output.length > outputLimit
			const lastCommand = terminal.getLastCommand()

			return {
				status: "found",
				terminal_id: terminalId,
				is_busy: !!busyTerminal,
				last_command: lastCommand || undefined,
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
	public formatResult(result: ReadTerminalResult): string {
		const lines: string[] = []

		if (result.status === "not_found") {
			lines.push(`## Terminal Not Found`)
			lines.push(`**Terminal ID:** ${result.terminal_id}`)
			lines.push("")
			lines.push(`**Error:** ${result.error}`)
			return lines.join("\n")
		}

		lines.push(`## Terminal Content`)
		lines.push(`**Terminal ID:** ${result.terminal_id}`)
		lines.push(`**Status:** ${result.is_busy ? "Running" : "Idle"}`)

		if (result.last_command) {
			lines.push(`**Last Command:** \`${result.last_command}\``)
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

	override async handlePartial(task: Task, block: ToolUse<"read_terminal">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const readTerminalTool = new ReadTerminalTool()
