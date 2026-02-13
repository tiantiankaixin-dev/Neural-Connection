import type OpenAI from "openai"

/**
 * Progressive Tool Disclosure
 *
 * Reduces token usage and biases the model toward using codebase_search (RAG)
 * by only fully exposing prioritized tools. Other tools are stripped to
 * name + brief description until the model "discovers" them by calling once.
 *
 * Flow:
 * 1. First API call: codebase_search = full definition; others = name-only
 * 2. Model calls a stripped tool → intercepted, full schema returned as guidance
 * 3. Tool marked as "discovered" → subsequent calls include full definition
 */

// Tools that are ALWAYS fully exposed with enhanced descriptions
// Includes codebase_search (RAG priority) + essential conversation tools
const PRIORITIZED_TOOLS = new Set([
	"codebase_search",
	"attempt_completion",
	"ask_followup_question",
	"update_todo_list",
])

// Brief one-line descriptions for stripped tools
const TOOL_BRIEFS: Record<string, string> = {
	read_file: "Read file contents at a path",
	search_files: "Search files with regex patterns",
	list_files: "List directory contents",
	apply_diff: "Apply code changes via diff",
	write_to_file: "Create or overwrite a file",
	execute_command: "Run a terminal command",
	read_command_output: "Read output from a running command",
	browser_action: "Browser automation actions",
	use_mcp_tool: "Use an MCP server tool",
	access_mcp_resource: "Access an MCP resource",
	ask_followup_question: "Ask the user a clarifying question",
	attempt_completion: "Mark the task as complete",
	switch_mode: "Switch to a different mode",
	new_task: "Create a new subtask",
	update_todo_list: "Update the task todo list",
	generate_image: "Generate an image",
	run_slash_command: "Run a slash command",
	skill: "Load and execute a skill",
	edit: "Edit file content with search/replace",
	search_replace: "Search and replace in a file",
	edit_file: "Edit a file using search/replace",
	apply_patch: "Apply a patch in codex format",
}

// Cache full tool definitions so we can return them when a stripped tool is "discovered"
const fullToolDefinitionCache = new Map<string, OpenAI.Chat.ChatCompletionTool>()

/**
 * Apply progressive disclosure to a tools array.
 *
 * @param tools - The fully-defined filtered tools array
 * @param discoveredTools - Set of tool names the model has already discovered
 * @returns Transformed tools array with progressive disclosure applied
 */
export function applyProgressiveDisclosure(
	tools: OpenAI.Chat.ChatCompletionTool[],
	discoveredTools: Set<string>,
): OpenAI.Chat.ChatCompletionTool[] {
	// Cache full definitions before stripping
	for (const tool of tools) {
		const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
		if (fn?.name) {
			fullToolDefinitionCache.set(fn.name, structuredClone(tool))
		}
	}

	return tools.map((tool) => {
		const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
		if (!fn?.name) return tool

		const name = fn.name

		// Prioritized tools: always fully exposed
		if (PRIORITIZED_TOOLS.has(name)) {
			return tool
		}

		// Discovered tools: fully exposed
		if (discoveredTools.has(name)) {
			return tool
		}

		// Other tools: stripped to name + brief description + empty params
		const brief = TOOL_BRIEFS[name] || fn.description?.split(".")[0] || name

		return {
			type: "function",
			function: {
				name,
				description: brief,
				parameters: {
					type: "object",
					properties: {},
				},
			},
		} as OpenAI.Chat.ChatCompletionTool
	})
}

/**
 * Check if a tool is currently in stripped (undiscovered) state.
 */
export function isStrippedTool(toolName: string, discoveredTools: Set<string>): boolean {
	return !PRIORITIZED_TOOLS.has(toolName) && !discoveredTools.has(toolName)
}

/**
 * Get the full tool schema as a human-readable string for returning to the model
 * when it calls a stripped tool for the first time.
 */
export function getFullToolSchemaText(toolName: string): string {
	const tool = fullToolDefinitionCache.get(toolName)
	if (!tool) {
		return `Tool "${toolName}" schema not available.`
	}

	const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
	if (!fn) {
		return `Tool "${toolName}" schema not available.`
	}

	let text = `## Tool Discovered: ${toolName}\n\n`
	text += `${fn.description}\n\n`

	if (fn.parameters && "properties" in fn.parameters) {
		const props = fn.parameters.properties as Record<string, { type?: string | string[]; description?: string }>
		const required = (fn.parameters.required as string[]) || []

		if (Object.keys(props).length > 0) {
			text += `### Parameters:\n`
			for (const [key, value] of Object.entries(props)) {
				const isRequired = required.includes(key)
				const typeStr = Array.isArray(value.type) ? value.type.join(" | ") : value.type || "any"
				text += `- **${key}** (${typeStr}${isRequired ? ", required" : ", optional"}): ${value.description || ""}\n`
			}
		}
	}

	text += `\nPlease call \`${toolName}\` again with the correct parameters.`
	return text
}
