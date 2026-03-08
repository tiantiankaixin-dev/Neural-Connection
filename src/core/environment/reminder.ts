import { TodoItem, TodoStatus } from "@roo-code/types"

/**
 * Format the reminders section as a markdown block in English, with basic instructions.
 */
export function formatReminderSection(todoList?: TodoItem[]): string {
	if (!todoList || todoList.length === 0) {
		return "You have not created a todo list yet. Create one with `update_todo_list` if your task is complicated or involves multiple steps."
	}
	const statusMap: Record<TodoStatus, string> = {
		pending: "Pending",
		in_progress: "In Progress",
		completed: "Completed",
	}
	const lines: string[] = [
		"====",
		"",
		"REMINDERS",
		"",
		"Below is your current list of reminders for this task. Keep them updated as you progress.",
		"",
	]

	lines.push("| # | Content | Status |")
	lines.push("|---|---------|--------|")
	todoList.forEach((item, idx) => {
		const escapedContent = item.content.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
		lines.push(`| ${idx + 1} | ${escapedContent} | ${statusMap[item.status] || item.status} |`)
	})
	lines.push("")

	const allCompleted = todoList.length > 0 && todoList.every((item) => item.status === "completed")
	if (allCompleted) {
		lines.push(
			"",
			"ALL TASKS COMPLETED: Every item in the todo list is marked as completed. If the user has given you a NEW request or follow-up instructions, call `update_todo_list` to create a new task list for it. Otherwise, call `attempt_completion` to present the final result to the user.",
			"",
		)
	} else {
		lines.push(
			"",
			"IMPORTANT: When task status changes, remember to call the `update_todo_list` tool to update your progress.",
			"",
		)
	}
	return lines.join("\n")
}
