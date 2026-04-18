import type OpenAI from "openai"

// ── Shared fragments ──

const CHECKLIST_FORMAT_COMMON = `Checklist Format:
- Use a single-level markdown checklist (no nesting or subtasks)
- List todos in the intended execution order
- Status options: [ ] (pending), [x] (completed), [-] (in progress)
- Write each todo as a concrete action, not a vague phase label
- If a todo requires creating one or more new files, explicitly include every new relative file path in that todo item
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
- When file creation is required, spell out the new file paths directly in the relevant todo items
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

const REFINE_DESCRIPTION = `Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. In refine / planning flows, use this tool to replace the old task breakdown with a better decomposition based on the architectural layer of the project.

${CHECKLIST_FORMAT_COMMON}
- CRITICAL: In refine / planning flows, rewrite the whole list into architecture-based execution units: group ALL files of the same architectural layer (e.g., backend, frontend, shared library) into ONE todo item. Aim for the MINIMUM number of coarse-grained tasks. Do NOT create one task per file or one task per feature within the same layer.
- FORBIDDEN: Do NOT create a todo item for planning/specification-only work or any similar cross-cutting concern. Put only the essential supporting context for a task in \`item_contexts\` (aligned with each checklist line), NOT as standalone todo items. Every todo item must represent a concrete implementation unit (a group of files to create/modify), not a planning/specification artifact.

${CORE_PRINCIPLES}

Example: Architecture-based grouping for a full-stack web app
{ "todos": "[-] Backend: server.js, routes/api.js, models/user.js, middleware/auth.js, package.json\\n[ ] Frontend: public/index.html, public/login.html, public/css/style.css, public/js/app.js, public/js/game.js, public/js/login.js" }

Example: Architecture-based grouping for a monorepo
{ "todos": "[-] Core library: packages/core/src/engine.ts, packages/core/src/types.ts, packages/core/package.json\\n[ ] CLI package: packages/cli/src/index.ts, packages/cli/src/commands.ts, packages/cli/package.json\\n[ ] Shared config: tsconfig.base.json, package.json, .eslintrc.js" }

Example: With per-item shared context — tasks that must honor the same requirement should receive the SAME relevant context
{ "todos": "[-] Backend: src/api.ts, src/models.ts\\n[ ] Frontend: src/ui/App.tsx", "item_contexts": ["## Shared Context\\n- Use the existing JWT auth flow.\\n- Keep route names and storage keys consistent with the current app.", "## Shared Context\\n- Use the existing JWT auth flow.\\n- Keep route names and storage keys consistent with the current app."] }

${WHEN_TO_USE}`

const REFINE_TODOS_PARAM = `Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress. The list replaces the previous todo list in full. In refine / planning flows, rewrite it into architecture-based execution units: group ALL files of the same architectural layer into ONE todo item, producing the MINIMUM number of coarse-grained tasks. If any todo involves creating files, explicitly include every new relative file path in that todo item. Each file path named in a todo should be owned by that todo alone and must not also appear in another unfinished todo that modifies the same file.`

const REFINE_ITEM_CONTEXTS_PARAM = `Required in refine mode. Array of markdown strings, one per line in \`todos\` (same order, same length). Use empty string "" when a row has no extra context.

CRITICAL — Shared Context Rule: If multiple tasks must independently honor the same requirement, dependency, convention, or integration detail, ALL of those tasks MUST receive the relevant text in their respective item_contexts entry. The build subagent for each task is isolated and has no access to other tasks' contexts; omitting shared context from an affected task can lead to incompatible or incomplete output.

For non-empty entries: include only the task-specific context needed for autonomous implementation, such as requirements, dependencies, constraints, conventions, and any exact snippets that truly must be preserved.`

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
				required: refineMode ? ["todos", "item_contexts"] : ["todos"],
				additionalProperties: false,
			},
		},
	}
}

// Default export for backward compatibility (normal mode)
export default createUpdateTodoListTool(false)
