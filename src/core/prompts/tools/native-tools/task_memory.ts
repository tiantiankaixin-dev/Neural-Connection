import type OpenAI from "openai"

const TASK_MEMORY_DESCRIPTION = `Autonomous sub-task lifecycle and context management tool. Use this to organize your work into sub-tasks, each getting its own condensed summary for efficient context usage.

**WHEN TO USE:**
- Call with action "start" at the BEGINNING of every new sub-task to record what you're about to do
- Call with action "end" when you FINISH a sub-task — this automatically condenses the sub-task's conversation into a summary
- Call with action "query" to search past task memories for relevant context

**CONTEXT MANAGEMENT:**
When you call "end", the conversation messages for this sub-task are automatically condensed into a labeled summary. The model will then see: [summary_1] + [summary_2] + ... + [current_conversation]. This replaces the old monolithic Auto-Condense with intelligent per-sub-task summaries.

**IMPORTANT:** This tool is designed for AI-autonomous use. You should proactively call it without being asked. Break your work into logical sub-tasks for optimal context management.

Parameters:
- action: (required) "start", "end", or "query"

For "start":
- title: (required) Short title describing the sub-task
- description: (required) What you're about to do
- previous_context_summary: (required) Summary of conversation context before this sub-task
- tags: (optional) Array of categorization tags

For "end":
- task_memory_id: (required) ID returned from the "start" call
- task_summary: (required) Detailed summary of what was accomplished (also used as condensation input)
- key_files: (optional) Array of important files that were modified
- tags: (optional) Additional tags to add

For "query":
- query: (optional) Search query to find relevant past tasks
- tags: (optional) Filter by tags

Example: Starting a task
{
  "action": "start",
  "title": "Fix login bug",
  "description": "User reported login fails on mobile. Investigating auth flow.",
  "previous_context_summary": "User previously discussed project setup and database schema design.",
  "tags": ["bugfix", "auth"]
}

Example: Ending a task
{
  "action": "end",
  "task_memory_id": "abc-123",
  "task_summary": "Fixed login bug by correcting token refresh logic in auth.ts. Added retry mechanism for network failures.",
  "key_files": ["src/auth/token.ts", "src/auth/login.ts"]
}

Example: Querying past tasks
{
  "action": "query",
  "query": "authentication",
  "tags": ["auth"]
}`

export default {
	type: "function",
	function: {
		name: "task_memory",
		description: TASK_MEMORY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["start", "end", "query"],
					description: "The action to perform: start a task, end a task, or query past tasks",
				},
				title: {
					type: ["string", "null"],
					description: "Short title for the task (required for 'start')",
				},
				description: {
					type: ["string", "null"],
					description: "Description of what you're about to do (required for 'start')",
				},
				previous_context_summary: {
					type: ["string", "null"],
					description:
						"Summary of conversation context before this task, enabling future context restoration (required for 'start')",
				},
				task_memory_id: {
					type: ["string", "null"],
					description: "ID of the task memory to close (required for 'end')",
				},
				task_summary: {
					type: ["string", "null"],
					description: "Detailed summary of what was accomplished during the task (required for 'end')",
				},
				key_files: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Array of important files modified during the task (optional, for 'end')",
				},
				query: {
					type: ["string", "null"],
					description: "Search query to find relevant past tasks (optional, for 'query')",
				},
				tags: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Categorization tags (optional, for 'start'/'end'/'query')",
				},
			},
			required: [
				"action",
				"title",
				"description",
				"previous_context_summary",
				"task_memory_id",
				"task_summary",
				"key_files",
				"query",
				"tags",
			],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
