import type OpenAI from "openai"

const WRITE_TODO_PLAN_DESCRIPTION = `Write detailed implementation plan entries for a specific todo item.

This tool is used during the "refine" phase to break down a todo item into granular implementation plans BEFORE starting actual work.
The plan itself is an internal planning artifact. Do not create workspace files for the plan itself; use this tool to record it.

plan_type determines the kind of plan:
- "file": Use this ONLY when the todo item requires modifying or creating real project files. This includes source files, config files, docs, scripts, tests, workflows, JSON/YAML/MD files, and any other real workspace files. Each entry targets a real relative project file path.
- "general": Use this when the todo item does NOT require modifying or creating project files. This includes project review plans, project planning plans, debug plans, investigation plans, architecture comparison/evaluation plans, repro plans, migration strategy planning, and research/design guidance. Each entry must use a descriptive section title as filePath, not a real file path.

Non-code plans MUST use "general". Do not force project review / project planning / debug strategy / architecture analysis tasks into "file" unless real project files will actually be edited.

Plan Format (JSON array in the plans parameter):
Each entry has:
- filePath: For "file" plans, the relative path to the project file (e.g. "src/core/Player.ts", "docs/migration.md", ".github/workflows/release.yml"). For "general" plans, a descriptive section title (e.g. "Architecture Overview", "Debug Hypotheses", "Project Review Checklist").
- content: markdown content describing the plan details

The plans are stored internally and automatically injected into context when working on the corresponding todo item.

When to Use:
- When the user clicks the "Refine" button on a todo item
- Use plan_type="file" when the todo item requires modifying or creating project files
- Use plan_type="general" when the todo item is about research, review, planning, debugging strategy, analysis, or does not involve direct file changes
- Do not use write_to_file or create markdown files in the workspace to save the plan itself

Examples:
File plan: { "todo_item_id": "abc123", "plan_type": "file", "plans": "[{\"filePath\":\"src/core/Player.ts\",\"content\":\"## Changes\n- Add health property\"}]" }
File plan: { "todo_item_id": "abc123", "plan_type": "file", "plans": "[{\"filePath\":\"docs/migration.md\",\"content\":\"## Changes\n- Document migration steps\"},{\"filePath\":\"package.json\",\"content\":\"## Changes\n- Add script for migration validation\"}]" }
General plan: { "todo_item_id": "abc123", "plan_type": "general", "plans": "[{\"filePath\":\"Architecture Overview\",\"content\":\"## Design\n- Compare current and target architecture\"}]" }
General plan: { "todo_item_id": "abc123", "plan_type": "general", "plans": "[{\"filePath\":\"Debug Hypotheses\",\"content\":\"## Hypotheses\n- Identify likely startup failure causes\"},{\"filePath\":\"Reproduction Strategy\",\"content\":\"## Repro\n- Define steps to reproduce consistently before editing code\"}]" }`

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
						'"file" for plans that modify/create real project files. "general" for non-code plans such as project review, project planning, debugging strategy, investigation, or architecture analysis when no project files are edited.',
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
