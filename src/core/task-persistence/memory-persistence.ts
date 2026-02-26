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
// Per-task memory persistence — memory/task_memories.json
// ────────────────────────────────────────────────────────────────────────────

export interface TaskMemoryEntry {
	id: string
	rooTaskId: string
	status: "active" | "completed"
	title: string
	description: string
	previousContextSummary: string
	taskSummary: string
	keyFiles: string[]
	tags: string[]
	startedAt: string
	completedAt: string | null
	conversationRef: {
		taskId: string
		messageCountAtStart: number
		messageCountAtEnd: number | null
	}
}

export interface TaskMemoryStore {
	version: number
	tasks: TaskMemoryEntry[]
}

const TASK_MEMORY_STORE_VERSION = 1

/**
 * Save the task memory store to memory/task_memories.json within the task directory.
 */
export async function saveTaskMemoryStore(
	globalStoragePath: string,
	taskId: string,
	store: TaskMemoryStore,
): Promise<void> {
	const memoryDir = await getTaskMemoryPath(globalStoragePath, taskId)
	const filePath = path.join(memoryDir, GlobalFileNames.taskMemories)
	await safeWriteJson(filePath, store)
}

/**
 * Load the task memory store from memory/task_memories.json.
 * Returns a fresh store if the file doesn't exist.
 */
export async function loadTaskMemoryStore(globalStoragePath: string, taskId: string): Promise<TaskMemoryStore> {
	const memoryDir = await getTaskMemoryPath(globalStoragePath, taskId)
	const filePath = path.join(memoryDir, GlobalFileNames.taskMemories)

	if (!(await fileExistsAtPath(filePath))) {
		return { version: TASK_MEMORY_STORE_VERSION, tasks: [] }
	}

	try {
		const content = await fs.readFile(filePath, "utf8")
		const store = JSON.parse(content) as TaskMemoryStore

		if (store.version !== TASK_MEMORY_STORE_VERSION) {
			return { version: TASK_MEMORY_STORE_VERSION, tasks: store.tasks || [] }
		}

		return store
	} catch (error) {
		console.warn("[memory-persistence] Failed to load task memory store:", error)
		return { version: TASK_MEMORY_STORE_VERSION, tasks: [] }
	}
}
