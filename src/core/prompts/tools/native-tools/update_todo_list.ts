import type OpenAI from "openai"

// ── Shared fragments ──

const CHECKLIST_FORMAT_COMMON = `Checklist Format:
- Use a single-level markdown checklist (no nesting or subtasks)
- List todos in the intended execution order
- Status options: [ ] (pending), [x] (completed), [-] (in progress)
- Write each todo as a concrete action, not a vague phase label
- Do not use vague wording like "create needed files", "add new components", or "set up files" without naming the files
- If the exact file paths are not known yet, add a discovery/planning todo first and later replace it with concrete file-creation todos once known
- Each todo that touches files fully owns every file path it names; those files must not also appear in another active or pending todo as files to modify
- Do not split responsibility for the same file across multiple todo items; if multiple changes touch one file, merge them into one owning todo or first reorganize the todo list`

const CORE_PRINCIPLES = `Core Principles:
- Before updating, always confirm which todos have been completed
- You may update multiple statuses in a single update
- Add new actionable items as they're discovered
- Only mark a task as completed when fully accomplished
- Replace the full old list with the best current decomposition; do not assume the previous breakdown must be preserved
- Preserve clear file ownership boundaries so parallel or subsequent subtasks do not collide on the same file`

const WHEN_TO_USE = `When to Use:
- Task involves multiple steps or requires ongoing tracking
- Need to update status of several todos at once
- New actionable items are discovered during execution
- Task is complex and benefits from stepwise progress tracking

When NOT to Use:
- Only a single, trivial task
- Task can be completed in one or two simple steps
- Request is purely conversational or informational`

// ── Normal mode (build): fine-grained file-level examples ──

const NORMAL_DESCRIPTION = `Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. This tool is designed for step-by-step task tracking, allowing you to confirm completion of each step before updating, update multiple task statuses at once (e.g., mark one as completed and start the next), and dynamically add new todos discovered during long or complex tasks.

${CHECKLIST_FORMAT_COMMON}
- If a todo requires creating one or more new files, explicitly include every new relative file path in that todo item
- When file creation is required, spell out the new file paths directly in the relevant todo items

${CORE_PRINCIPLES}

Example: Initial task list
{ "todos": "[x] Analyze requirements\\n[x] Design architecture\\n[-] Implement core logic\\n[ ] Write tests\\n[ ] Update documentation" }

Example: After completing implementation
{ "todos": "[x] Analyze requirements\\n[x] Design architecture\\n[x] Implement core logic\\n[-] Write tests\\n[ ] Update documentation\\n[ ] Add performance benchmarks" }

Example: File creation must be explicit
{ "todos": "[x] Analyze requirements\\n[-] Create src/core/task/Task.ts and src/core/tools/WriteTodoPlanTool.ts changes\\n[ ] Create docs/refine-plan-format.md\\n[ ] Update webview-ui/src/components/chat/ChatRow.tsx" }

Example: File ownership must not overlap across todos
{ "todos": "[x] Analyze requirements\\n[-] Modify src/core/task/Task.ts and src/core/prompts/tools/native-tools/write_todo_plan.ts for refine prompt rules\\n[ ] Modify src/core/prompts/tools/native-tools/update_todo_list.ts and src/core/prompts/tools/native-tools/new_task.ts for todo ownership rules" }

${WHEN_TO_USE}`

const NORMAL_TODOS_PARAM = `Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress. The list replaces the previous todo list in full. If any todo involves creating files, explicitly include every new relative file path in that todo item. Each file path named in a todo should be owned by that todo alone and must not also appear in another unfinished todo that modifies the same file.`

// ── Refine mode: architecture-based coarse-grained examples ──

