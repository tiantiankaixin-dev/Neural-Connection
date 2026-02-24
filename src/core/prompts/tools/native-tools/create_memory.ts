import type OpenAI from "openai"

const CREATE_MEMORY_DESCRIPTION = `Save important context relevant to the USER and their task to a persistent memory database.

Use this tool to save:
- User preferences
- Explicit user requests to remember something
- Important code snippets
- Technical stacks
- Project structure
- Major milestones or features
- New design patterns and architectural decisions
- Any other information important to remember

Before creating a new memory, check if a semantically related memory exists. If found, update it instead of creating a duplicate.

Parameters:
- Action: (required) 'create', 'update', or 'delete'
- Id: (required for update/delete) ID of existing memory to modify
- Title: (required for create/update) Descriptive title for the memory
- Content: (required for create/update) Content of the memory
- CorpusNames: (create only) Array of workspace corpus names associated with the memory
- Tags: (create only) Array of tags for filtering/retrieving the memory (use snake_case)
- UserTriggered: (required) Set to true if user explicitly asked to create/modify this memory

Example: Create a new memory
{
  "Action": "create",
  "Title": "Project uses React 18",
  "Content": "This project uses React 18 with TypeScript and TailwindCSS",
  "CorpusNames": ["user/project-name"],
  "Tags": ["tech_stack", "frontend"],
  "UserTriggered": false
}

Example: Update existing memory
{
  "Action": "update",
  "Id": "existing-memory-id",
  "Title": "Updated title",
  "Content": "Updated content",
  "UserTriggered": true
}`

export default {
	type: "function",
	function: {
		name: "create_memory",
		description: CREATE_MEMORY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				Action: {
					type: "string",
					enum: ["create", "update", "delete"],
					description: "The type of action to perform on the memory",
				},
				Id: {
					type: ["string", "null"],
					description: "ID of existing memory to update or delete (leave null for create)",
				},
				Title: {
					type: ["string", "null"],
					description: "Descriptive title for the memory (required for create/update)",
				},
				Content: {
					type: ["string", "null"],
					description: "Content of the memory (required for create/update, null for delete)",
				},
				CorpusNames: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Workspace corpus names associated with the memory (create only)",
				},
				Tags: {
					type: ["array", "null"],
					items: { type: "string" },
					description: "Tags for filtering/retrieving the memory (create only, use snake_case)",
				},
				UserTriggered: {
					type: "boolean",
					description: "Set to true if user explicitly asked to create/modify this memory",
				},
			},
			required: ["Action", "Id", "Title", "Content", "CorpusNames", "Tags", "UserTriggered"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
