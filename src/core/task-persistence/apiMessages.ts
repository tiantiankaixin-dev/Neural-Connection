import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import { Anthropic } from "@anthropic-ai/sdk"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath, getTaskContextPath } from "../../utils/storage"
import type { RooMessage, RooMessageHistory } from "./rooMessage"
import { ROO_MESSAGE_VERSION } from "./rooMessage"
import { convertAnthropicToRooMessages } from "./converters/anthropicToRoo"

export type ApiMessage = Anthropic.MessageParam & {
	ts?: number
	isSummary?: boolean
	id?: string
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
	// Identifies the global summary Q message (merged from all completed sub-task summaries)
	// Only ONE global summary should be visible at a time; old ones get tagged with new Q's condenseParent
	isGlobalSummary?: boolean
	// Identifies a rolling (rough) summary generated mid-task for progressive context compression.
	// Rolling summaries accumulate: each new one incorporates the previous rolling summary + new messages.
	// On task completion, a precise summary replaces the rolling summary.
	isRollingSummary?: boolean
	// Identifies a context summary generated during todo list transitions.
	// Contains condensed context from the previous todo list's conversation to bootstrap the new task.
	isContextSummary?: boolean
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	// Priority 1: New location — context/ subdirectory
	const contextDir = await getTaskContextPath(globalStoragePath, taskId)
	const newPath = path.join(contextDir, GlobalFileNames.apiConversationHistory)

	if (await fileExistsAtPath(newPath)) {
		const fileContent = await fs.readFile(newPath, "utf8")
		try {
			const parsedData = JSON.parse(fileContent)
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readApiMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${newPath}`,
				)
				return []
			}
			if (parsedData.length === 0) {
				console.error(
					`[Roo-Debug] readApiMessages: Found API conversation history file, but it's empty (parsed as []). TaskId: ${taskId}, Path: ${newPath}`,
				)
			}
			return parsedData
		} catch (error) {
			console.warn(
				`[readApiMessages] Error parsing API conversation history file, returning empty. TaskId: ${taskId}, Path: ${newPath}, Error: ${error}`,
			)
			return []
		}
	}

	// Priority 2: Legacy location — task root directory
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const legacyPath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	if (await fileExistsAtPath(legacyPath)) {
		const fileContent = await fs.readFile(legacyPath, "utf8")
		try {
			const parsedData = JSON.parse(fileContent)
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readApiMessages] Parsed legacy data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${legacyPath}`,
				)
				return []
			}
			if (parsedData.length === 0) {
				console.error(
					`[Roo-Debug] readApiMessages: Found legacy API conversation history file, but it's empty (parsed as []). TaskId: ${taskId}, Path: ${legacyPath}`,
				)
			}
			return parsedData
		} catch (error) {
			console.warn(
				`[readApiMessages] Error parsing legacy API conversation history file, returning empty. TaskId: ${taskId}, Path: ${legacyPath}, Error: ${error}`,
			)
			return []
		}
	}

	// Priority 3: Very old location — claude_messages.json
	const oldPath = path.join(taskDir, "claude_messages.json")

	if (await fileExistsAtPath(oldPath)) {
		const fileContent = await fs.readFile(oldPath, "utf8")
		try {
			const parsedData = JSON.parse(fileContent)
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readApiMessages] Parsed OLD data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${oldPath}`,
				)
				return []
			}
			if (parsedData.length === 0) {
				console.error(
					`[Roo-Debug] readApiMessages: Found OLD API conversation history file (claude_messages.json), but it's empty (parsed as []). TaskId: ${taskId}, Path: ${oldPath}`,
				)
			}
			await fs.unlink(oldPath)
			return parsedData
		} catch (error) {
			console.warn(
				`[readApiMessages] Error parsing OLD API conversation history file (claude_messages.json), returning empty. TaskId: ${taskId}, Path: ${oldPath}, Error: ${error}`,
			)
			// DO NOT unlink oldPath if parsing failed.
			return []
		}
	}

	// If we reach here, no history file was found at any location.
	console.error(
		`[Roo-Debug] readApiMessages: API conversation history file not found for taskId: ${taskId}. Expected at: ${newPath}`,
	)
	return []
}

