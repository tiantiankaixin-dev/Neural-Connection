import * as path from "path"
import * as fs from "fs/promises"

import { getTaskOptimizePath, getTaskOptimizeTimestampPath, getTaskOptimizePlanPath } from "../../utils/storage"

export interface PlanFile {
	filePath: string
	content: string
}

/**
 * Sanitize a string into a valid, readable filename.
 */
function sanitizeFileName(name: string): string {
	return (
		name
			// eslint-disable-next-line no-control-regex
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
			.replace(/\s+/g, "_")
			.substring(0, 80)
			.replace(/_+$/, "") || "plan"
	)
}

/**
 * Save all plan entries for a todo item into a single .md file.
 * Stored at: task_optimize/{sanitized_todo_content}.md
 *
 * All plan files live directly inside task_optimize/ (no subfolders).
 * The todoItemId is embedded in the file header so it can be recovered
 * during reading without relying on folder names or file paths.
 * If the same todo item is refined again the file is overwritten.
 */
export type PlanType = "file" | "general"

export async function savePlanFiles(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoItemId: string,
	todoContent: string,
	plans: PlanFile[],
	planType: PlanType = "file",
): Promise<string> {
	let optimizeDir: string
	if (planType === "general" && taskTimestamp) {
		optimizeDir = await getTaskOptimizePlanPath(globalStoragePath, taskId, taskTimestamp)
	} else if (taskTimestamp) {
		optimizeDir = await getTaskOptimizeTimestampPath(globalStoragePath, taskId, taskTimestamp)
	} else {
		optimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)
	}

	const safeName = sanitizeFileName(todoContent)
	const planFilePath = path.join(optimizeDir, `${safeName}.md`)

	const lines: string[] = [
		`<!-- todoItemId: ${todoItemId} -->`,
		`<!-- planType: ${planType} -->`,
		`# ${todoContent}`,
		"",
	]

	for (const plan of plans) {
		lines.push(`## ${plan.filePath}`, "", plan.content, "", "---", "")
	}

	await fs.writeFile(planFilePath, lines.join("\n"), "utf8")
	return planFilePath
}

/**
 * Read all plan files for a specific todo item.
 * Scans .md files directly in task_optimize/ for those
 * whose header contains the matching todoItemId.
 */
export async function readPlanFiles(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoItemId: string,
	todoContent?: string,
): Promise<PlanFile[]> {
	const resultsById: PlanFile[] = []
	const fallbackResultsByContent: PlanFile[] = []
	const directoriesToScan: string[] = []

	if (taskTimestamp) {
		directoriesToScan.push(await getTaskOptimizeTimestampPath(globalStoragePath, taskId, taskTimestamp))
		directoriesToScan.push(await getTaskOptimizePlanPath(globalStoragePath, taskId, taskTimestamp))
	}

	const legacyOptimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)
	if (!directoriesToScan.includes(legacyOptimizeDir)) {
		directoriesToScan.push(legacyOptimizeDir)
	}

	for (const optimizeDir of directoriesToScan) {
		let entries: import("fs").Dirent[]
		try {
			entries = await fs.readdir(optimizeDir, { withFileTypes: true })
		} catch {
			continue
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue
			const filePath = path.join(optimizeDir, entry.name)
			const raw = await fs.readFile(filePath, "utf8")

			const idMatch = raw.match(/<!-- todoItemId: (.+?) -->/)
			const headingMatch = raw.match(/^# (.+)$/m)
			const matchesId = !!idMatch && idMatch[1] === todoItemId
			const matchesContent = !!todoContent && headingMatch?.[1]?.trim() === todoContent
			if (!matchesId && !matchesContent) continue

			const sections = raw.split(/^## /m).slice(1)
			for (const section of sections) {
				const newlineIdx = section.indexOf("\n")
				if (newlineIdx === -1) continue
				const sectionPath = section.substring(0, newlineIdx).trim()
				let sectionContent = section.substring(newlineIdx + 1).trim()
				sectionContent = sectionContent.replace(/\n---\s*$/, "").trim()
				const target = matchesId ? resultsById : fallbackResultsByContent
				target.push({ filePath: sectionPath, content: sectionContent })
			}
		}
	}

	return resultsById.length > 0 ? resultsById : fallbackResultsByContent
}

/**
 * Get the set of todoItemIds that have plan files.
 */
export async function getRefinedTodoItemIds(globalStoragePath: string, taskId: string): Promise<Set<string>> {
	const refined = new Set<string>()
	const optimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)

	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(optimizeDir, { withFileTypes: true })
	} catch {
		return refined
	}

	for (const entry of entries) {
		const targetDir = entry.isDirectory() ? path.join(optimizeDir, entry.name) : optimizeDir
		const targetEntries = entry.isDirectory()
			? await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
			: [entry]

		for (const targetEntry of targetEntries) {
			if (!targetEntry.isFile() || !targetEntry.name.endsWith(".md")) continue
			const filePath = path.join(targetDir, targetEntry.name)
			const raw = await fs.readFile(filePath, "utf8")
			const idMatch = raw.match(/<!-- todoItemId: (.+?) -->/)
			if (idMatch) {
				refined.add(idMatch[1])
			}
		}
	}

	return refined
}
