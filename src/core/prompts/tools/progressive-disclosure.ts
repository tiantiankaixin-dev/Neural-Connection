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
	"codebase_search_broad",
	"codebase_search_precise",
	"attempt_completion",
	"ask_followup_question",
	"update_todo_list",
	"write_todo_plan",
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

	update_todo_list: "Update the task todo list",
	generate_image: "Generate an image",
	run_slash_command: "Run a slash command",
	skill: "Load and execute a skill",
	edit: "Edit file content with search/replace",
	search_replace: "Search and replace in a file",
	edit_file: "Edit a file using search/replace",
	apply_patch: "Apply a patch in codex format",
	// Cascade-style tools
	find_by_name: "Search for files and directories by name within a specified directory using glob patterns",
	command_status: "Check the status of a previously started terminal command by its ID",
	read_terminal: "Reads the contents of a terminal given its process ID",
	read_url_content: "Read content from a URL",
	search_web: "Performs a web search to get relevant web documents",
	multi_edit: "Performs multiple edits to a single file in one operation",
	read_notebook: "Read and parse a Jupyter notebook file",
	edit_notebook: "Completely replaces the contents of a specific cell in a Jupyter notebook",
	view_content_chunk: "View a specific chunk of a web or knowledge base document content",
	create_memory: "Save important context relevant to the USER and their task to a memory database",
	recall_memory: "Deep memory recall — drill down from summaries to retrieve original conversation messages",
	write_todo_plan: "Write detailed per-file implementation plans for a todo item",
}

// Tools that remain fully exposed when task is NOT yet established (task lock)
const TASK_LOCK_UNLOCKED_TOOLS = new Set(["update_todo_list", "ask_followup_question", "attempt_completion"])

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

/**
 * Apply task lock to a tools array.
 * When task is not established, ALL tools except update_todo_list and ask_followup_question
 * are stripped to name + "[LOCKED]" description with empty parameters.
 * This physically prevents the model from calling tools without first establishing a task.
 *
 * @param tools - The tools array to apply lock to
 * @returns Transformed tools array with task lock applied
 */
export function applyTaskLock(tools: OpenAI.Chat.ChatCompletionTool[]): OpenAI.Chat.ChatCompletionTool[] {
	// Cache full definitions before stripping (for later unlock)
	for (const tool of tools) {
		const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
		if (fn?.name) {
			fullToolDefinitionCache.set(fn.name, structuredClone(tool))
		}
	}

	return tools.map((tool) => {
		const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
		if (!fn?.name) return tool

		// Unlocked tools: fully exposed during task lock
		if (TASK_LOCK_UNLOCKED_TOOLS.has(fn.name)) {
			return tool
		}

		// All other tools: stripped to name + LOCKED notice
		const brief = TOOL_BRIEFS[fn.name] || fn.description?.split(".")[0] || fn.name
		return {
			type: "function",
			function: {
				name: fn.name,
				description: `[LOCKED] ${brief} — Call update_todo_list first to unlock all tools.`,
				parameters: {
					type: "object",
					properties: {},
				},
			},
		} as OpenAI.Chat.ChatCompletionTool
	})
}
