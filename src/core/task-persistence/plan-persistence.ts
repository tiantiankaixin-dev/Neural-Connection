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
	stubPlans: PlanFile[]
	contexts: string[]
}

export type PlanTargetAction = "CREATE" | "MODIFY" | "DELETE" | "GENERAL"

export interface StructuredPlanEntry {
	target: string
	action: PlanTargetAction
	body: string
}

export interface PlanTargetStubEntry {
	target: string
	action: Exclude<PlanTargetAction, "GENERAL">
}

export interface PlanSaveResult {
	savedPaths: string[]
}

export interface PlanFileAgreement {
	plan_target_path: string
	content: string
}

const PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE = "### Cross-Task Agreements Owned By This File"
const STEP1_PLAN_TARGET_STUB_MARKER = "<!-- STEP1_PLAN_TARGET_STUB -->"

interface ParsedPlanTargetHeader {
	action: PlanTargetAction
	path: string
}

interface ParsedPlanAgreementItem {
	text: string
	sharedWith: string[]
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

	if (/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
		return true
	}

	return /^[^\s]+\.[A-Za-z0-9_-]{1,12}$/.test(trimmed)
}

function inferGeneralPlanTarget(body: string): string {
	const heading = body.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim()
	return heading?.replace(/\s+#+$/, "").trim() ?? ""
}

function normalizePlanTarget(planType: PlanType, target: unknown, body: string): string {
	const rawTarget = typeof target === "string" ? target.trim() : ""
	if (planType === "file") {
		return rawTarget.replace(/\\/g, "/").replace(/\/+/g, "/")
	}
	return rawTarget || inferGeneralPlanTarget(body)
}

function normalizePlanAction(planType: PlanType, action: unknown): PlanTargetAction {
	const rawAction = typeof action === "string" ? action.trim().toUpperCase() : ""
	if (rawAction === "CREATE" || rawAction === "MODIFY" || rawAction === "DELETE" || rawAction === "GENERAL") {
		return rawAction
	}
	return planType === "general" ? "GENERAL" : ("" as PlanTargetAction)
}

export function normalizeStructuredPlanEntry(
	planType: PlanType,
	entry: Partial<StructuredPlanEntry>,
): StructuredPlanEntry {
	const body = typeof entry?.body === "string" ? entry.body.trim() : ""

	return {
		target: normalizePlanTarget(planType, entry?.target, body),
		action: normalizePlanAction(planType, entry?.action),
		body,
	}
}

export function normalizePlanTargetStubEntry(entry: Partial<PlanTargetStubEntry>): PlanTargetStubEntry {
	return {
		target: normalizePlanTarget("file", entry?.target, ""),
		action: normalizePlanAction("file", entry?.action) as Exclude<PlanTargetAction, "GENERAL">,
	}
}

export function validatePlanTargetStubEntry(entry: PlanTargetStubEntry): string | null {
	if (!entry.target) {
		return "Each plan target entry must include a non-empty target"
	}

	if (!["CREATE", "MODIFY", "DELETE"].includes(entry.action)) {
		return `Plan target entry for \"${entry.target}\" must use ACTION: CREATE, MODIFY, or DELETE`
	}

	if (/^[A-Za-z]:\//.test(entry.target) || entry.target.startsWith("/") || entry.target.startsWith("../")) {
		return `Plan target entry for \"${entry.target}\" must use a relative project file path`
	}

	if (!looksLikeProjectFilePath(entry.target)) {
		return `Plan target entry for \"${entry.target}\" must use a real relative project file path`
	}

	return null
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

export function buildPlanTargetStubContent(entry: PlanTargetStubEntry): string {
	return buildPlanEntryContent({
		target: entry.target,
		action: entry.action,
		body: STEP1_PLAN_TARGET_STUB_MARKER,
	})
}

export function isPlanTargetStub(plan: PlanFile): boolean {
	return plan.content.includes(STEP1_PLAN_TARGET_STUB_MARKER)
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

function parsePlanSections(raw: string): PlanFile[] {
	const sectionStartRegex =
		/^## ([^\r\n]+)\r?\n(?:\r?\n)*<<<PLAN_TARGET>>>\r?\nACTION: (CREATE|MODIFY|DELETE|GENERAL)\r?\nPATH: ([^\r\n]+)\r?\n<<<END_PLAN_TARGET>>>(?:\r?\n|$)/gm
	const starts: Array<{ index: number; contentStart: number; filePath: string }> = []
	let match: RegExpExecArray | null

	while ((match = sectionStartRegex.exec(raw)) !== null) {
		const markerOffset = match[0].indexOf("<<<PLAN_TARGET>>>")
		if (markerOffset === -1) {
			continue
		}
		starts.push({
			index: match.index,
			contentStart: match.index + markerOffset,
			filePath: match[3].trim() || match[1].trim(),
		})
	}

	return starts.map((start, index) => {
		const nextStart = starts[index + 1]?.index ?? raw.length
		let content = raw.slice(start.contentStart, nextStart).trim()
		content = content.replace(/\r?\n---\s*$/, "").trim()
		return { filePath: start.filePath, content }
	})
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

async function collectMatchingPlanMarkdownFiles(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoItemId: string,
	todoContent?: string,
): Promise<string[]> {
	const matchesById: string[] = []
	const matchesByContent: string[] = []
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
			if (!matchesId && !matchesContent) {
				continue
			}

			if (matchesId) {
				matchesById.push(filePath)
			} else {
				matchesByContent.push(filePath)
			}
		}
	}

	return matchesById.length > 0 ? matchesById : matchesByContent
}

function parsePlanAgreementTargets(value: string): string[] {
	const targets: string[] = []
	const seen = new Set<string>()
	for (const rawTarget of value.split(",")) {
		const target = rawTarget
			.trim()
			.replace(/^`|`$/g, "")
			.replace(/^["']|["']$/g, "")
		if (!target || seen.has(target)) {
			continue
		}
		seen.add(target)
		targets.push(target)
	}
	return targets
}

function mergePlanAgreementItem(items: ParsedPlanAgreementItem[], item: ParsedPlanAgreementItem): void {
	const text = item.text.trim()
	if (!text) {
		return
	}
	const existing = items.find((entry) => entry.text === text)
	if (!existing) {
		items.push({
			text,
			sharedWith: parsePlanAgreementTargets(item.sharedWith.join(",")),
		})
		return
	}

	const seen = new Set(existing.sharedWith)
	for (const target of item.sharedWith) {
		if (!target || seen.has(target)) {
			continue
		}
		seen.add(target)
		existing.sharedWith.push(target)
	}
}

function parsePlanAgreementContent(content: string): ParsedPlanAgreementItem[] {
	const items: ParsedPlanAgreementItem[] = []
	let current: ParsedPlanAgreementItem | undefined
	const body = content
		.trim()
		.replace(new RegExp(`^${escapeRegExp(PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE)}\\r?\\n?`), "")

	for (const line of body.split(/\r?\n/)) {
		const sharedWithMatch = line.match(/^\s+[-*]\s+Shared with:\s*(.+?)\s*$/i)
		if (sharedWithMatch && current) {
			current.sharedWith = parsePlanAgreementTargets([...current.sharedWith, sharedWithMatch[1] ?? ""].join(","))
			continue
		}

		const agreementMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/)
		if (!agreementMatch) {
			continue
		}

		const text = (agreementMatch[1] ?? "").trim()
		if (!text || /^Shared with:/i.test(text)) {
			continue
		}

		current = { text, sharedWith: [] }
		mergePlanAgreementItem(items, current)
		current = items.find((entry) => entry.text === text)
	}

	return items
}

function formatPlanAgreementContent(items: ParsedPlanAgreementItem[]): string {
	const lines: string[] = [PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE]
	for (const item of items) {
		lines.push(`- ${item.text}`)
		if (item.sharedWith.length > 0) {
			lines.push(`  - Shared with: ${item.sharedWith.map((target) => `\`${target}\``).join(", ")}`)
		}
	}
	return lines.join("\n")
}

function appendFileAgreementToPlanMarkdown(
	raw: string,
	planTargetPath: string,
	content: string,
): {
	matchedSection: boolean
	appended: boolean
	updated: string
} {
	const trimmedTarget = planTargetPath.trim()
	const trimmedContent = content.trim()
	if (!trimmedTarget || !trimmedContent) {
		return {
			matchedSection: false,
			appended: false,
			updated: raw,
		}
	}

	const sectionRegex = new RegExp(
		`(^## ${escapeRegExp(trimmedTarget)}\\r?\\n)([\\s\\S]*?)(\\r?\\n---(?:\\r?\\n|$))`,
		"m",
	)
	const match = raw.match(sectionRegex)
	if (!match) {
		return {
			matchedSection: false,
			appended: false,
			updated: raw,
		}
	}

	const [, header, body, suffix] = match
	const existingAgreementSectionRegex = new RegExp(
		`\\n*${escapeRegExp(PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE)}\\r?\\n[\\s\\S]*$`,
	)
	const existingAgreementContent = body.match(existingAgreementSectionRegex)?.[0]?.trim() ?? ""
	const mergedAgreementItems: ParsedPlanAgreementItem[] = []
	for (const item of parsePlanAgreementContent(existingAgreementContent)) {
		mergePlanAgreementItem(mergedAgreementItems, item)
	}
	for (const item of parsePlanAgreementContent(trimmedContent)) {
		mergePlanAgreementItem(mergedAgreementItems, item)
	}
	if (mergedAgreementItems.length === 0) {
		return {
			matchedSection: true,
			appended: false,
			updated: raw,
		}
	}
	const nextAgreementContent = formatPlanAgreementContent(mergedAgreementItems)
	const previousAgreementContent = existingAgreementContent
		? formatPlanAgreementContent(parsePlanAgreementContent(existingAgreementContent))
		: ""
	if (nextAgreementContent.trim() === previousAgreementContent.trim()) {
		return {
			matchedSection: true,
			appended: false,
			updated: raw,
		}
	}

	const baseBody = body.replace(existingAgreementSectionRegex, "").trimEnd()
	const nextBody = baseBody.length > 0 ? `${baseBody}\n\n${nextAgreementContent}\n` : `${nextAgreementContent}\n`

	return {
		matchedSection: true,
		appended: true,
		updated: raw.replace(sectionRegex, () => `${header}${nextBody}${suffix}`),
	}
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
	const stubResultsById: PlanFile[] = []
	const fallbackStubResultsByContent: PlanFile[] = []
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

			for (const planFile of parsePlanSections(raw)) {
				const target = isPlanTargetStub(planFile)
					? matchesId
						? stubResultsById
						: fallbackStubResultsByContent
					: matchesId
						? resultsById
						: fallbackResultsByContent
				target.push(planFile)
			}
		}
	}

	if (resultsById.length > 0 || stubResultsById.length > 0) {
		return {
			plans: resultsById,
			stubPlans: stubResultsById.length > 0 ? stubResultsById : fallbackStubResultsByContent,
			contexts: contextsById.length > 0 ? contextsById : contextsByContent,
		}
	}
	return {
		plans: fallbackResultsByContent,
		stubPlans: fallbackStubResultsByContent,
		contexts: contextsByContent,
	}
}

export async function appendFileAgreementsToPlanFiles(
	globalStoragePath: string,
	taskId: string,
	taskTimestamp: string | undefined,
	todoItemId: string,
	agreements: PlanFileAgreement[],
	todoContent?: string,
): Promise<number> {
	const normalizedAgreements = agreements
		.map((agreement) => ({
			plan_target_path: agreement.plan_target_path.trim(),
			content: agreement.content.trim(),
		}))
		.filter((agreement) => agreement.plan_target_path.length > 0 && agreement.content.length > 0)

	if (normalizedAgreements.length === 0) {
		return 0
	}

	const planFilePaths = await collectMatchingPlanMarkdownFiles(
		globalStoragePath,
		taskId,
		taskTimestamp,
		todoItemId,
		todoContent,
	)
	if (planFilePaths.length === 0) {
		return 0
	}

	const fileCache = new Map<string, string>()
	let appendedCount = 0

	for (const agreement of normalizedAgreements) {
		for (const planFilePath of planFilePaths) {
			const raw = fileCache.get(planFilePath) ?? (await fs.readFile(planFilePath, "utf8"))
			if (raw.includes(STEP1_PLAN_TARGET_STUB_MARKER)) {
				continue
			}
			const result = appendFileAgreementToPlanMarkdown(raw, agreement.plan_target_path, agreement.content)
			fileCache.set(planFilePath, result.updated)
			if (!result.matchedSection) {
				continue
			}

			if (result.appended) {
				await fs.writeFile(planFilePath, result.updated, "utf8")
				appendedCount++
			}
		}
	}

	return appendedCount
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
