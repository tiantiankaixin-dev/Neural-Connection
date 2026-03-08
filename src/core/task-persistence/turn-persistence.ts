import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../utils/storage"
import { safeWriteJson } from "../../utils/safeWriteJson"

// ────────────────────────────────────────────────────────────────────────────
// Turn Persistence
//
// Folder structure:
//   <taskDir>/task/<timestamp>/
//     /<项目名>/                   ← todo item content (sanitized)
//       /消息1/                    ← turn 1
//         output.json             ← always created (input context + LLM output)
//         thinking.json           ← only created if reasoning exists
//       /消息2/
//       /消息3/
//     /<项目B>/
//     ...
//     assembled_result.json       ← generated on task completion
//
// The timestamp folder is created once when the task starts, using
// the format "YYYY-MM-DD_HH-mm-ss".
// ────────────────────────────────────────────────────────────────────────────

/**
 * Output record for a single LLM turn (saved as output.json).
 */
export interface TurnOutput {
	turnNumber: number
	timestamp: number
	todoItemId?: string
	todoItemContent?: string
	modelId?: string
	provider?: string
	input: {
		systemPrompt: string
		messages: any[]
		tools?: any[]
		metadata?: Record<string, any>
	}
	output: {
		assistantMessage: string
		toolCalls: any[]
	}
}

/**
 * Thinking/reasoning record for a single LLM turn (saved as thinking.json).
 */
export interface TurnThinking {
	turnNumber: number
	timestamp: number
	todoItemId?: string
	todoItemContent?: string
	reasoning: string
	reasoningLength: number
}

/**
 * Assembled result combining all turns for a task.
 */
export interface AssembledResult {
	taskTimestamp: string
	taskId: string
	assembledAt: number
	items: {
		itemName: string
		turns: {
			turnNumber: number
			output: TurnOutput
			thinking?: TurnThinking
		}[]
	}[]
}

/**
 * Generate a timestamp string for use as the task list folder name.
 * Format: "YYYY-MM-DD_HH-mm-ss"
 */
export function generateTaskTimestamp(): string {
	const now = new Date()
	const pad = (n: number) => String(n).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

/**
 * Sanitize a string for use as a filesystem folder name.
 * Removes characters that are invalid on Windows/Linux/macOS and collapses whitespace.
 */
function sanitizeFolderName(name: string, maxLength: number = 80): string {
	return (
		name
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
			.replace(/\s+/g, "_")
			.substring(0, maxLength)
			.replace(/_+$/, "") || "unnamed"
	)
}

/**
 * Get the base task turns directory:
 *   <taskDir>/task/<taskTimestamp>/
 */
async function getTaskTurnsBaseDir(globalStoragePath: string, taskId: string, taskTimestamp: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const baseDir = path.join(taskDir, "task", taskTimestamp)
	await fs.mkdir(baseDir, { recursive: true })
	return baseDir
}

/**
 * Get the message (turn) folder path:
 *   <taskDir>/task/<taskTimestamp>/<项目名>/消息N/
 *
 * If no itemContent is provided, uses "_general" as the item folder.
 */
async function getTurnFolderPath(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string,
	turnNumber: number,
	itemContent?: string,
): Promise<string> {
	const baseDir = await getTaskTurnsBaseDir(globalStoragePath, taskId, taskTimestamp)
	const itemFolder = itemContent ? sanitizeFolderName(itemContent) : "_general"
	const turnFolder = path.join(baseDir, itemFolder, `消息${turnNumber}`)
	await fs.mkdir(turnFolder, { recursive: true })
	return turnFolder
}

/**
 * Save turn output data (input context + LLM output) to disk.
 * Creates: <项目名>/消息N/output.json
 */
export async function saveTurnOutput(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string,
	itemContent: string | undefined,
	turnOutput: TurnOutput,
): Promise<void> {
	const turnDir = await getTurnFolderPath(
		globalStoragePath,
		taskId,
		taskTimestamp,
		turnOutput.turnNumber,
		itemContent,
	)
	await safeWriteJson(path.join(turnDir, "output.json"), turnOutput)
}

/**
 * Save turn thinking/reasoning data to disk.
 * Creates: <项目名>/消息N/thinking.json
 * Only called when reasoning content exists.
 */
export async function saveTurnThinking(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string,
	itemContent: string | undefined,
	thinking: TurnThinking,
): Promise<void> {
	const turnDir = await getTurnFolderPath(globalStoragePath, taskId, taskTimestamp, thinking.turnNumber, itemContent)
	await safeWriteJson(path.join(turnDir, "thinking.json"), thinking)
}

/**
 * Assemble all turn files for a task into a single result JSON.
 *
 * Walks: <taskDir>/task/<taskTimestamp>/<项目名>/消息N/{output.json, thinking.json}
 * Produces: <taskDir>/task/<taskTimestamp>/assembled_result.json
 */
export async function assembleTurns(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string,
): Promise<AssembledResult> {
	const baseDir = await getTaskTurnsBaseDir(globalStoragePath, taskId, taskTimestamp)

	const result: AssembledResult = {
		taskTimestamp,
		taskId,
		assembledAt: Date.now(),
		items: [],
	}

	try {
		const itemDirs = await fs.readdir(baseDir)

		for (const itemDir of itemDirs) {
			if (!itemDir || itemDir.endsWith(".json")) continue

			const itemPath = path.join(baseDir, itemDir)
			const stat = await fs.stat(itemPath)
			if (!stat.isDirectory()) continue

			// List turn folders (消息1, 消息2, ...)
			const turnDirs = await fs.readdir(itemPath)
			const messageDirs = turnDirs
				.filter((d) => /^消息\d+$/.test(d))
				.sort((a, b) => {
					const numA = parseInt(a.replace("消息", ""), 10)
					const numB = parseInt(b.replace("消息", ""), 10)
					return numA - numB
				})

			const turns: AssembledResult["items"][0]["turns"] = []

			for (const msgDir of messageDirs) {
				const turnNum = parseInt(msgDir.replace("消息", ""), 10)
				const msgPath = path.join(itemPath, msgDir)

				try {
					const outputContent = await fs.readFile(path.join(msgPath, "output.json"), "utf8")
					const output = JSON.parse(outputContent) as TurnOutput

					let thinking: TurnThinking | undefined
					try {
						const thinkingContent = await fs.readFile(path.join(msgPath, "thinking.json"), "utf8")
						thinking = JSON.parse(thinkingContent) as TurnThinking
					} catch {
						// No thinking file — expected for models without reasoning
					}

					turns.push({ turnNumber: turnNum, output, thinking })
				} catch {
					// Skip malformed turn folders
				}
			}

			if (turns.length > 0) {
				result.items.push({
					itemName: itemDir,
					turns,
				})
			}
		}
	} catch {
		// Task turns directory doesn't exist yet — return empty result
	}

	// Save assembled result
	const resultPath = path.join(baseDir, "assembled_result.json")
	await safeWriteJson(resultPath, result)

	return result
}

// Re-export helpers for testing
export { sanitizeFolderName as _sanitizeFolderName, generateTaskTimestamp as _generateTaskTimestamp }
