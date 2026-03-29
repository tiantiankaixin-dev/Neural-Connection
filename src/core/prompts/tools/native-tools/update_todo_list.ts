import type OpenAI from "openai"

const UPDATE_TODO_LIST_DESCRIPTION = `Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. This tool is designed for step-by-step task tracking, allowing you to confirm completion of each step before updating, update multiple task statuses at once (e.g., mark one as completed and start the next), and dynamically add new todos discovered during long or complex tasks.

Checklist Format:
- Use a single-level markdown checklist (no nesting or subtasks)
- List todos in the intended execution order
- Status options: [ ] (pending), [x] (completed), [-] (in progress)
- Write each todo as a concrete action, not a vague phase label
- If a todo requires creating one or more new files, explicitly include every new relative file path in that todo item
- Do not use vague wording like "create needed files", "add new components", or "set up files" without naming the files
- If the exact file paths are not known yet, add a discovery/planning todo first and later replace it with concrete file-creation todos once known
- Each todo that touches files fully owns every file path it names; those files must not also appear in another active or pending todo as files to modify
- Do not split responsibility for the same file across multiple todo items; if multiple changes touch one file, merge them into one owning todo or first reorganize the todo list

Core Principles:
- Before updating, always confirm which todos have been completed
- You may update multiple statuses in a single update
- Add new actionable items as they're discovered
- Only mark a task as completed when fully accomplished
- Keep all unfinished tasks unless explicitly instructed to remove
- When file creation is required, spell out the new file paths directly in the relevant todo items
- Preserve clear file ownership boundaries so parallel or subsequent subtasks do not collide on the same file

Example: Initial task list
{ "todos": "[x] Analyze requirements\\n[x] Design architecture\\n[-] Implement core logic\\n[ ] Write tests\\n[ ] Update documentation" }

Example: After completing implementation
{ "todos": "[x] Analyze requirements\\n[x] Design architecture\\n[x] Implement core logic\\n[-] Write tests\\n[ ] Update documentation\\n[ ] Add performance benchmarks" }

Example: File creation must be explicit
{ "todos": "[x] Analyze requirements\\n[-] Create src/core/task/Task.ts and src/core/tools/WriteTodoPlanTool.ts changes\\n[ ] Create docs/refine-plan-format.md\\n[ ] Update webview-ui/src/components/chat/ChatRow.tsx" }

Example: File ownership must not overlap across todos
{ "todos": "[x] Analyze requirements\\n[-] Modify src/core/task/Task.ts and src/core/prompts/tools/native-tools/write_todo_plan.ts for refine prompt rules\\n[ ] Modify src/core/prompts/tools/native-tools/update_todo_list.ts and src/core/prompts/tools/native-tools/new_task.ts for todo ownership rules" }

When to Use:
- Task involves multiple steps or requires ongoing tracking
- Need to update status of several todos at once
- New actionable items are discovered during execution
- Task is complex and benefits from stepwise progress tracking

When NOT to Use:
- Only a single, trivial task
- Task can be completed in one or two simple steps
- Request is purely conversational or informational`

const TODOS_PARAMETER_DESCRIPTION = `Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress. If any todo involves creating files, explicitly include every new relative file path in that todo item. Each file path named in a todo should be owned by that todo alone and must not also appear in another unfinished todo that modifies the same file.`

export default {
	type: "function",
	function: {
		name: "update_todo_list",
		description: UPDATE_TODO_LIST_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				todos: {
					type: "string",
					description: TODOS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["todos"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
