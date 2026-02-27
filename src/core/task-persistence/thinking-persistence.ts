import * as fs from "fs/promises"
import * as path from "path"
import { getTaskDirectoryPath } from "../../utils/storage"

// ────────────────────────────────────────────────────────────────────────────
// Thinking Summary Persistence — <task_dir>/thinking_summaries/
// ────────────────────────────────────────────────────────────────────────────

export interface ThinkingSummaryEntry {
	id: string
	timestamp: number
	originalLength: number
	summary: string
	original: string
}

/**
 * Get the thinking summaries directory path for a task.
 */
export async function getThinkingSummariesPath(globalStoragePath: string, taskId: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const dir = path.join(taskDir, "thinking_summaries")
	await fs.mkdir(dir, { recursive: true })
	return dir
}

/**
 * Save a thinking summary entry to disk.
 */
export async function saveThinkingSummary(
	globalStoragePath: string,
	taskId: string,
	entry: ThinkingSummaryEntry,
): Promise<void> {
	const dir = await getThinkingSummariesPath(globalStoragePath, taskId)
	const filePath = path.join(dir, `thinking_${entry.id}.json`)
	await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8")
}

/**
 * Load all thinking summary entries for a task, sorted by timestamp.
 */
export async function loadAllThinkingSummaries(
	globalStoragePath: string,
	taskId: string,
): Promise<ThinkingSummaryEntry[]> {
	const dir = await getThinkingSummariesPath(globalStoragePath, taskId)

	try {
		const files = await fs.readdir(dir)
		const jsonFiles = files.filter((f) => f.startsWith("thinking_") && f.endsWith(".json"))

		const entries: ThinkingSummaryEntry[] = []
		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(dir, file), "utf8")
				entries.push(JSON.parse(content) as ThinkingSummaryEntry)
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
