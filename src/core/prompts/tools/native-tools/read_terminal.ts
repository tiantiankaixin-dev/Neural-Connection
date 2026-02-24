import type OpenAI from "openai"

const READ_TERMINAL_DESCRIPTION = `Read the current content/output from a terminal by its ID. This allows you to inspect what's been output to a specific terminal without executing new commands.

Use this tool to:
- View recent output from a terminal you've been using
- Check the state of a terminal after background processes have run
- Get historical output that may have scrolled off screen

Parameters:
- terminal_id: (required) The numeric ID of the terminal to read
- output_limit: (optional) Maximum characters of output to return (default: 8000)

Example: Read output from terminal 1
{ "terminal_id": 1, "output_limit": 8000 }

Example: Read limited output from terminal 2
{ "terminal_id": 2, "output_limit": 2000 }`

const TERMINAL_ID_PARAMETER_DESCRIPTION = "Numeric ID of the terminal to read content from"

const OUTPUT_LIMIT_PARAMETER_DESCRIPTION = "Maximum characters of output to return (default: 8000)"

export default {
	type: "function",
	function: {
		name: "read_terminal",
		description: READ_TERMINAL_DESCRIPTION,
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
			},
			required: ["terminal_id", "output_limit"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
