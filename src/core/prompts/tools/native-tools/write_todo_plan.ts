import type OpenAI from "openai"

const WRITE_TODO_PLAN_DESCRIPTION = [
	"Write detailed implementation plan entries for a specific todo item.",
	"",
	'This tool is used during the "refine" phase to break down a todo item into granular implementation plans BEFORE starting actual work.',
	"The plan itself is an internal planning artifact. Do not create workspace files for the plan itself; use this tool to record it.",
	"",
	"plan_type determines the kind of plan:",
	'- "file": Use this ONLY when the todo item requires modifying or creating real project files. This includes source files, config files, docs, scripts, tests, workflows, JSON/YAML/MD files, and any other real workspace files. Each entry targets a real relative project file path.',
	'- "general": Use this when the todo item does NOT require modifying or creating project files. This includes project review plans, project planning plans, debug plans, investigation plans, architecture comparison/evaluation plans, repro plans, migration strategy planning, and research/design guidance. Each entry must use a descriptive section title as target, not a real file path.',
	"",
	'Non-code plans MUST use "general". Do not force project review / project planning / debug strategy / architecture analysis tasks into "file" unless real project files will actually be edited.',
	"",
	"Plan Format:",
	"Each entry has:",
	'- target: For "file" plans, the relative path to the project file (e.g. "src/core/Player.ts", "docs/migration.md", ".github/workflows/release.yml"). For "general" plans, a descriptive section title (e.g. "Architecture Overview", "Debug Hypotheses", "Project Review Checklist").',
	'- action: One of CREATE, MODIFY, DELETE, or GENERAL. For "file" plans, action must be CREATE, MODIFY, or DELETE. For "general" plans, action must be GENERAL.',
	"- body: markdown plan body only. Do NOT include the <<<PLAN_TARGET>>> header block yourself; the system generates it from target/action automatically.",
	"Each plan entry should describe exactly one target path or one general section.",
	'For "file" plans, the `body` must be an exhaustive blueprint of the full target file, effectively equivalent to writing the whole file in planning form before implementation.',
	'For each "file" plan entry, explicitly document which files reference/import/use the target file (`referenced_by_files`) and which files the target file imports/depends on (`references_files`).',
	'For each "file" plan entry, enumerate every function/method expected to exist in the target file after the change, including unchanged existing functions, modified functions, and newly added functions.',
	"For every listed function/method, explicitly document: `name/signature`, `referenced_by`, `references`, and `responsibility`.",
	"Include exported functions, local helpers, class methods, React components, hooks, callbacks, and any other function-like units defined in the file.",
	"Do not use vague placeholders such as 'other helpers' or 'existing methods remain unchanged' without listing them individually.",
	"If a target file truly has no functions or methods, state that explicitly and document the relevant top-level structure instead.",
	"",
	"The plans are stored internally and automatically injected into context when working on the corresponding todo item.",
	"",
	"When to Use:",
	'- When the user clicks the "Refine" button on a todo item',
	'- Use plan_type="file" when the todo item requires modifying or creating project files',
	'- Use plan_type="general" when the todo item is about research, review, planning, debugging strategy, analysis, or does not involve direct file changes',
	"- Do not use write_to_file or create markdown files in the workspace to save the plan itself",
	"",
	"Examples:",
	'File plan: { "todo_item_id": "abc123", "plan_type": "file", "plans": [{"target":"src/core/Player.ts","action":"MODIFY","body":"## Changes\n- Add health property"}] }',
	'File plan: { "todo_item_id": "abc123", "plan_type": "file", "plans": [{"target":"docs/migration.md","action":"CREATE","body":"## Changes\n- Document migration steps"},{"target":"package.json","action":"MODIFY","body":"## Changes\n- Add script for migration validation"}] }',
	'General plan: { "todo_item_id": "abc123", "plan_type": "general", "plans": [{"target":"Architecture Overview","action":"GENERAL","body":"## Design\n- Compare current and target architecture"}] }',
	'General plan: { "todo_item_id": "abc123", "plan_type": "general", "plans": [{"target":"Debug Hypotheses","action":"GENERAL","body":"## Hypotheses\n- Identify likely startup failure causes"},{"target":"Reproduction Strategy","action":"GENERAL","body":"## Repro\n- Define steps to reproduce consistently before editing code"}] }',
].join("\n")

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
					type: "array",
					description:
						'Array of structured plan entries. Each entry: { "target": "relative/path/to/file.ext or descriptive title", "action": "CREATE|MODIFY|DELETE|GENERAL", "body": "markdown plan body only" }. For file plans, the body must document the full file blueprint, include `referenced_by_files` and `references_files`, and list every function/method with `referenced_by`, `references`, and `responsibility`.',
					items: {
						type: "object",
						properties: {
							target: {
								type: "string",
								description:
									"Relative file path for file plans, or descriptive section title for general plans",
							},
							action: {
								type: "string",
								enum: ["CREATE", "MODIFY", "DELETE", "GENERAL"],
								description: "Action for this target. GENERAL is only valid for general plans.",
							},
							body: {
								type: "string",
								description:
									"Markdown plan body only. Do not include PLAN_TARGET header markup. For file plans, this body must include the complete target-file blueprint, specify `referenced_by_files` and `references_files`, and list every function/method with its callers, dependencies, and concrete responsibility.",
							},
						},
						required: ["target", "action", "body"],
						additionalProperties: false,
					},
				},
			},
			required: ["todo_item_id", "plan_type", "plans"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
