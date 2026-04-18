import type OpenAI from "openai"
import accessMcpResource from "./access_mcp_resource"
import { apply_diff } from "./apply_diff"
import applyPatch from "./apply_patch"
import askFollowupQuestion from "./ask_followup_question"
import attemptCompletion from "./attempt_completion"
import browserAction from "./browser_action"
import { codebaseSearchPrecise, codebaseSearchBroad } from "./codebase_search"
import editTool from "./edit"
import commandStatus from "./command_status"
import executeCommand from "./execute_command"
import generateImage from "./generate_image"
import findByName from "./find_by_name"
import listFiles from "./list_files"
import multiEdit from "./multi_edit"
import readNotebook from "./read_notebook"
import editNotebook from "./edit_notebook"
import viewContentChunk from "./view_content_chunk"
import createMemory from "./create_memory"
import readCommandOutput from "./read_command_output"
import readTerminal from "./read_terminal"
import readUrlContent from "./read_url_content"
import searchWeb from "./search_web"
import recallMemory from "./recall_memory"
import { createReadFileTool, type ReadFileToolOptions } from "./read_file"
import runSlashCommand from "./run_slash_command"
import skill from "./skill"
import searchReplace from "./search_replace"
import edit_file from "./edit_file"
import searchFiles from "./search_files"
import switchMode from "./switch_mode"
import updateTodoList, { createUpdateTodoListTool } from "./update_todo_list"
import writeTodoPlan from "./write_todo_plan"
import writeToFile from "./write_to_file"

export { getMcpServerTools } from "./mcp_server"
export { convertOpenAIToolToAnthropic, convertOpenAIToolsToAnthropic } from "./converters"
export type { ReadFileToolOptions } from "./read_file"

/**
 * Options for customizing the native tools array.
 */
export interface NativeToolsOptions {
	/** Whether the model supports image processing (default: false) */
	supportsImages?: boolean
}

const subagentAttemptCompletion: OpenAI.Chat.ChatCompletionTool = {
	...attemptCompletion,
	function: {
		...attemptCompletion.function,
		description:
			"Use this when your assigned subtask is finished or cannot be completed further. The tool results returned in this conversation are the authoritative execution feedback for the subagent; you do not need extra user confirmation before calling attempt_completion. After you have finished the required reads/writes/searches for your assigned files and the latest tool results indicate success, call attempt_completion immediately with a concise summary. If the subtask is blocked by missing files, ownership limits, or tool limitations, call attempt_completion with a concise explanation of the blocker.",
	},
}

/**
 * Get native tools array, optionally customizing based on settings.
 *
 * @param options - Configuration options for the tools
 * @returns Array of native tool definitions
 */
export function getNativeTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		codebaseSearchBroad, // RAG semantic search (broad) - placed first for model primacy bias
		codebaseSearchPrecise, // RAG semantic search (precise)
		accessMcpResource,
		apply_diff,
		applyPatch,
		askFollowupQuestion,
		attemptCompletion,
		browserAction,
		executeCommand,
		commandStatus,
		generateImage,
		listFiles,
		findByName,
		multiEdit,
		readNotebook,
		editNotebook,
		viewContentChunk,
		createMemory,
		readCommandOutput,
		readTerminal,
		readUrlContent,
		searchWeb,
		recallMemory,
		createReadFileTool(readFileOptions),
		runSlashCommand,
		skill,
		searchReplace,
		edit_file,
		editTool,
		searchFiles,
		switchMode,
		updateTodoList,
		writeToFile,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

/**
 * Get the planning/exploration tool set for refine mode.
 *
 * Refine uses an OpenCode-style planning environment: read-only code exploration,
 * todo-list restructuring, follow-up questions, and internal plan writing.
 */
export function getRefineOnlyTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		codebaseSearchBroad,
		codebaseSearchPrecise,
		askFollowupQuestion,
		listFiles,
		findByName,
		createReadFileTool(readFileOptions),
		searchFiles,
		viewContentChunk,
		readUrlContent,
		searchWeb,
		createUpdateTodoListTool(true),
		writeTodoPlan,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

/**
 * Tools available to parallel subagents during build phase.
 * A focused subset: read + write + search + completion. No browser, MCP, or command execution.
 */
export function getSubagentTools(options: NativeToolsOptions = {}): OpenAI.Chat.ChatCompletionTool[] {
	const { supportsImages = false } = options

	const readFileOptions: ReadFileToolOptions = {
		supportsImages,
	}

	return [
		createReadFileTool(readFileOptions),
		listFiles,
		searchFiles,
		writeToFile,
		subagentAttemptCompletion,
	] satisfies OpenAI.Chat.ChatCompletionTool[]
}

// Backward compatibility: export default tools with line ranges enabled
export const nativeTools = getNativeTools()
