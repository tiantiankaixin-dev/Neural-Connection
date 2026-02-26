import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath, getTaskContextPath } from "../../utils/storage"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	// Priority 1: New location — context/ subdirectory
	const contextDir = await getTaskContextPath(globalStoragePath, taskId)
	const newPath = path.join(contextDir, GlobalFileNames.uiMessages)

	if (await fileExistsAtPath(newPath)) {
		try {
			const parsedData = JSON.parse(await fs.readFile(newPath, "utf8"))
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readTaskMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${newPath}`,
				)
				return []
			}
			return parsedData
		} catch (error) {
			console.warn(
				`[readTaskMessages] Failed to parse ${newPath} for task ${taskId}, returning empty: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	// Priority 2: Legacy location — task root directory
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const legacyPath = path.join(taskDir, GlobalFileNames.uiMessages)

	if (await fileExistsAtPath(legacyPath)) {
		try {
			const parsedData = JSON.parse(await fs.readFile(legacyPath, "utf8"))
			if (!Array.isArray(parsedData)) {
				console.warn(
					`[readTaskMessages] Parsed legacy data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${legacyPath}`,
				)
				return []
			}
			return parsedData
		} catch (error) {
			console.warn(
				`[readTaskMessages] Failed to parse legacy ${legacyPath} for task ${taskId}, returning empty: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	return []
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const contextDir = await getTaskContextPath(globalStoragePath, taskId)
	const filePath = path.join(contextDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages)
}
