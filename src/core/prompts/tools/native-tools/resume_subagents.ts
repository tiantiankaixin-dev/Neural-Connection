import type OpenAI from "openai"

const RESUME_SUBAGENTS_DESCRIPTION = [
	"Resume the interrupted parallel subagent execution phase after a restart.",
	"",
	"Use this only when the context contains [SUBAGENT EXECUTION INTERRUPTED - RESUME CHECK] and you decide the previous parallel child-agent execution should continue.",
	"This returns control to the system scheduler, which launches the unfinished refined todo items from their saved plan files as parallel subagents. It must not resume only the most recent child agent.",
	"If you decide normal main-agent work should continue instead, do not call this tool; start normal implementation work and the pending subagent marker will be cleared.",
].join("\n")

export default {
	type: "function",
	function: {
		name: "resume_subagents",
		description: RESUME_SUBAGENTS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description: "Brief reason for resuming parallel subagent execution.",
				},
			},
			required: ["summary"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
