import type OpenAI from "openai"

const CODEBASE_SEARCH_DESCRIPTION = `Find files most relevant to the search queries using semantic search. Searches based on meaning rather than exact text matches. By default searches entire workspace. Queries MUST be in English (translate if needed).

**CRITICAL: For ANY exploration of code you haven't examined yet in this conversation, you MUST use this tool FIRST before any other search or file exploration tools.** This applies throughout the entire conversation, not just at the beginning.

**IMPORTANT: Always provide multiple diverse queries in a single call.** The tool searches each query separately and merges the results, giving much better coverage than a single query. Include:
1. The user's exact wording
2. Specific class/function names (e.g., "GameManager class definition")
3. Broader conceptual queries (e.g., "game state management and lifecycle")
4. Related functionality (e.g., "player initialization and spawning")

Parameters:
- query: (required) Array of search queries. Always provide 2-4 diverse queries from different angles. Include specific identifiers (class names, function names) in at least one query — they enable keyword-based supplement search.
- path: (optional) Limit search to specific subdirectory (relative to the current workspace directory). Leave empty for entire workspace.

Example: Exploring authentication system
{ "query": ["User login and password hashing", "AuthService session management", "token validation middleware"], "path": null }

Example: Exploring a specific class
{ "query": ["GameManager class definition", "game state management lifecycle", "GameManager Initialize UpdateState"], "path": "Assets/Scripts" }`

const QUERY_PARAMETER_DESCRIPTION = `Array of meaning-based search queries from different angles. Always provide 2-4 diverse queries for comprehensive results.`

const PATH_PARAMETER_DESCRIPTION = `Optional subdirectory (relative to the workspace) to limit the search scope`

export default {
	type: "function",
	function: {
		name: "codebase_search",
		description: CODEBASE_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "array",
					items: { type: "string" },
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				path: {
					type: ["string", "null"],
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
