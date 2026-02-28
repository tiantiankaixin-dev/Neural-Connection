import * as path from "path"
import * as fs from "fs/promises"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { fileExistsAtPath } from "../../utils/fs"
import { getTaskMemoryPath, getTaskSummariesPath } from "../../utils/storage"
import { GlobalFileNames } from "../../shared/globalFileNames"
import type { SummaryEntry } from "../webview/SummaryPanel"

// ────────────────────────────────────────────────────────────────────────────
// Summary persistence — memory/summaries/summary_{id}.json
// ────────────────────────────────────────────────────────────────────────────

/**
 * Persist a single summary entry to memory/summaries/summary_{id}.json.
 * Called by the condense system after generating a summary.
 */
export async function saveSummaryEntry(globalStoragePath: string, taskId: string, entry: SummaryEntry): Promise<void> {
	const summariesDir = await getTaskSummariesPath(globalStoragePath, taskId)
	const fileName = `summary_${entry.id}.json`
	const filePath = path.join(summariesDir, fileName)
	await safeWriteJson(filePath, entry)
}

/**
 * Load all persisted summary entries from memory/summaries/.
 * Returns an empty array if the directory doesn't exist or is empty.
 */
export async function loadAllSummaryEntries(globalStoragePath: string, taskId: string): Promise<SummaryEntry[]> {
	const summariesDir = await getTaskSummariesPath(globalStoragePath, taskId)

	try {
		const files = await fs.readdir(summariesDir)
		const jsonFiles = files.filter((f) => f.startsWith("summary_") && f.endsWith(".json"))

		const entries: SummaryEntry[] = []
		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(summariesDir, file), "utf8")
				const entry = JSON.parse(content) as SummaryEntry
				entries.push(entry)
			} catch (error) {
				console.warn(`[memory-persistence] Failed to parse ${file}:`, error)
			}
		}

		// Sort by timestamp ascending (oldest first)
		entries.sort((a, b) => a.timestamp - b.timestamp)
		return entries
	} catch (error) {
		return []
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Global Summary Q persistence — memory/global_summary.json
// ────────────────────────────────────────────────────────────────────────────

export interface PersistedGlobalSummary {
	text: string
	condenseId: string
	timestamp: number
	sourceSummaryCount: number
}

/**
 * Persist the current Global Summary Q to memory/global_summary.json.
 * Called after autoUpdateGlobalSummary completes.
 */
export async function saveGlobalSummary(
	globalStoragePath: string,
	taskId: string,
	summary: PersistedGlobalSummary,
): Promise<void> {
	const memoryDir = await getTaskMemoryPath(globalStoragePath, taskId)
	const filePath = path.join(memoryDir, GlobalFileNames.globalSummary)
	await safeWriteJson(filePath, summary)
}

/**
 * Load the persisted Global Summary Q from memory/global_summary.json.
 * Returns null if the file doesn't exist.
 */
export async function loadGlobalSummary(
	globalStoragePath: string,
	taskId: string,
): Promise<PersistedGlobalSummary | null> {
	const memoryDir = await getTaskMemoryPath(globalStoragePath, taskId)
	const filePath = path.join(memoryDir, GlobalFileNames.globalSummary)

	if (!(await fileExistsAtPath(filePath))) {
		return null
	}

	try {
		const content = await fs.readFile(filePath, "utf8")
		return JSON.parse(content) as PersistedGlobalSummary
	} catch (error) {
		console.warn("[memory-persistence] Failed to load global summary:", error)
		return null
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Conversation memory export/import
// ────────────────────────────────────────────────────────────────────────────

export interface ConversationMemoryManifest {
	version: number
	taskId: string
	exportedAt: string
	summaryCount: number
	hasGlobalSummary: boolean
}

const CONVERSATION_MEMORY_VERSION = 1

/**
 * Export conversation memory (summaries + global summary) to a destination folder.
 *
 * Exported folder structure:
 *   <destFolder>/
 *     manifest.json              — metadata about the export
 *     summaries/                 — individual summary .json files
 *       summary_{id}.json
 *     global_summary/            — global summary Q .json file
 *       global_summary.json
 */
export async function exportConversationMemory(
	globalStoragePath: string,
	taskId: string,
	destFolder: string,
): Promise<{ summaryCount: number; hasGlobalSummary: boolean }> {
	// Load data
	const summaries = await loadAllSummaryEntries(globalStoragePath, taskId)
	const globalSummary = await loadGlobalSummary(globalStoragePath, taskId)

	// Create destination directories
	const summariesDir = path.join(destFolder, "summaries")
	const globalSummaryDir = path.join(destFolder, "global_summary")
	await fs.mkdir(summariesDir, { recursive: true })
	await fs.mkdir(globalSummaryDir, { recursive: true })

	// Write individual summaries
	for (const entry of summaries) {
		const fileName = `summary_${entry.id}.json`
		const filePath = path.join(summariesDir, fileName)
		await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf8")
	}

	// Write global summary
	const hasGlobalSummary = globalSummary !== null
	if (globalSummary) {
		const filePath = path.join(globalSummaryDir, GlobalFileNames.globalSummary)
		await fs.writeFile(filePath, JSON.stringify(globalSummary, null, 2), "utf8")
	}

	// Write manifest
	const manifest: ConversationMemoryManifest = {
		version: CONVERSATION_MEMORY_VERSION,
		taskId,
		exportedAt: new Date().toISOString(),
		summaryCount: summaries.length,
		hasGlobalSummary,
	}
	await fs.writeFile(path.join(destFolder, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")

	return { summaryCount: summaries.length, hasGlobalSummary }
}

/**
 * Import conversation memory from an exported folder into a task's memory storage.
 *
 * Expected folder structure:
 *   <srcFolder>/
 *     manifest.json              — (optional) metadata
 *     summaries/                 — individual summary .json files
 *       summary_{id}.json
 *     global_summary/            — global summary Q .json file
 *       global_summary.json
 *
 * @returns The number of summaries imported and whether a global summary was imported
 */
export async function importConversationMemory(
	globalStoragePath: string,
	taskId: string,
	srcFolder: string,
): Promise<{ summaryCount: number; hasGlobalSummary: boolean }> {
	let summaryCount = 0
	let hasGlobalSummary = false

	// Import individual summaries
	const summariesDir = path.join(srcFolder, "summaries")
	if (await fileExistsAtPath(summariesDir)) {
		const files = await fs.readdir(summariesDir)
		const jsonFiles = files.filter((f) => f.startsWith("summary_") && f.endsWith(".json"))

		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(summariesDir, file), "utf8")
				const entry = JSON.parse(content) as SummaryEntry
				await saveSummaryEntry(globalStoragePath, taskId, entry)
				summaryCount++
			} catch (error) {
				console.warn(`[memory-persistence] Failed to import summary ${file}:`, error)
			}
		}
	}

	// Import global summary
	const globalSummaryDir = path.join(srcFolder, "global_summary")
	if (await fileExistsAtPath(globalSummaryDir)) {
		const globalSummaryPath = path.join(globalSummaryDir, GlobalFileNames.globalSummary)
		if (await fileExistsAtPath(globalSummaryPath)) {
			try {
				const content = await fs.readFile(globalSummaryPath, "utf8")
				const summary = JSON.parse(content) as PersistedGlobalSummary
				await saveGlobalSummary(globalStoragePath, taskId, summary)
				hasGlobalSummary = true
			} catch (error) {
				console.warn("[memory-persistence] Failed to import global summary:", error)
			}
		}
	}

	return { summaryCount, hasGlobalSummary }
}

/**
 * Read the best available summary text from an exported memory folder.
 * Prefers global summary; falls back to merging individual summaries.
 *
 * @returns The summary text, or null if the folder contains no usable data
 */
export async function readConversationMemorySummaryText(srcFolder: string): Promise<string | null> {
	// Try global summary first
	const globalSummaryDir = path.join(srcFolder, "global_summary")
	if (await fileExistsAtPath(globalSummaryDir)) {
		const globalSummaryPath = path.join(globalSummaryDir, GlobalFileNames.globalSummary)
		if (await fileExistsAtPath(globalSummaryPath)) {
			try {
				const content = await fs.readFile(globalSummaryPath, "utf8")
				const summary = JSON.parse(content) as PersistedGlobalSummary
				if (summary.text?.trim()) {
					return summary.text.trim()
				}
			} catch (error) {
				console.warn("[memory-persistence] Failed to read global summary text:", error)
			}
		}
	}

	// Fall back to merging individual summaries
	const summariesDir = path.join(srcFolder, "summaries")
	if (await fileExistsAtPath(summariesDir)) {
		try {
			const files = await fs.readdir(summariesDir)
			const jsonFiles = files.filter((f) => f.startsWith("summary_") && f.endsWith(".json"))

			const entries: SummaryEntry[] = []
			for (const file of jsonFiles) {
				try {
					const content = await fs.readFile(path.join(summariesDir, file), "utf8")
					entries.push(JSON.parse(content) as SummaryEntry)
				} catch {}
			}

			if (entries.length > 0) {
				entries.sort((a, b) => a.timestamp - b.timestamp)
				const merged = entries.map((e, i) => `### Summary ${i + 1}\n${e.text}`).join("\n\n")
				return merged.trim()
			}
		} catch {}
	}

	return null
}
