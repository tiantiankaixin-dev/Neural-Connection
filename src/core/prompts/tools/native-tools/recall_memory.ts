import type OpenAI from "openai"

const RECALL_MEMORY_DESCRIPTION = `Deep memory recall tool. Drills down through the summary hierarchy to retrieve original conversation messages when you need to recall specific details from past work.

**HOW IT WORKS:**
This tool uses a dedicated local regression model to trace back from high-level summaries to the original messages:
1. Global Summary Q → identifies which sub-task summary is relevant
2. Individual/Rolling Summary → retrieves the original conversation messages

**WHEN TO USE:**
- When the Global Summary Q mentions something you need more details about
- When you need to recall the exact steps, code changes, or decisions from a past sub-task
- When the condensed summary is too coarse and you need the original conversation context

**REQUIREMENTS:**
- A regression model must be configured in the Condensing Model panel ("Models To Regress" section)
- Summary entries must exist (created by the condensation system)

**NOTE:** This tool calls a local model and may take a few seconds. Only use it when you genuinely need deeper context that the current summaries don't provide.

Parameters:
- query: (required) What you need to recall — be specific about the topic, file, or action you're looking for

Example:
{
  "query": "How was the authentication token refresh logic implemented?"
}`

export default {
	type: "function",
	function: {
		name: "recall_memory",
		description: RECALL_MEMORY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"What you need to recall — be specific about the topic, file, or action you're looking for",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
