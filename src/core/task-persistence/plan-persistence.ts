import * as path from "path"
import * as fs from "fs/promises"

import {
	getTaskDirectoryPath,
	getTaskOptimizePath,
	getTaskOptimizeTimestampPath,
	getTaskOptimizePlanPath,
} from "../../utils/storage"

export interface PlanFile {
	filePath: string
	content: string
}

export interface PlanReadResult {
	plans: PlanFile[]
	contexts: string[]
}

export type PlanTargetAction = "CREATE" | "MODIFY" | "DELETE" | "GENERAL"

export interface StructuredPlanEntry {
	target: string
	action: PlanTargetAction
	body: string
}

export interface PlanSaveResult {
	savedPaths: string[]
}

interface ParsedPlanTargetHeader {
	action: PlanTargetAction
	path: string
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

function sanitizeConversationFolderName(name: string): string {
	return (
		name
			// eslint-disable-next-line no-control-regex
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
			.replace(/\s+/g, "_")
			.substring(0, 80)
			.replace(/_+$/, "") || "unnamed"
	)
}

function sanitizeConversationPathSegment(segment: string): string {
	const trimmed = segment.trim()
	if (!trimmed || trimmed === "." || trimmed === "..") {
		return ""
	}

	return (
		trimmed
			// eslint-disable-next-line no-control-regex
			.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
			.replace(/\s+/g, "_")
			.substring(0, 120)
			.replace(/_+$/, "") || "unnamed"
	)
}

function looksLikeProjectFilePath(value: string): boolean {
	const trimmed = value.trim()
	if (!trimmed) {
		return false
	}

	if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
		return true
	}

	if (/^\.{1,2}[\\/]/.test(trimmed)) {
		return true
	}

	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return true
	}

	return /^[^\s]+\.[A-Za-z0-9_-]{1,12}$/.test(trimmed)
}

export function normalizeStructuredPlanEntry(planType: PlanType, entry: StructuredPlanEntry): StructuredPlanEntry {
	const normalizedTarget =
		planType === "file" ? entry.target.trim().replace(/\\/g, "/").replace(/\/+/g, "/") : entry.target.trim()

	return {
		target: normalizedTarget,
		action: entry.action,
		body: entry.body.trim(),
	}
}

export function validateStructuredPlanEntry(entry: StructuredPlanEntry, planType: PlanType): string | null {
	if (!entry.target) {
		return "Each plan entry must include a non-empty target"
	}

	if (!entry.body) {
		return `Plan entry for \"${entry.target}\" must include a non-empty body`
	}

	if (planType === "general") {
		if (entry.action !== "GENERAL") {
			return `General plan entry for \"${entry.target}\" must use ACTION: GENERAL`
		}

		if (looksLikeProjectFilePath(entry.target)) {
			return `General plan entry for \"${entry.target}\" must use a descriptive section title, not a file path`
		}

		return null
	}

	if (!["CREATE", "MODIFY", "DELETE"].includes(entry.action)) {
		return `File plan entry for \"${entry.target}\" must use ACTION: CREATE, MODIFY, or DELETE`
	}

	if (/^[A-Za-z]:\//.test(entry.target) || entry.target.startsWith("/") || entry.target.startsWith("../")) {
		return `File plan entry for \"${entry.target}\" must use a relative project file path`
	}

	if (!looksLikeProjectFilePath(entry.target)) {
		return `File plan entry for \"${entry.target}\" must use a real relative project file path`
	}

	return null
}

export function buildPlanEntryContent(entry: StructuredPlanEntry): string {
	return [
		"<<<PLAN_TARGET>>>",
		`ACTION: ${entry.action}`,
		`PATH: ${entry.target}`,
		"<<<END_PLAN_TARGET>>>",
		entry.body,
	]
		.join("\n")
		.trim()
}

export function parsePlanTargetHeader(content: string): ParsedPlanTargetHeader | null {
	const match = content.match(
		/^<<<PLAN_TARGET>>>\r?\nACTION: (CREATE|MODIFY|DELETE|GENERAL)\r?\nPATH: ([^\r\n]+)\r?\n<<<END_PLAN_TARGET>>>(?:\r?\n|$)/,
	)

	if (!match) {
		return null
	}

	return {
		action: match[1] as PlanTargetAction,
		path: match[2].trim(),
	}
}

function isLikelyFileLeafSegment(segment: string): boolean {
	return /\.[A-Za-z0-9_-]{1,12}$/.test(segment)
}

