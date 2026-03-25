import type OpenAI from "openai"

const WRITE_TODO_PLAN_DESCRIPTION = `Write detailed implementation plan files for a specific todo item. Each plan file corresponds to a real project file that needs to be modified or created, stored as a .md file mirroring the project's folder structure.

This tool is used during the "refine" phase to break down a todo item into granular, per-file implementation plans BEFORE starting actual work. The AI should analyze the todo item, identify all files that need modification or creation, and write a detailed plan for each.

Plan Format (JSON array in the plans parameter):
Each entry has:
- filePath: relative path to the project file (e.g. "src/core/Player.ts")
- content: markdown content describing the changes needed

The plans are stored internally and automatically injected into context when working on the corresponding todo item.

When to Use:
- When the user clicks the "Refine" button on a todo item
- When breaking down a complex todo item into per-file implementation details
- To create a detailed roadmap before executing changes

Example:
{ "todo_item_id": "abc123", "plans": "[{\\"filePath\\":\\"src/core/Player.ts\\",\\"content\\":\\"## Changes\\n- Add health property\\n- Implement takeDamage method\\"},{\\"filePath\\":\\"src/systems/HealthSystem.ts\\",\\"content\\":\\"## New File\\n- Create health management system\\"}]" }`

export default {
	type: "function",
	function: {
		name: "write_todo_plan",
		description: WRITE_TODO_PLAN_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				todo_item_id: {
					type: "string",
					description: "The ID of the todo item to write plans for",
				},
				plans: {
					type: "string",
					description:
						'JSON array of plan entries. Each entry: { "filePath": "relative/path/to/file.ext", "content": "markdown plan content" }',
				},
			},
			required: ["todo_item_id", "plans"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
