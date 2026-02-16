import type OpenAI from "openai"

const QUERY_PARAMETER_DESCRIPTION = `Array of meaning-based search queries from different angles. Always provide 2-4 diverse queries for comprehensive results.`

const PATH_PARAMETER_DESCRIPTION = `Optional subdirectory (relative to the workspace) to limit the search scope`

const SHARED_PARAMETERS = {
	type: "object" as const,
	properties: {
		query: {
			type: "array" as const,
			items: { type: "string" as const },
			description: QUERY_PARAMETER_DESCRIPTION,
		},
		path: {
			type: ["string", "null"] as const,
			description: PATH_PARAMETER_DESCRIPTION,
		},
	},
	required: ["query", "path"] as const,
	additionalProperties: false as const,
}

/**
 * Precise mode: targeted symbol lookup by exact class/function name.
 */
export const codebaseSearchPrecise = {
	type: "function",
	function: {
		name: "codebase_search_precise",
		description: `Pinpoint search — find the exact definition or implementation of a KNOWN symbol.

**WHEN TO USE:** You already know the specific name (class, function, variable, interface) and need its source code. Think of it as "go to definition".
- User asks: "show me the GameManager class" → use this tool
- User asks: "find the resolveSearchConfig function" → use this tool
- User asks: "I need the PlayerController implementation" → use this tool

**WHEN NOT TO USE:** If you don't have a specific symbol name, use \`codebase_search_broad\` instead.

Provide 2-4 queries targeting the same symbol from different angles for best results.

Examples:
{ "query": ["GameManager class definition", "GameManager singleton implementation"], "path": "Scripts" }
{ "query": ["PlayerController class", "PlayerController MonoBehaviour"], "path": "Scripts/Player" }`,
		strict: true,
		parameters: SHARED_PARAMETERS,
	},
} satisfies OpenAI.Chat.ChatCompletionTool

/**
 * Broad mode: wide exploration of architecture, relationships, and concepts.
 */
export const codebaseSearchBroad = {
	type: "function",
	function: {
		name: "codebase_search_broad",
		description: `Discovery search — explore architecture, find related code, or understand how things connect.

**WHEN TO USE:** You want to understand a system, discover what exists, or find code related to a concept. Think of it as "explore and discover".
- User asks: "how does the player system work?" → use this tool
- User asks: "what handles input in this project?" → use this tool
- User asks: "show me how inventory is managed" → use this tool

**WHEN NOT TO USE:** If you already know the exact class/function name, use \`codebase_search_precise\` instead.

**CRITICAL: You MUST use this tool (or codebase_search_precise) FIRST before read_file, search_files, or list_files when exploring code you haven't examined yet.**

Provide 2-4 diverse queries covering different aspects of what you're looking for.

Examples:
{ "query": ["player movement and physics", "character controller input handling", "player jump and gravity"], "path": "Scripts/Player" }
{ "query": ["game state management", "scene lifecycle and transitions"], "path": null }`,
		strict: true,
		parameters: SHARED_PARAMETERS,
	},
} satisfies OpenAI.Chat.ChatCompletionTool

// Default export kept for backward compatibility (broad mode)
export default codebaseSearchBroad