export function getConversationDirectorySegmentsForPlan(plan: PlanFile): string[] {
	const parsedHeader = parsePlanTargetHeader(plan.content)
	const rawTargetPath = parsedHeader?.path ?? plan.filePath
	const rawSegments = rawTargetPath
		.split(/[\\/]+/)
		.map((segment) => segment.trim())
		.filter(Boolean)

	if (rawSegments.length === 0) {
		return []
	}

	const treatLastSegmentAsFile = parsedHeader
		? parsedHeader.action !== "GENERAL"
		: rawSegments.length > 1 && isLikelyFileLeafSegment(rawSegments[rawSegments.length - 1])

	const directorySegments = treatLastSegmentAsFile ? rawSegments.slice(0, -1) : rawSegments
	return directorySegments.map(sanitizeConversationPathSegment).filter(Boolean)
}

async function ensureConversationPlanDirectories(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoContent: string,
	plans: PlanFile[],
): Promise<void> {
	if (!taskTimestamp || plans.length === 0) {
		return
	}

	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const itemDir = path.join(taskDir, "task", taskTimestamp, sanitizeConversationFolderName(todoContent))
	await fs.mkdir(itemDir, { recursive: true })

	for (const plan of plans) {
		const segments = getConversationDirectorySegmentsForPlan(plan)
		if (segments.length === 0) {
			continue
		}

		await fs.mkdir(path.join(itemDir, ...segments), { recursive: true })
	}
}

function getPlanStorageDirectorySegmentsForPlan(plan: PlanFile): string[] {
	const parsedHeader = parsePlanTargetHeader(plan.content)
	const rawTargetPath = parsedHeader?.path ?? plan.filePath
	const rawSegments = rawTargetPath
		.split(/[\\/]+/)
		.map(sanitizeConversationPathSegment)
		.filter(Boolean)

	if (rawSegments.length === 0) {
		return []
	}

	if (parsedHeader?.action === "GENERAL") {
		return rawSegments
	}

	return rawSegments.slice(0, -1)
}

function buildPlanMarkdown(
	todoItemId: string,
	todoContent: string,
	planType: PlanType,
	plans: PlanFile[],
	context?: string,
): string {
	const lines: string[] = [
		`<!-- todoItemId: ${todoItemId} -->`,
		`<!-- planType: ${planType} -->`,
		`# ${todoContent}`,
		"",
	]

	if (context && context.trim()) {
		lines.push("<!-- BEGIN_TASK_CONTEXT -->", context.trim(), "<!-- END_TASK_CONTEXT -->", "")
	}

	for (const plan of plans) {
		lines.push(`## ${plan.filePath}`, "", plan.content, "", "---", "")
	}

	return lines.join("\n")
}

async function deleteExistingPlanFilesForTodo(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoItemId: string,
): Promise<void> {
	const directoriesToScan = new Set<string>()

	if (taskTimestamp) {
		directoriesToScan.add(await getTaskOptimizeTimestampPath(globalStoragePath, taskId, taskTimestamp))
	}

	directoriesToScan.add(await getTaskOptimizePath(globalStoragePath, taskId))

	const visitedFiles = new Set<string>()
	for (const optimizeDir of directoriesToScan) {
		for (const filePath of await collectMarkdownPlanFiles(optimizeDir)) {
			if (visitedFiles.has(filePath)) {
				continue
			}
			visitedFiles.add(filePath)

			const raw = await fs.readFile(filePath, "utf8")
			const idMatch = raw.match(/<!-- todoItemId: (.+?) -->/)
			if (idMatch?.[1] === todoItemId) {
				await fs.unlink(filePath).catch(() => {})
			}
		}
	}
}

async function collectMarkdownPlanFiles(directory: string): Promise<string[]> {
	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(directory, { withFileTypes: true })
	} catch {
		return []
	}

	const files: string[] = []
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownPlanFiles(entryPath)))
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(entryPath)
		}
	}

	return files
}

