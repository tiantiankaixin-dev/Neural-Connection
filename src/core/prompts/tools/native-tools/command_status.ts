import type OpenAI from "openai"

const COMMAND_STATUS_DESCRIPTION = `Check the status of a previously started terminal command by its terminal ID. Returns the current status (running or done), any new output since last check, and exit code if completed.

Use this tool to:
- Check if a background/long-running command has completed
- Get new output from a running command without blocking
- Get the exit code and final output of a completed command

The terminal_id is returned when you execute a command. Background terminals can be queried at any time.

Parameters:
- terminal_id: (required) The numeric ID of the terminal to check (returned from execute_command)
- output_limit: (optional) Maximum characters of output to return (default: 4000)
- wait_seconds: (optional) Seconds to wait for command completion before returning status (default: 0, max: 60)

Example: Check if terminal 1 has finished
{ "terminal_id": 1, "output_limit": 4000, "wait_seconds": 0 }

Example: Wait up to 30 seconds for completion then get status
{ "terminal_id": 1, "output_limit": 8000, "wait_seconds": 30 }`

const TERMINAL_ID_PARAMETER_DESCRIPTION = "Numeric ID of the terminal to check status for"

const OUTPUT_LIMIT_PARAMETER_DESCRIPTION = "Maximum characters of output to return (default: 4000)"

const WAIT_SECONDS_PARAMETER_DESCRIPTION =
	"Seconds to wait for command completion before returning (default: 0, max: 60)"

export default {
	type: "function",
	function: {
		name: "command_status",
		description: COMMAND_STATUS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				terminal_id: {
					type: "integer",
					description: TERMINAL_ID_PARAMETER_DESCRIPTION,
				},
				output_limit: {
					type: ["integer", "null"],
					description: OUTPUT_LIMIT_PARAMETER_DESCRIPTION,
				},
				wait_seconds: {
					type: ["integer", "null"],
					description: WAIT_SECONDS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["terminal_id", "output_limit", "wait_seconds"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
