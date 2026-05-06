import type OpenAI from "openai"

const WRITE_TODO_PLAN_DESCRIPTION = [
	"Write detailed implementation plan entries for a specific todo item.",
	"",
	'This tool is used during the "refine" phase after the todo list has been rewritten into a better decomposition. Use the todo ids returned by `update_todo_list` and then record granular implementation plans BEFORE starting actual work.',
	"The plan itself is an internal planning artifact. Do not create workspace files for the plan itself; use this tool to record it.",
	"",
	"Todo-level task context for each architecture layer is supplied in refine via `update_todo_list` (`item_contexts`, stored on each todo item). You do not pass a separate context here — the system injects that todo-level context for the build agent.",
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
	'For "file" plans, the `body` should be detailed enough for autonomous implementation and should clearly describe the intended structure and key changes for the target file.',
	'For each "file" plan entry, document which files reference/import/use the target file (`referenced_by_files`) and which files the target file imports/depends on (`references_files`) when those relationships materially affect the implementation.',
	"Describe the major functions, components, classes, helpers, or responsibilities that need to exist or change in the target file when that level of detail is useful for implementation.",
	"Do not force an exhaustive inventory of every unchanged helper, callback, or boilerplate function unless it is important for correct implementation.",
	"If a target file has little or no function-level structure, describe the relevant top-level structure instead.",
	"",
	"The plans are stored internally and automatically injected into context when working on the corresponding todo item.",
	"",
	"Batching:",
	"- If the current todo item feels too large to plan clearly in one response, you may split the plan into multiple `write_todo_plan` calls for the SAME `todo_item_id`.",
	"- Each call records one natural plan batch. After any call, wait for the tool result and STEP 3 before making the next `write_todo_plan` call.",
	"- The system infers whether the current todo item's required plan targets are complete from the recorded plan entries; do not add any separate completion flag.",
	"",
	"CRITICAL — Context Isolation:",
	"Each plan is the SOLE initial context the build agent will see when implementing that todo item, aside from the todo-level task context from `update_todo_list`. The build agent has NO access to prior exploration, conversation history, or other items' plans.",
	"Therefore, each plan MUST be self-contained for implementation details and include:",
	"- Background context: relevant file paths, line numbers, code patterns, and existing code snippets from your exploration",
	"- Cross-task dependencies: which other items this task depends on or produces for, and any ordering constraints",
	"- Implementation intent: whether to write code, research, or debug; which files to create/modify/delete; which patterns and libraries to follow",
	"- Verification: specific test commands, expected behavior, and how to confirm correctness",
	"",
	"Multi-call pattern: You may call this tool MULTIPLE TIMES for the same todo_item_id. Each call ACCUMULATES — plans are appended.",
	"",
	"When to Use:",
	'- When the user clicks the "Refine" button and you have already rewritten the todo list into the decomposition you want to keep',
	"- After `update_todo_list` returns the current todo ids for the rewritten list",
	'- Use plan_type="file" when the todo item requires modifying or creating project files',
	'- Use plan_type="general" when the todo item is about research, review, planning, debugging strategy, analysis, or does not involve direct file changes',
	"- Do not use write_to_file or create markdown files in the workspace to save the plan itself",
	"",
	"Examples:",
	'  { "todo_item_id": "abc123", "plan_type": "file", "plans": [{"target":"src/config.ts","action":"CREATE","body":"..."},{"target":"src/server.ts","action":"MODIFY","body":"..."}] }',
	'  { "todo_item_id": "abc123", "plan_type": "file", "plans": [{"target":"src/config.ts","action":"CREATE","body":"..."}] }',
	'  { "todo_item_id": "abc123", "plan_type": "general", "plans": [{"target":"Architecture Overview","action":"GENERAL","body":"## Design\\n- Compare current and target architecture"}] }',
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