/**
 * Save refine plans for a todo item.
 *
 * - file plans: stored under task_optimize/{taskTimestamp}/{PATH...}/{sanitized_todo_content}.md
 * - general plans: stored under task_optimize/{taskTimestamp}/{taskTimestamp}+plan/{sanitized_todo_content}.md
 *
 * The todoItemId is embedded in the file header so it can be recovered during reading.
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
	context?: string,
): Promise<PlanSaveResult> {
	const callSuffix = Date.now()
	const safeName = sanitizeFileName(`${todoContent}__${todoItemId}__${callSuffix}`)

	await ensureConversationPlanDirectories(globalStoragePath, taskId, taskTimestamp, todoContent, plans)

	if (planType === "general" && taskTimestamp) {
		const optimizeDir = await getTaskOptimizePlanPath(globalStoragePath, taskId, taskTimestamp)
		const planFilePath = path.join(optimizeDir, `${safeName}.md`)
		await fs.writeFile(planFilePath, buildPlanMarkdown(todoItemId, todoContent, planType, plans, context), "utf8")
		return { savedPaths: [planFilePath] }
	}

	if (planType === "file" && taskTimestamp) {
		const optimizeDir = await getTaskOptimizeTimestampPath(globalStoragePath, taskId, taskTimestamp)
		const plansByTargetDir = new Map<string, { dirSegments: string[]; plans: PlanFile[] }>()

		for (const plan of plans) {
			const dirSegments = getPlanStorageDirectorySegmentsForPlan(plan)
			const dirKey = dirSegments.join("/")
			const existing = plansByTargetDir.get(dirKey)
			if (existing) {
				existing.plans.push(plan)
			} else {
				plansByTargetDir.set(dirKey, { dirSegments, plans: [plan] })
			}
		}

		const savedPaths: string[] = []
		let contextWritten = false
		for (const { dirSegments, plans: groupedPlans } of plansByTargetDir.values()) {
			const targetDir = dirSegments.length > 0 ? path.join(optimizeDir, ...dirSegments) : optimizeDir
			await fs.mkdir(targetDir, { recursive: true })
			const planFilePath = path.join(targetDir, `${safeName}.md`)
			await fs.writeFile(
				planFilePath,
				buildPlanMarkdown(
					todoItemId,
					todoContent,
					planType,
					groupedPlans,
					contextWritten ? undefined : context,
				),
				"utf8",
			)
			contextWritten = true
			savedPaths.push(planFilePath)
		}

		return { savedPaths }
	}

	const optimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)
	const planFilePath = path.join(optimizeDir, `${safeName}.md`)
	await fs.writeFile(planFilePath, buildPlanMarkdown(todoItemId, todoContent, planType, plans, context), "utf8")
	return { savedPaths: [planFilePath] }
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
): Promise<PlanReadResult> {
	const resultsById: PlanFile[] = []
	const fallbackResultsByContent: PlanFile[] = []
	const contextsById: string[] = []
	const contextsByContent: string[] = []
	const directoriesToScan: string[] = []

	if (taskTimestamp) {
		directoriesToScan.push(await getTaskOptimizeTimestampPath(globalStoragePath, taskId, taskTimestamp))
	}

	const legacyOptimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)
	if (!directoriesToScan.includes(legacyOptimizeDir)) {
		directoriesToScan.push(legacyOptimizeDir)
	}

	const visitedFiles = new Set<string>()
	for (const optimizeDir of directoriesToScan) {
		for (const filePath of await collectMarkdownPlanFiles(optimizeDir)) {
			if (visitedFiles.has(filePath)) {
				continue
			}
			visitedFiles.add(filePath)

			const raw = await fs.readFile(filePath, "utf8")

			const idMatch = raw.match(/<!-- todoItemId: (.+?) -->/)
			const headingMatch = raw.match(/^# (.+)$/m)
			const matchesId = !!idMatch && idMatch[1] === todoItemId
			const matchesContent = !!todoContent && headingMatch?.[1]?.trim() === todoContent
			if (!matchesId && !matchesContent) continue

			// Extract context block if present (only keep first occurrence)
			const contextMatch = raw.match(/<!-- BEGIN_TASK_CONTEXT -->\r?\n([\s\S]*?)\r?\n<!-- END_TASK_CONTEXT -->/)
			if (contextMatch) {
				const ctxText = contextMatch[1].trim()
				if (ctxText) {
					if (matchesId) {
						contextsById.push(ctxText)
					} else {
						contextsByContent.push(ctxText)
					}
				}
			}

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

	if (resultsById.length > 0) {
		return { plans: resultsById, contexts: contextsById }
	}
	return { plans: fallbackResultsByContent, contexts: contextsByContent }
}

/**
 * Get the set of todoItemIds that have plan files.
 */
export async function getRefinedTodoItemIds(globalStoragePath: string, taskId: string): Promise<Set<string>> {
	const refined = new Set<string>()
	const optimizeDir = await getTaskOptimizePath(globalStoragePath, taskId)

	for (const filePath of await collectMarkdownPlanFiles(optimizeDir)) {
		const raw = await fs.readFile(filePath, "utf8")
		const idMatch = raw.match(/<!-- todoItemId: (.+?) -->/)
		if (idMatch) {
			refined.add(idMatch[1])
		}
	}

	return refined
}