const REFINE_DESCRIPTION = `Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. In refine / planning flows, this is the STEP 1 file-target extraction and classification tool: derive exact files from the previous todo list, existing task contexts, conversation requirements, and known codebase context, classify those files by architecture/subsystem ownership, then replace the old task breakdown with one todo item per file classification group.

${CHECKLIST_FORMAT_COMMON}
- CRITICAL: In refine / planning flows, first identify every file that must be created, modified, or deleted, then classify those files into architecture-based execution units. Group ALL files of the same architectural layer (e.g., backend, frontend, shared library) into ONE todo item. Aim for the MINIMUM number of coarse-grained tasks. Do NOT create one task per file or one task per feature within the same layer.
- CRITICAL: In refine / planning flows, do NOT pack file paths into the todo text. Keep each todo text as a concise architecture/subsystem classification name, and put exact classified file targets in \`item_plan_targets\`.
- FORBIDDEN: Do NOT create a todo item for planning/specification-only work or any similar cross-cutting concern. Put only the essential supporting context for a task in \`item_contexts\` (aligned with each checklist line), NOT as standalone todo items. Every todo item must represent a concrete implementation unit (a group of files to create/modify), not a planning/specification artifact.
- CRITICAL: Every rewritten todo item must have a task context. Do not use empty strings in \`item_contexts\` unless the row is already completed and genuinely irrelevant to future execution. Each active or pending task context should be enough for an isolated build subagent to understand its architecture role, boundaries, and dependencies without seeing sibling tasks.
- CRITICAL: Every active or pending refine todo item must have a non-empty matching \`item_plan_targets\` inner array. This is an array aligned with \`todos\`; each inner array lists the exact classified target files for that todo as { "target": "relative/path.ext", "action": "CREATE|MODIFY|DELETE" }. The system records these targets as empty STEP 1 plan skeletons; STEP 2 later fills the same targets with detailed bodies via \`write_todo_plan\`.

${CORE_PRINCIPLES}

Example: File-target extraction and classification for a full-stack web app
{ "todos": "[-] Backend application layer\n[ ] Frontend application layer", "item_contexts": ["## Task Context\n- Architecture role: Own backend API, data model, middleware, and package changes.\n- Boundaries: Modify only the backend targets listed in item_plan_targets.\n- Dependencies: Provide API behavior consumed by frontend targets.", "## Task Context\n- Architecture role: Own frontend pages, styles, and browser logic.\n- Boundaries: Modify only the frontend targets listed in item_plan_targets.\n- Dependencies: Consume backend API behavior."], "item_plan_targets": [[{"target":"server.js","action":"CREATE"},{"target":"routes/api.js","action":"CREATE"},{"target":"models/user.js","action":"CREATE"},{"target":"middleware/auth.js","action":"CREATE"},{"target":"package.json","action":"MODIFY"}],[{"target":"public/index.html","action":"CREATE"},{"target":"public/login.html","action":"CREATE"},{"target":"public/css/style.css","action":"CREATE"},{"target":"public/js/app.js","action":"CREATE"},{"target":"public/js/game.js","action":"CREATE"},{"target":"public/js/login.js","action":"CREATE"}]] }

Example: File-target extraction and classification for a monorepo
{ "todos": "[-] Core library package\n[ ] CLI package\n[ ] Shared configuration", "item_contexts": ["## Task Context\n- Architecture role: Own core library runtime and exported types.\n- Boundaries: Modify only core package targets.\n- Dependencies: Expose behavior consumed by CLI package.", "## Task Context\n- Architecture role: Own command-line entrypoints and command behavior.\n- Boundaries: Modify only CLI package targets.\n- Dependencies: Consume core library behavior.", "## Task Context\n- Architecture role: Own cross-package build and lint configuration.\n- Boundaries: Modify only shared configuration targets.\n- Dependencies: Support both core and CLI packages."], "item_plan_targets": [[{"target":"packages/core/src/engine.ts","action":"MODIFY"},{"target":"packages/core/src/types.ts","action":"MODIFY"},{"target":"packages/core/package.json","action":"MODIFY"}],[{"target":"packages/cli/src/index.ts","action":"MODIFY"},{"target":"packages/cli/src/commands.ts","action":"MODIFY"},{"target":"packages/cli/package.json","action":"MODIFY"}],[{"target":"tsconfig.base.json","action":"MODIFY"},{"target":"package.json","action":"MODIFY"},{"target":".eslintrc.js","action":"MODIFY"}]] }

Example: Every active/pending item gets a task context
{ "todos": "[-] Backend API layer\n[ ] Frontend auth layer", "item_contexts": ["## Task Context\n- Architecture role: Own the backend auth API and user model changes.\n- Boundaries: Modify only the backend targets listed in item_plan_targets.\n- Dependencies: Produce the auth API contract consumed by the frontend task.", "## Task Context\n- Architecture role: Own the frontend auth UI and API client changes.\n- Boundaries: Modify only the frontend targets listed in item_plan_targets.\n- Dependencies: Consume the backend auth API contract."], "item_plan_targets": [[{"target":"src/server.ts","action":"MODIFY"},{"target":"src/routes/auth.ts","action":"MODIFY"},{"target":"src/models/user.ts","action":"MODIFY"}],[{"target":"src/App.tsx","action":"MODIFY"},{"target":"src/api/auth.ts","action":"MODIFY"},{"target":"src/pages/Login.tsx","action":"MODIFY"}]] }

${WHEN_TO_USE}`