export async function saveApiMessages({
	messages,
	taskId,
	globalStoragePath,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
}) {
	const contextDir = await getTaskContextPath(globalStoragePath, taskId)
	const filePath = path.join(contextDir, GlobalFileNames.apiConversationHistory)
	await safeWriteJson(filePath, messages)
}

// ────────────────────────────────────────────────────────────────────────────
// RooMessage versioned storage
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether parsed JSON data is the new versioned RooMessage format
 * or the legacy Anthropic array format.
 */
export function detectFormat(data: unknown): "v2" | "legacy" {
	if (
		data &&
		typeof data === "object" &&
		!Array.isArray(data) &&
		"version" in data &&
		(data as Record<string, unknown>).version === ROO_MESSAGE_VERSION &&
		Array.isArray((data as Record<string, unknown>).messages)
	) {
		return "v2"
	}
	return "legacy"
}

/**
 * Read a conversation history file and return `RooMessage[]`.
 *
 * - If the file is in v2 format (`{ version: 2, messages: [...] }`), the
 *   messages are returned directly.
 * - If the file is a plain array (legacy Anthropic format), the messages
 *   are auto-converted via {@link convertAnthropicToRooMessages}.
 * - Falls back to `claude_messages.json` when the primary file is missing.
 */
export async function readRooMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<RooMessage[]> {
	const tryParseFile = async (targetPath: string): Promise<RooMessage[] | null> => {
		if (!(await fileExistsAtPath(targetPath))) {
			return null
		}

		const fileContent = await fs.readFile(targetPath, "utf8")
		let parsedData: unknown

		try {
			parsedData = JSON.parse(fileContent)
		} catch (error) {
			console.warn(
				`[readRooMessages] Error parsing file, returning empty. TaskId: ${taskId}, Path: ${targetPath}, Error: ${error}`,
			)
			return []
		}

		const format = detectFormat(parsedData)

		if (format === "v2") {
			return (parsedData as RooMessageHistory).messages
		}

		if (!Array.isArray(parsedData)) {
			console.warn(
				`[readRooMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${targetPath}`,
			)
			return []
		}

		return convertAnthropicToRooMessages(parsedData as ApiMessage[])
	}

	// Priority 1: New location — context/ subdirectory
	const contextDir = await getTaskContextPath(globalStoragePath, taskId)
	const newPath = path.join(contextDir, GlobalFileNames.apiConversationHistory)
	const newResult = await tryParseFile(newPath)
	if (newResult !== null) {
		return newResult
	}

	// Priority 2: Legacy location — task root
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const legacyPath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	const legacyResult = await tryParseFile(legacyPath)
	if (legacyResult !== null) {
		return legacyResult
	}

	// Priority 3: Very old location
	const oldPath = path.join(taskDir, "claude_messages.json")
	const fallbackResult = await tryParseFile(oldPath)
	if (fallbackResult !== null) {
		return fallbackResult
	}

	console.error(
		`[Roo-Debug] readRooMessages: API conversation history file not found for taskId: ${taskId}. Expected at: ${newPath}`,
	)
	return []
}

/**
 * Save `RooMessage[]` wrapped in the versioned `RooMessageHistory` envelope.
 *
 * Always writes to `api_conversation_history.json` using {@link safeWriteJson}
 * for atomic, corruption-resistant persistence.
 *
 * @returns `true` on success, `false` on failure.
 */
export async function saveRooMessages({
	messages,
	taskId,
	globalStoragePath,
}: {
	messages: RooMessage[]
	taskId: string
	globalStoragePath: string
}): Promise<boolean> {
	try {
		const contextDir = await getTaskContextPath(globalStoragePath, taskId)
		const filePath = path.join(contextDir, GlobalFileNames.apiConversationHistory)
		const envelope: RooMessageHistory = {
			version: ROO_MESSAGE_VERSION,
			messages,
		}
		await safeWriteJson(filePath, envelope)
		return true
	} catch (error) {
		console.error(`[saveRooMessages] Failed to save messages for taskId: ${taskId}. Error: ${error}`)
		return false
	}
}
