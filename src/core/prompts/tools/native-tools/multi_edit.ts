import type OpenAI from "openai"

const MULTI_EDIT_DESCRIPTION = `Make multiple edits to a single file in one atomic operation. All edits are applied in sequence, and if any edit fails, none are applied.

This is more efficient than multiple single edits when you need to make several changes to different parts of the same file.

Parameters:
- file_path: (required) The absolute path to the file to modify
- edits: (required) Array of edit operations, each containing:
  - old_string: Text to find (must be unique unless replace_all is true)
  - new_string: Text to replace with (must be different from old_string)
  - replace_all: (optional) Replace all occurrences of old_string
- explanation: (required) Description of the changes being made

Example: Rename a variable and update a function
{
  "file_path": "/path/to/file.ts",
  "edits": [
    { "old_string": "oldVarName", "new_string": "newVarName", "replace_all": true },
    { "old_string": "function oldFunc()", "new_string": "function newFunc()" }
  ],
  "explanation": "Rename variable and function"
}

IMPORTANT:
- Edits are applied sequentially in order
- Each edit operates on the result of previous edits
- If any edit fails (no match, ambiguous match), ALL edits are rolled back
- Plan edits carefully to avoid conflicts between operations`

const FILE_PATH_PARAMETER_DESCRIPTION = "Absolute path to the file to modify"

const EDITS_PARAMETER_DESCRIPTION = "Array of edit operations to perform sequentially"

const EXPLANATION_PARAMETER_DESCRIPTION = "Description of the changes being made"

export default {
	type: "function",
	function: {
		name: "multi_edit",
		description: MULTI_EDIT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: FILE_PATH_PARAMETER_DESCRIPTION,
				},
				edits: {
					type: "array",
					description: EDITS_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							old_string: {
								type: "string",
								description: "The text to find and replace",
							},
							new_string: {
								type: "string",
								description: "The replacement text",
							},
							replace_all: {
								type: ["boolean", "null"],
								description: "Replace all occurrences (default: false)",
							},
						},
						required: ["old_string", "new_string"],
						additionalProperties: false,
					},
					minItems: 1,
				},
				explanation: {
					type: "string",
					description: EXPLANATION_PARAMETER_DESCRIPTION,
				},
			},
			required: ["file_path", "edits", "explanation"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