const REFINE_TODOS_PARAM = `Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress. The list replaces the previous todo list in full. In refine / planning flows, each row must be one architecture/subsystem classification group derived from the files that need to be created, modified, or deleted. Group ALL files of the same architectural layer into ONE todo item, producing the MINIMUM number of coarse-grained tasks. Do not list file paths in the todo text; put exact classified file targets in item_plan_targets instead.`

const REFINE_ITEM_CONTEXTS_PARAM = `Required in refine mode. Array of markdown strings, one per line in \`todos\` (same order, same length). Every active or pending todo should receive a non-empty task context. Use empty string "" only for completed rows that are genuinely irrelevant to future execution; if unsure, write a concise context instead.

MANDATORY — Task Context Content: Each non-empty entry must start with "## Task Context" and include the task's architecture role, owned files/modules, boundaries, and dependencies/integration direction. The subagent will not see sibling task contexts.

For non-empty entries: include only the task-specific context needed for autonomous implementation, such as requirements, dependencies, boundaries, and any exact snippets that truly must be preserved.`

const REFINE_ITEM_PLAN_TARGETS_PARAM = `Required in refine mode. Highest priority in STEP 1. This field is the visible output of the file-target extraction and classification pass. Array of arrays aligned with \`todos\` (same order, same length). Each active or pending todo item must have a non-empty inner array listing every exact file target owned by that architecture/subsystem classification group. Each target object must be { "target": "relative/project/file.ext", "action": "CREATE|MODIFY|DELETE" }.

The system records these targets as empty STEP 1 plan skeletons in the same internal plan storage used by write_todo_plan. In STEP 2, use write_todo_plan to fill these same targets with detailed plan bodies. Do not put plan body text here. Do not duplicate the same file target across unfinished todo items.`

// ── Factory function ──

export function createUpdateTodoListTool(refineMode = false): OpenAI.Chat.ChatCompletionTool {
	const properties: Record<string, unknown> = {
		todos: {
			type: "string",
			description: refineMode ? REFINE_TODOS_PARAM : NORMAL_TODOS_PARAM,
		},
	}
	if (refineMode) {
		properties.item_contexts = {
			type: "array",
			items: { type: "string" },
			description: REFINE_ITEM_CONTEXTS_PARAM,
		}
		properties.item_plan_targets = {
			type: "array",
			items: {
				type: "array",
				items: {
					type: "object",
					properties: {
						target: {
							type: "string",
							description: "Relative project file path owned by the aligned todo item",
						},
						action: {
							type: "string",
							enum: ["CREATE", "MODIFY", "DELETE"],
							description: "Expected file operation for this target",
						},
					},
					required: ["target", "action"],
					additionalProperties: false,
				},
			},
			description: REFINE_ITEM_PLAN_TARGETS_PARAM,
		}
	}
	return {
		type: "function",
		function: {
			name: "update_todo_list",
			description: refineMode ? REFINE_DESCRIPTION : NORMAL_DESCRIPTION,
			strict: true,
			parameters: {
				type: "object",
				properties,
				required: refineMode ? ["todos", "item_contexts", "item_plan_targets"] : ["todos"],
				additionalProperties: false,
			},
		},
	}
}

// Default export for backward compatibility (normal mode)
export default createUpdateTodoListTool(false)
