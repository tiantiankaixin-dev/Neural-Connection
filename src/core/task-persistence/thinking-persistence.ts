import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../utils/storage"

// ────────────────────────────────────────────────────────────────────────────
// Thinking Persistence — <task_dir>/thinking/
// ────────────────────────────────────────────────────────────────────────────

export interface ThinkingEntry {
	id: string
	timestamp: number
	originalLength: number
	text: string
}

/**
 * Get the thinking directory path for a task.
 */
export async function getThinkingPath(globalStoragePath: string, taskId: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const dir = path.join(taskDir, "thinking")
	await fs.mkdir(dir, { recursive: true })
	return dir
}

/**
 * Save a thinking entry to disk.
 */
export async function saveThinking(globalStoragePath: string, taskId: string, entry: ThinkingEntry): Promise<void> {
	const dir = await getThinkingPath(globalStoragePath, taskId)
	const filePath = path.join(dir, `thinking_${entry.id}.json`)
	await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8")
}

/**
 * Load all thinking entries for a task, sorted by timestamp.
 */
export async function loadAllThinking(globalStoragePath: string, taskId: string): Promise<ThinkingEntry[]> {
	const dir = await getThinkingPath(globalStoragePath, taskId)

	try {
		const files = await fs.readdir(dir)
		const jsonFiles = files.filter((f) => f.startsWith("thinking_") && f.endsWith(".json"))

		const entries: ThinkingEntry[] = []
		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(dir, file), "utf8")
				entries.push(JSON.parse(content) as ThinkingEntry)
			} catch {
				// Skip malformed files
			}
		}

		entries.sort((a, b) => a.timestamp - b.timestamp)
		return entries
	} catch {
		return []
	}
}
