import type OpenAI from "openai"

const WRITE_TODO_PLAN_DESCRIPTION = `Write detailed implementation plan entries for a specific todo item.

This tool is used during the "refine" phase to break down a todo item into granular implementation plans BEFORE starting actual work.
The plan itself is an internal planning artifact. Do not create workspace files for the plan itself; use this tool to record it.

plan_type determines the kind of plan:
- "file": Per-file implementation plans. Each entry targets a real project file that needs modification or creation. The plan records those intended file changes internally.
- "general": Conceptual / non-file-modification plans (e.g. architecture decisions, research notes, design guidelines). Each entry uses a descriptive title as filePath. The plan is stored internally as a general planning artifact.

Plan Format (JSON array in the plans parameter):
Each entry has:
- filePath: For "file" plans, the relative path to the project file (e.g. "src/core/Player.ts"). For "general" plans, a descriptive section title (e.g. "Architecture Overview").
- content: markdown content describing the plan details

The plans are stored internally and automatically injected into context when working on the corresponding todo item.

When to Use:
- When the user clicks the "Refine" button on a todo item
- Use plan_type="file" when the todo item requires modifying or creating project files
- Use plan_type="general" when the todo item is about research, design, analysis, or does not involve direct file changes
- Do not use write_to_file or create markdown files in the workspace to save the plan itself

Examples:
File plan: { "todo_item_id": "abc123", "plan_type": "file", "plans": "[{\"filePath\":\"src/core/Player.ts\",\"content\":\"## Changes\n- Add health property\"}]" }
General plan: { "todo_item_id": "abc123", "plan_type": "general", "plans": "[{\"filePath\":\"Architecture Overview\",\"content\":\"## Design\n- Use event-driven pattern\"}]" }`

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
				plan_type: {
					type: "string",
					enum: ["file", "general"],
					description:
						'"file" for per-file implementation plans that modify/create project files. "general" for conceptual plans that do not involve direct file changes.',
				},
				plans: {
					type: "string",
					description:
						'JSON array of plan entries. Each entry: { "filePath": "relative/path/to/file.ext or descriptive title", "content": "markdown plan content" }',
				},
			},
			required: ["todo_item_id", "plan_type", "plans"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
