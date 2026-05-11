import * as path from "path"
import * as vscode from "vscode"
import * as fs from "fs/promises"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import { AskIgnoredError } from "./AskIgnoredError"

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"
import {
	parsePlanTargetHeader,
	readPlanFiles,
	type PlanFileAgreement,
	type PlanFile,
} from "../task-persistence/plan-persistence"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	RooCodeEventName,
	TelemetryEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	ConsecutiveMistakeError,
	MAX_MCP_TOOLS_THRESHOLD,
	countEnabledMcpTools,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, BridgeOrchestrator } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug, getGroupName } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, type ToolResponse, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"
import { renderAgreementChecklistBullets } from "../../shared/agreement-checklist"
import { formatLanguage } from "../../shared/language"

// services
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { BrowserSession } from "../../services/browser/BrowserSession"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getReadablePath, getWorkspacePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { getTaskDirectoryPath, getTaskOptimizePlanPath } from "../../utils/storage"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"
import { addCustomInstructions, getSystemInfoSection } from "../prompts/sections"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask, setTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { ClineProvider } from "../webview/ClineProvider"
import { ContextInspectorPanel } from "../webview/ContextInspectorPanel"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { computeDiffStats, convertNewFileToUnifiedDiff, sanitizeUnifiedDiff } from "../diff/stats"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler, checkAutoApproval } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { saveThinking } from "../task-persistence/thinking-persistence"
import {
	type TurnOutput,
	type TurnThinking,
	saveTurnOutput,
	saveTurnThinking,
	saveToolResultsOutput,
	assembleTurns,
	generateTaskTimestamp,
} from "../task-persistence/turn-persistence"
import {
	compressInTaskContext,
	executeTransitionSelection,
	injectContextBlocks,
	loadCondenseDetail,
	performContextSelection,
} from "../condense/context-selector"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const STEP3_AGREEMENT_PASS_TIMEOUT_MS = 180_000
const STEP3_REFINE_PLAN_BATCH_SIZE = 3
const REFINE_RESUME_STATE_FILE = "refine_state.json"
const SUBAGENT_RESUME_STATE_FILE = "subagent_state.json"

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	enableBridge?: boolean
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
}

type PostSubtaskAgreementItem = {
	text: string
	shared_with: string[]
}

type PostSubtaskFileAgreement = {
	file_path: string
	agreements: PostSubtaskAgreementItem[]
}

type PostSubtaskAgreementResponse = {
	fileAgreements: PostSubtaskFileAgreement[]
}

type PostSubtaskAgreementPassOutcome = {
	executed: boolean
	appendedCount: number
	fileAgreementCount: number
	planAgreementCount?: number
	planAgreements?: PlanFileAgreement[]
	skippedReason?: string
	error?: string
}

type AgreementPassExtractionOutcome = {
	executed: boolean
	fileAgreements: PostSubtaskFileAgreement[]
	skippedReason?: string
	error?: string
}

type Step3ModelTransferDiagnostic = {
	stage: "running" | "api_call" | "parse_response" | "success"
	todoItemId: string
	todoContent: string
	progressLabel?: string
	progress?: Step3ProgressInfo
	provider?: string
	modelId?: string
	errorMessage?: string
	errorData?: unknown
	promptText?: string
	rawResponse?: string
	parsedResponse?: PostSubtaskAgreementResponse
	fileAgreements?: PostSubtaskFileAgreement[]
	agreementCount?: number
	planFiles: Array<{
		filePath: string
		content: string
	}>
}

type Step3ProgressInfo = {
	label?: string
	current: number
	total: number
	detail?: string
}

type RefineResumeState = {
	status: "in_progress"
	activeTodoItemIds: string[]
	step1Complete: boolean
	updatedAt: number
}

type SubagentResumeState = {
	status: "in_progress"
	todoItemIds: string[]
	completedTodoItemIds: string[]
	startedAt: number
	updatedAt: number
}

type AgreementPassOptions = {
	updateAllTodoContexts?: boolean
	progressLabel?: string
	progress?: Step3ProgressInfo
}

type AgreementPassPromptBuilder = (todos: TodoItem[], availableTargets: string[]) => string

const STEP3_FILE_AGREEMENTS_BEGIN = "<!-- BEGIN_STEP3_FILE_AGREEMENTS -->"
const STEP3_FILE_AGREEMENTS_END = "<!-- END_STEP3_FILE_AGREEMENTS -->"
const STEP3_MODEL_TRANSFER_DETAILS_BEGIN = "<!-- STEP3_MODEL_TRANSFER_DETAILS_BEGIN "
const STEP3_MODEL_TRANSFER_DETAILS_END = " STEP3_MODEL_TRANSFER_DETAILS_END -->"
const STEP3_FILE_AGREEMENTS_TITLE = "## Step 3 Cross-Task Agreements By Refine File"
const PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE = "### Cross-Task Agreements Owned By This File"
const STEP3_DIAGNOSTIC_MAX_DEPTH = 20

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timeout = undefined
			reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`))
		}, timeoutMs)
	})

	return Promise.race([
		operation.finally(() => {
			if (timeout) {
				clearTimeout(timeout)
			}
		}),
		timeoutPromise,
	])
}

function formatStep3MessageWithModelTransferDetails(message: string, details: Step3ModelTransferDiagnostic): string {
	try {
		return `${message}\n${STEP3_MODEL_TRANSFER_DETAILS_BEGIN}${Buffer.from(JSON.stringify(sanitizeStep3DiagnosticData(details)), "utf8").toString("base64")}${STEP3_MODEL_TRANSFER_DETAILS_END}`
	} catch {
		return message
	}
}

function shouldFallbackStep3Completion(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return /invalid json response|unexpected end of json input|unexpected token/i.test(message)
}

async function completeStep3AgreementPromptViaStream(
	apiConfiguration: ProviderSettings,
	promptText: string,
): Promise<string> {
	const handler = buildApiHandler({ ...apiConfiguration, openAiStreamingEnabled: true })
	let text = ""
	const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: promptText }]
	for await (const chunk of handler.createMessage("", messages, {
		taskId: "step3-agreement-pass",
		suppressPreviousResponseId: true,
		store: false,
		tool_choice: "none",
		parallelToolCalls: false,
		behaviorRole: "step3-agreement-pass",
	})) {
		if (chunk.type === "text") {
			text += chunk.text
		} else if (chunk.type === "error") {
			throw new Error(chunk.message || chunk.error)
		}
	}
	if (!text.trim()) {
		throw new Error("STEP 3 agreement pass fallback returned an empty response")
	}
	return text
}

async function completeStep3AgreementPrompt(apiConfiguration: ProviderSettings, promptText: string): Promise<string> {
	try {
		return await singleCompletionHandler(apiConfiguration, promptText)
	} catch (error) {
		if (!shouldFallbackStep3Completion(error)) {
			throw error
		}
		try {
			return await completeStep3AgreementPromptViaStream(apiConfiguration, promptText)
		} catch (fallbackError) {
			const primaryMessage = error instanceof Error ? error.message : String(error)
			const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
			throw new Error(`${primaryMessage}; streaming fallback also failed: ${fallbackMessage}`)
		}
	}
}

function sanitizeStep3DiagnosticData(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
	if (depth > STEP3_DIAGNOSTIC_MAX_DEPTH) {
		return "[Max depth reached]"
	}
	if (typeof value === "bigint") {
		return value.toString()
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return String(value)
	}
	if (value instanceof Error) {
		const errorRecord = value as Error & { cause?: unknown } & Record<string, unknown>
		return sanitizeStep3DiagnosticData(
			{
				name: value.name,
				message: value.message,
				stack: value.stack,
				cause: errorRecord.cause,
				...Object.fromEntries(Object.entries(errorRecord)),
			},
			depth + 1,
			seen,
		)
	}
	if (Array.isArray(value)) {
		const seenObjects = seen ?? new WeakSet<object>()
		if (seenObjects.has(value)) {
			return "[Circular]"
		}
		seenObjects.add(value)
		const result = value.map((item) => sanitizeStep3DiagnosticData(item, depth + 1, seenObjects))
		seenObjects.delete(value)
		return result
	}
	if (value && typeof value === "object") {
		const seenObjects = seen ?? new WeakSet<object>()
		if (seenObjects.has(value)) {
			return "[Circular]"
		}
		seenObjects.add(value)
		const result = Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
				key,
				/(api[-_]?key|token|authorization|auth|secret|password|credential)/i.test(key)
					? "[redacted]"
					: sanitizeStep3DiagnosticData(nestedValue, depth + 1, seenObjects),
			]),
		)
		seenObjects.delete(value)
		return result
	}
	return value
}

function formatStep3ApiFailureMessage(message: string): string {
	const lowerMessage = message.toLowerCase()
	if (/invalid json response/i.test(message)) {
		return `${message}. The API provider returned a malformed/non-JSON response before STEP 3 could parse the agreement JSON. No shared agreements were merged into task context or plan sections. This agreement pass is treated as failed and the current refine todo item must retry STEP 3 before any later todo item can proceed.`
	}
	if (message.includes("timed out after")) {
		return `${message}. STEP 3 did not finish, so no shared agreements were merged into task context or plan sections. This agreement pass is treated as failed.`
	}
	if (
		lowerMessage.includes("quota") ||
		lowerMessage.includes("rate") ||
		lowerMessage.includes("too quickly") ||
		lowerMessage.includes("token-limit")
	) {
		return `${message}. STEP 3 could not complete because the API provider rejected or throttled the request. No shared agreements were merged into task context or plan sections. This agreement pass is treated as failed and the current refine todo item must retry STEP 3 before any later todo item can proceed.`
	}
	return message
}

type RefinePayloadStep = "STEP 1" | "STEP 2" | "STEP 3"

function getRefinePayloadStep(refineStep1Complete: boolean): RefinePayloadStep {
	return refineStep1Complete ? "STEP 2" : "STEP 1"
}

function apiMessageContentToText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content.map((item) => apiMessageContentToText(item)).join("\n")
	}
	if (content && typeof content === "object") {
		const record = content as Record<string, unknown>
		if (typeof record.text === "string") {
			return record.text
		}
		if (typeof record.content === "string") {
			return record.content
		}
		try {
			return JSON.stringify(record)
		} catch {
			return ""
		}
	}
	return ""
}

function buildRefineHistoryDiagnostics(messages: ApiMessage[]): Record<string, unknown> {
	const recentMessages = messages.slice(-8).map((message) => {
		const text = apiMessageContentToText((message as any).content)
		return {
			role: (message as any).role,
			textPreview: text.slice(0, 1200),
			hasToolResult: text.includes("tool_result") || text.includes("Tool") || text.includes("[ERROR]"),
			hasItemPlanTargets: text.includes("item_plan_targets"),
			hasTargetsRetry: text.includes("RETRY REFINE STEP 1") || text.includes("Retry `update_todo_list`"),
		}
	})
	const recentText = recentMessages.map((message) => message.textPreview).join("\n")
	return {
		messageCount: messages.length,
		recentRoles: recentMessages.map((message) => message.role),
		recentContainsItemPlanTargets: recentText.includes("item_plan_targets"),
		recentContainsTargetsRequiredError: recentText.includes("item_plan_targets is required"),
		recentContainsTargetsRetry:
			recentText.includes("RETRY REFINE STEP 1") || recentText.includes("Retry `update_todo_list`"),
		recentMessages,
	}
}

function buildRefineToolDiagnostics(tools: OpenAI.Chat.ChatCompletionTool[]): Record<string, unknown> {
	const toolNames = tools.map((tool) => ("function" in tool ? tool.function.name : "unknown"))
	const updateTodoListTool = tools.find((tool) => "function" in tool && tool.function.name === "update_todo_list")
	const writeTodoPlanTool = tools.find((tool) => "function" in tool && tool.function.name === "write_todo_plan")
	const updateFunction =
		updateTodoListTool && "function" in updateTodoListTool ? updateTodoListTool.function : undefined
	const parameters = updateFunction?.parameters as any
	const required = Array.isArray(parameters?.required) ? parameters.required : []
	const itemPlanTargets = parameters?.properties?.item_plan_targets
	return {
		toolNames,
		hasUpdateTodoList: !!updateTodoListTool,
		hasWriteTodoPlan: !!writeTodoPlanTool,
		updateTodoListStrict: updateFunction?.strict === true,
		updateTodoListRequired: required,
		itemPlanTargetsRequired: required.includes("item_plan_targets"),
		itemPlanTargetsSchemaPresent: !!itemPlanTargets,
		itemPlanTargetsDescriptionHasRequired:
			typeof itemPlanTargets?.description === "string" && itemPlanTargets.description.includes("Required"),
	}
}

function buildRefinePromptDiagnostics(systemPrompt: string): Record<string, boolean> {
	return {
		hasRefinePlanningReminder: systemPrompt.includes("Refine Planning Reminder"),
		hasStep1: systemPrompt.includes("STEP 1"),
		hasStep2: systemPrompt.includes("STEP 2"),
		hasStep3: systemPrompt.includes("STEP 3"),
		hasItemPlanTargets: systemPrompt.includes("item_plan_targets"),
		hasFileTargetExtraction: systemPrompt.includes("file-target extraction"),
		hasNonEmptyTargetsRequirement: systemPrompt.includes("non-empty inner array"),
		hasWriteTodoPlan: systemPrompt.includes("write_todo_plan"),
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeCodeTargetPath(value: string): string {
	return value
		.trim()
		.replace(/^`|`$/g, "")
		.replace(/^["']|["']$/g, "")
		.replace(/\\/g, "/")
		.trim()
}

function collectCodePlanTargets(planFiles: PlanFile[]): string[] {
	const targets: string[] = []
	const seen = new Set<string>()
	for (const plan of planFiles) {
		const parsedHeader = parsePlanTargetHeader(plan.content)
		if (parsedHeader?.action === "GENERAL") {
			continue
		}

		const target = normalizeCodeTargetPath(parsedHeader?.path ?? plan.filePath)
		if (!target || seen.has(target)) {
			continue
		}
		seen.add(target)
		targets.push(target)
	}
	return targets
}

function collectTodoMentionedCodeTargets(todos: TodoItem[]): string[] {
	const targets: string[] = []
	const seen = new Set<string>()
	const pathRegex =
		/(?:^|[\s,;:()[\]{}"'`])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_@.+-]+[\\/])+[A-Za-z0-9_@.+-]+\.[A-Za-z0-9_+-]+)(?=$|[\s,;:()[\]{}"'`])/g

	for (const todo of todos) {
		const source = `${todo.content}\n${todo.context ?? ""}`
		for (const match of source.matchAll(pathRegex)) {
			const target = normalizeCodeTargetPath(match[1] ?? "")
			if (target && !seen.has(target)) {
				seen.add(target)
				targets.push(target)
			}
		}
	}

	return targets
}

function collectAvailableCodeTargets(todos: TodoItem[], planFiles: PlanFile[]): string[] {
	const targets: string[] = []
	const seen = new Set<string>()
	for (const target of [...collectCodePlanTargets(planFiles), ...collectTodoMentionedCodeTargets(todos)]) {
		if (target && !seen.has(target)) {
			seen.add(target)
			targets.push(target)
		}
	}
	return targets
}

function normalizeAgreementText(value: string): string {
	return value
		.trim()
		.replace(/^\s*[-*]\s+/, "")
		.trim()
}

function normalizeSharedWithTargets(targets: string[]): string[] {
	const unique: string[] = []
	for (const target of targets) {
		const normalized = normalizeCodeTargetPath(target)
		if (normalized && !unique.includes(normalized)) {
			unique.push(normalized)
		}
	}
	return unique
}

function parseSharedWithTargets(value: string): string[] {
	return normalizeSharedWithTargets(value.split(","))
}

function normalizeAgreementItem(agreement: PostSubtaskAgreementItem): PostSubtaskAgreementItem | undefined {
	const text = normalizeAgreementText(agreement.text)
	if (!text) {
		return undefined
	}
	return {
		text,
		shared_with: normalizeSharedWithTargets(agreement.shared_with),
	}
}

function mergeAgreementItem(existing: PostSubtaskAgreementItem[], agreement: PostSubtaskAgreementItem): void {
	const normalized = normalizeAgreementItem(agreement)
	if (!normalized) {
		return
	}

	const match = existing.find((item) => item.text === normalized.text)
	if (match) {
		match.shared_with = normalizeSharedWithTargets([...match.shared_with, ...normalized.shared_with])
		return
	}

	existing.push(normalized)
}

function normalizeFileAgreements(
	fileAgreements: PostSubtaskFileAgreement[],
	planFiles: PlanFile[],
	availableSharedTargets?: string[],
): PostSubtaskFileAgreement[] {
	const ownerTargets = new Set(collectCodePlanTargets(planFiles))
	const sharedTargets = new Set(availableSharedTargets ?? collectCodePlanTargets(planFiles))
	const grouped = new Map<string, PostSubtaskAgreementItem[]>()
	for (const entry of fileAgreements) {
		const filePath = normalizeCodeTargetPath(entry.file_path)
		if (!filePath || (ownerTargets.size > 0 && !ownerTargets.has(filePath))) {
			continue
		}

		const existing = grouped.get(filePath) ?? []
		for (const agreement of entry.agreements) {
			const normalized = normalizeAgreementItem(agreement)
			if (!normalized) {
				continue
			}
			normalized.shared_with = normalized.shared_with.filter(
				(target) => target !== filePath && (sharedTargets.size === 0 || sharedTargets.has(target)),
			)
			mergeAgreementItem(existing, normalized)
		}
		if (existing.length > 0) {
			grouped.set(filePath, existing)
		}
	}

	return Array.from(grouped.entries()).map(([file_path, agreements]) => ({ file_path, agreements }))
}

function mergePostSubtaskFileAgreements(fileAgreements: PostSubtaskFileAgreement[]): PostSubtaskFileAgreement[] {
	const grouped = new Map<string, PostSubtaskAgreementItem[]>()
	for (const entry of fileAgreements) {
		const filePath = normalizeCodeTargetPath(entry.file_path)
		if (!filePath) {
			continue
		}
		const existing = grouped.get(filePath) ?? []
		for (const agreement of entry.agreements) {
			mergeAgreementItem(existing, agreement)
		}
		if (existing.length > 0) {
			grouped.set(filePath, existing)
		}
	}
	return Array.from(grouped.entries()).map(([file_path, agreements]) => ({ file_path, agreements }))
}

function parseStep3FileAgreementSection(context: string): Map<string, PostSubtaskAgreementItem[]> {
	const result = new Map<string, PostSubtaskAgreementItem[]>()
	const sectionRegex = new RegExp(
		`${escapeRegExp(STEP3_FILE_AGREEMENTS_BEGIN)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(STEP3_FILE_AGREEMENTS_END)}`,
	)
	const match = context.match(sectionRegex)
	const body = match?.[1] ?? ""
	const headingRegex = /^### (?:Refine file:\s*)?`([^`]+)`\s*$/gm
	const headings = Array.from(body.matchAll(headingRegex))
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i]
		const filePath = heading[1]?.trim()
		if (!filePath) {
			continue
		}

		const start = (heading.index ?? 0) + heading[0].length
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? body.length) : body.length
		const section = body.slice(start, end)
		const agreements: PostSubtaskAgreementItem[] = []
		let currentAgreement: PostSubtaskAgreementItem | undefined
		for (const line of section.split(/\r?\n/)) {
			const sharedWithMatch = line.match(/^\s+[-*]\s+Shared with:\s*(.+?)\s*$/i)
			if (sharedWithMatch && currentAgreement) {
				currentAgreement.shared_with = normalizeSharedWithTargets([
					...currentAgreement.shared_with,
					...parseSharedWithTargets(sharedWithMatch[1] ?? ""),
				])
				continue
			}

			const agreementMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/)
			if (!agreementMatch) {
				continue
			}

			const text = normalizeAgreementText(agreementMatch[1] ?? "")
			if (!text || /^Shared with:/i.test(text)) {
				continue
			}

			currentAgreement = { text, shared_with: [] }
			agreements.push(currentAgreement)
		}
		if (agreements.length > 0) {
			const merged: PostSubtaskAgreementItem[] = []
			for (const agreement of agreements) {
				mergeAgreementItem(merged, agreement)
			}
			result.set(normalizeCodeTargetPath(filePath), merged)
		}
	}
	return result
}

function stripStep3FileAgreementSection(context: string): string {
	const sectionRegex = new RegExp(
		`\\n*${escapeRegExp(STEP3_FILE_AGREEMENTS_BEGIN)}\\s*[\\s\\S]*?\\s*${escapeRegExp(STEP3_FILE_AGREEMENTS_END)}\\n*`,
	)
	return context.replace(sectionRegex, "\n\n").trim()
}

function formatAgreementItemLines(agreement: PostSubtaskAgreementItem): string[] {
	const normalized = normalizeAgreementItem(agreement)
	if (!normalized) {
		return []
	}

	const lines = [`- ${normalized.text}`]
	if (normalized.shared_with.length > 0) {
		lines.push(`  - Shared with: ${normalized.shared_with.map((target) => `\`${target}\``).join(", ")}`)
	}
	return lines
}

function buildStep3FileAgreementBlock(agreementsByFile: Map<string, PostSubtaskAgreementItem[]>): string {
	const sections: string[] = []
	for (const [filePath, agreements] of agreementsByFile.entries()) {
		const uniqueAgreements: PostSubtaskAgreementItem[] = []
		for (const agreement of agreements) {
			mergeAgreementItem(uniqueAgreements, agreement)
		}
		if (uniqueAgreements.length === 0) {
			continue
		}
		sections.push(
			[`### Refine file: \`${filePath}\``, ...uniqueAgreements.flatMap(formatAgreementItemLines)].join("\n"),
		)
	}

	return sections.length > 0
		? [
				STEP3_FILE_AGREEMENTS_BEGIN,
				STEP3_FILE_AGREEMENTS_TITLE,
				"",
				sections.join("\n\n"),
				STEP3_FILE_AGREEMENTS_END,
			].join("\n")
		: ""
}

function buildPlanSectionAgreementContent(agreements: PostSubtaskAgreementItem[]): string {
	const uniqueAgreements: PostSubtaskAgreementItem[] = []
	for (const agreement of agreements) {
		mergeAgreementItem(uniqueAgreements, agreement)
	}
	return uniqueAgreements.length > 0
		? [PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE, ...uniqueAgreements.flatMap(formatAgreementItemLines)].join("\n")
		: ""
}

function stripPlanSectionAgreementContent(content: string): string {
	const sectionRegex = new RegExp(`\\n*${escapeRegExp(PLAN_SECTION_CONTEXT_AGREEMENTS_TITLE)}\\r?\\n[\\s\\S]*$`)
	return content.replace(sectionRegex, "").trimEnd()
}

function getTaskContextPlanAgreements(context: string | undefined, planFiles: PlanFile[]): PlanFileAgreement[] {
	const agreementsByFile = parseStep3FileAgreementSection(context?.trim() ?? "")
	const planTargets = collectCodePlanTargets(planFiles)
	return planTargets
		.map((target) => ({
			plan_target_path: target,
			content: buildPlanSectionAgreementContent(agreementsByFile.get(target) ?? []),
		}))
		.filter((entry) => entry.content.trim().length > 0)
}

function applyPlanAgreementsToPlanEntries(
	planFiles: PlanFile[],
	agreements: PlanFileAgreement[],
): { plans: PlanFile[]; appliedCount: number } {
	const agreementsByTarget = new Map<string, string>()
	for (const agreement of agreements) {
		const target = normalizeCodeTargetPath(agreement.plan_target_path)
		const content = agreement.content.trim()
		if (target && content) {
			agreementsByTarget.set(target, content)
		}
	}

	let appliedCount = 0
	const plans = planFiles.map((plan) => {
		const parsedHeader = parsePlanTargetHeader(plan.content)
		const baseContent = stripPlanSectionAgreementContent(plan.content)
		if (parsedHeader?.action === "GENERAL") {
			return baseContent === plan.content ? plan : { ...plan, content: baseContent }
		}

		const target = normalizeCodeTargetPath(parsedHeader?.path ?? plan.filePath)
		const content = agreementsByTarget.get(target)
		if (!content) {
			return baseContent === plan.content ? plan : { ...plan, content: baseContent }
		}
		if (baseContent.includes(content)) {
			return baseContent === plan.content ? plan : { ...plan, content: baseContent }
		}
		appliedCount++
		return {
			...plan,
			content: `${baseContent}\n\n${content}`,
		}
	})

	return { plans, appliedCount }
}

function mergeStep3FileAgreementsIntoContext(
	context: string | undefined,
	fileAgreements: PostSubtaskFileAgreement[],
): string {
	const existingContext = context?.trim() ?? ""
	const agreementsByFile = parseStep3FileAgreementSection(existingContext)
	for (const entry of fileAgreements) {
		const existing = agreementsByFile.get(entry.file_path) ?? []
		for (const agreement of entry.agreements) {
			mergeAgreementItem(existing, agreement)
		}
		if (existing.length > 0) {
			agreementsByFile.set(entry.file_path, existing)
		}
	}

	const nextBlock = buildStep3FileAgreementBlock(agreementsByFile)
	const baseContext = stripStep3FileAgreementSection(existingContext)
	if (!nextBlock) {
		return baseContext
	}
	return baseContext ? `${baseContext}\n\n${nextBlock}` : nextBlock
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	/**
	 * Index into apiConversationHistory where the current sub-task started.
	 * Updated when attempt_completion is accepted (set to the next message index).
	 * Used by compression to only condense within the current task boundary.
	 */
	currentTaskStartIndex = 0

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	/**
	 * The API configuration name (provider profile) associated with this task.
	 * Persisted across sessions to maintain the provider profile when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskApiConfigName()`
	 * 3. Falls back to "default" if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.apiConfigName` during construction
	 * 2. Falls back to undefined if not stored in history (for backward compatibility)
	 *
	 * ## Important
	 * If you need a non-`undefined` provider profile (e.g., for profile-dependent operations),
	 * wait for `taskApiConfigReady` first (or use `getTaskApiConfigName()`).
	 * The sync `taskApiConfigName` getter may return `undefined` for backward compatibility.
	 *
	 * @private
	 * @see {@link getTaskApiConfigName} - For safe async access
	 * @see {@link taskApiConfigName} - For sync access after initialization
	 */
	private _taskApiConfigName: string | undefined

	/**
	 * Promise that resolves when the task API config name has been initialized.
	 * This ensures async API config name initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task API config name
	 * - Ensures provider state is properly loaded before profile-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 */
	private taskApiConfigReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	public readonly globalStoragePath: string

	/** Number of recent todo items to retain full context for (read from globalState setting) */
	get contextRetentionTasks(): number {
		const provider = this.providerRef.deref()
		const value = provider?.contextProxy?.getGlobalState("contextRetentionTasks")
		return typeof value === "number" ? value : 2
	}

	/** Whether auto-condense (backpack+summary compression) is enabled */
	get autoCondenseContext(): boolean {
		const provider = this.providerRef.deref()
		const value = provider?.contextProxy?.getGlobalState("autoCondenseContext")
		return typeof value === "boolean" ? value : true
	}

	/** Threshold percentage of context window to trigger auto-condense (10-100) */
	get autoCondenseContextPercent(): number {
		const provider = this.providerRef.deref()
		const value = provider?.contextProxy?.getGlobalState("autoCondenseContextPercent")
		return typeof value === "number" ? value : 100
	}

	/** Minimum number of recent messages to preserve during auto-condense compression (1-20) */
	get minPreserveMessages(): number {
		const provider = this.providerRef.deref()
		const value = provider?.contextProxy?.getGlobalState("minPreserveMessages")
		return typeof value === "number" ? value : 4
	}

	abort: boolean = false
	currentRequestAbortController?: AbortController
	skipPrevResponseIdOnce: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	urlContentFetcher: UrlContentFetcher
	terminalProcess?: RooTerminalProcess

	// Computer User
	browserSession: BrowserSession

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	toolUsage: ToolUsage = {}
	// Progressive tool disclosure: tracks which tools the model has "discovered"
	discoveredTools: Set<string> = new Set()
	// Task lock: tools are parameter-stripped until model establishes a task via update_todo_list
	taskEstablished: boolean = false
	// Set when attempt_completion finishes (or is interrupted) so the next update_todo_list compresses old context
	needsContextCompression: boolean = false
	// Path to context_refs.json — set after context selection, used during context building
	contextRefsPath?: string

	// Per-turn persistence: save each LLM call's output and thinking to separate files
	turnCounter: number = 0
	taskTimestamp?: string
	lastTurnApiInput?: {
		modelId?: string
		provider?: string
	}
	// Context stripping: maps todoItemId → apiConversationHistory index where that item's work begins
	todoItemBoundaries: Map<string, number> = new Map()

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Task Bridge
	enableBridge: boolean

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false

	/**
	 * Flag indicating whether the assistant message for the current streaming session
	 * has been saved to API conversation history.
	 *
	 * This is critical for parallel tool calling: tools should NOT execute until
	 * the assistant message is saved. Otherwise, `flushPendingToolResultsToHistory()`
	 * could cause the user message with tool_results to appear BEFORE the assistant
	 * message with tool_uses, causing API errors.
	 *
	 * Reset to `false` at the start of each API request.
	 * Set to `true` after the assistant message is saved in `recursivelyMakeClineRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * @param toolResult - The tool_result block to add
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		this.userMessageContent.push(toolResult)
		return true
	}

	/**
	 * Handle a tool call streaming event (tool_call_start, tool_call_delta, or tool_call_end).
	 * This is used both for processing events from NativeToolCallParser (legacy providers)
	 * and for direct AI SDK events (DeepSeek, Moonshot, etc.).
	 *
	 * @param event - The tool call event to process
	 */
	private handleToolCallEvent(
		event:
			| { type: "tool_call_start"; id: string; name: string }
			| { type: "tool_call_delta"; id: string; delta: string }
			| { type: "tool_call_end"; id: string },
	): void {
		if (event.type === "tool_call_start") {
			// Guard against duplicate tool_call_start events for the same tool ID.
			// This can occur due to stream retry, reconnection, or API quirks.
			// Without this check, duplicate tool_use blocks with the same ID would
			// be added to assistantMessageContent, causing API 400 errors:
			// "tool_use ids must be unique"
			if (this.streamingToolCallIndices.has(event.id)) {
				console.warn(
					`[Task#${this.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
				)
				return
			}

			// Initialize streaming in NativeToolCallParser
			NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName)

			// Before adding a new tool, finalize any preceding text block
			// This prevents the text block from blocking tool presentation
			const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
			if (lastBlock?.type === "text" && lastBlock.partial) {
				lastBlock.partial = false
			}

			// Track the index where this tool will be stored
			const toolUseIndex = this.assistantMessageContent.length
			this.streamingToolCallIndices.set(event.id, toolUseIndex)

			// Create initial partial tool use
			const partialToolUse: ToolUse = {
				type: "tool_use",
				name: event.name as ToolName,
				params: {},
				partial: true,
			}

			// Store the ID for native protocol
			;(partialToolUse as any).id = event.id

			// Add to content and present
			this.assistantMessageContent.push(partialToolUse)
			this.userMessageContentReady = false
			presentAssistantMessage(this)
		} else if (event.type === "tool_call_delta") {
			// Process chunk using streaming JSON parser
			const partialToolUse = NativeToolCallParser.processStreamingChunk(event.id, event.delta)

			if (partialToolUse) {
				// Get the index for this tool call
				const toolUseIndex = this.streamingToolCallIndices.get(event.id)
				if (toolUseIndex !== undefined) {
					// Store the ID for native protocol
					;(partialToolUse as any).id = event.id

					// Update the existing tool use with new partial data
					this.assistantMessageContent[toolUseIndex] = partialToolUse

					// Present updated tool use
					presentAssistantMessage(this)
				}
			}
		} else if (event.type === "tool_call_end") {
			// Finalize the streaming tool call
			const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

			// Get the index for this tool call
			const toolUseIndex = this.streamingToolCallIndices.get(event.id)

			if (finalToolUse) {
				// Store the tool call ID
				;(finalToolUse as any).id = event.id

				// Get the index and replace partial with final
				if (toolUseIndex !== undefined) {
					this.assistantMessageContent[toolUseIndex] = finalToolUse
				}

				// Clean up tracking
				this.streamingToolCallIndices.delete(event.id)

				// Mark that we have new content to process
				this.userMessageContentReady = false

				// Present the finalized tool call
				presentAssistantMessage(this)
			} else if (toolUseIndex !== undefined) {
				// finalizeStreamingToolCall returned null (malformed JSON or missing args)
				// Mark the tool as non-partial so it's presented as complete, but execution
				// will be short-circuited in presentAssistantMessage with a structured tool_result.
				const existingToolUse = this.assistantMessageContent[toolUseIndex]
				if (existingToolUse && existingToolUse.type === "tool_use") {
					existingToolUse.partial = false
					// Ensure it has the ID for native protocol
					;(existingToolUse as any).id = event.id
				}

				// Clean up tracking
				this.streamingToolCallIndices.delete(event.id)

				// Mark that we have new content to process
				this.userMessageContentReady = false

				// Present the tool call - validation will handle missing params
				presentAssistantMessage(this)
			}
		}
	}

	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false
	pendingTodoEdit: { oldTodos: TodoItem[]; newTodos: TodoItem[] } | null = null
	pendingRefineRequest: { todoItemIds: string[] } | null = null
	activeRefineTodoItemIds: string[] | null = null
	pendingRefineStep3RetryTodoItemId: string | null = null
	refineStep1Complete = false
	isRefineMode = false
	postRefineDividerPending = false
	/**
	 * Set to true by WriteTodoPlanTool when all plans are written.
	 * Signals the main loop to exit cleanly so runParallelSubagents()
	 * can take over without the main loop continuing to send API requests.
	 */
	subagentsPending = false
	private subtaskAgreementPassChain: Promise<void> = Promise.resolve()
	private subagentResumeStateWriteChain: Promise<void> = Promise.resolve()
	private subagentResumeReviewPending = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined
	private providerProfileChangeListener?: (config: { name: string; provider?: string }) => void

	// Native tool call streaming state (track which index each tool is at)
	private streamingToolCallIndices: Map<string, number> = new Map()

	// Cached model info for current streaming session (set at start of each API request)
	// This prevents excessive getModel() calls during tool execution
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	// Tool Usage Cache
	private toolUsageSnapshot?: ToolUsage

	// Token Usage Throttling - Debounced emit function
	private readonly TOKEN_USAGE_EMIT_INTERVAL_MS = 2000 // 2 seconds
	private debouncedEmitTokenUsage: ReturnType<typeof debounce>

	// Cloud Sync Tracking
	private cloudSyncedMessageTimestamps: Set<number> = new Set()

	// Initial status for the task's history item (set at creation time to avoid race conditions)
	private readonly initialStatus?: "active" | "delegated" | "completed"

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		enableBridge = false,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		initialStatus,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		if (
			!checkpointTimeout ||
			checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
			checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
		) {
			throw new Error(
				"checkpointTimeout must be between " +
					MIN_CHECKPOINT_TIMEOUT_SECONDS +
					" and " +
					MAX_CHECKPOINT_TIMEOUT_SECONDS +
					" seconds",
			)
		}

		this.taskId = historyItem ? historyItem.id : uuidv7()
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context, (isActive: boolean) => {
			// Add a message to indicate browser session status change
			this.say("browser_session_status", isActive ? "Browser session opened" : "Browser session closed")
			// Broadcast to browser panel
			this.broadcastBrowserSessionUpdate()

			// When a browser session becomes active, automatically open/reveal the Browser Session tab
			if (isActive) {
				try {
					// Lazy-load to avoid circular imports at module load time
					const { BrowserSessionPanelManager } = require("../webview/BrowserSessionPanelManager")
					const providerRef = this.providerRef.deref()
					if (providerRef) {
						BrowserSessionPanelManager.getInstance(providerRef)
							.show()
							.catch(() => {})
					}
				} catch (err) {
					console.error("[Task] Failed to auto-open Browser Session panel:", err)
				}
			}
		})
		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout
		this.enableBridge = enableBridge

		this.parentTask = parentTask
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus

		// Store the task's mode and API config name when it's created.
		// For history items, use the stored values; for new tasks, we'll set them
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this._taskApiConfigName = historyItem.apiConfigName
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else {
			// For new tasks, don't set the mode/apiConfigName yet - wait for async initialization.
			this._taskMode = undefined
			this._taskApiConfigName = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			this.taskApiConfigReady = this.initializeTaskApiConfigName(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		this.assistantMessageParser = undefined

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Listen for provider profile changes to update parser state
		this.setupProviderProfileChangeListener(provider)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Initialize debounced token usage emit function
		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates (throttle behavior)
		this.debouncedEmitTokenUsage = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts
					// Deep copy tool usage for snapshot
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			this.TOKEN_USAGE_EMIT_INTERVAL_MS,
			{ leading: true, trailing: true, maxWait: this.TOKEN_USAGE_EMIT_INTERVAL_MS },
		)

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current API config name from provider state
	 * 2. Sets `_taskApiConfigName` to the fetched name or "default" if unavailable
	 * 3. Handles errors gracefully by falling back to "default"
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to "default" to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Sets up a listener for provider profile changes.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to listen to
	 */
	private setupProviderProfileChangeListener(provider: ClineProvider): void {
		// Only set up listener if provider has the on method (may not exist in test mocks)
		if (typeof provider.on !== "function") {
			return
		}

		this.providerProfileChangeListener = async () => {
			try {
				const newState = await provider.getState()
				if (newState?.apiConfiguration) {
					this.updateApiConfiguration(newState.apiConfiguration)
				}
			} catch (error) {
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] Failed to update API configuration on profile change:`,
					error,
				)
			}
		}

		provider.on(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * This method ensures that any operations depending on the task's provider profile
	 * will have access to the correct value.
	 *
	 * ## When to use
	 * - Before accessing provider profile-specific configurations
	 * - When switching between tasks with different provider profiles
	 * - Before operations that depend on the provider profile
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 * @public
	 */
	public async waitForApiConfigInitialization(): Promise<void> {
		return this.taskApiConfigReady
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task's provider profile as it guarantees
	 * the value is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskApiConfigReady` promise to resolve
	 * - Returns the initialized API config name or undefined as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 * @public
	 */
	public async getTaskApiConfigName(): Promise<string | undefined> {
		await this.taskApiConfigReady
		return this._taskApiConfigName
	}

	/**
	 * Get the task API config name synchronously. This should only be used when you're certain
	 * that the value has already been initialized (e.g., after waitForApiConfigInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForApiConfigInitialization()`
	 * - In event handlers or callbacks where API config name is guaranteed to be initialized
	 *
	 * Note: Unlike taskMode, this getter does not throw if uninitialized since the API config
	 * name can legitimately be undefined (backward compatibility with tasks created before
	 * this feature was added).
	 *
	 * @returns The task API config name string or undefined
	 * @public
	 */
	public get taskApiConfigName(): string | undefined {
		return this._taskApiConfigName
	}

	/**
	 * Update the task's API config name. This is called when the user switches
	 * provider profiles while a task is active, allowing the task to remember
	 * its new provider profile.
	 *
	 * @param apiConfigName - The new API config name to set
	 * @internal
	 */
	public setTaskApiConfigName(apiConfigName: string | undefined): void {
		this._taskApiConfigName = apiConfigName
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string) {
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const handler = this.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
			getRedactedThinkingBlocks?: () => Array<{ type: "redacted_thinking"; data: string }> | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const isAnthropicProtocol = apiProtocol === "anthropic"

			// Start from the original assistant message
			const messageWithTs: any = {
				...message,
				...(responseId ? { id: responseId } : {}),
				ts: Date.now(),
			}

			// Store reasoning_details array if present (for models like Gemini 3)
			if (reasoningDetails) {
				messageWithTs.reasoning_details = reasoningDetails
			}

			// Store reasoning: Anthropic thinking (with signature), plain text (most providers), or encrypted (OpenAI Native)
			// Skip if reasoning_details already contains the reasoning (to avoid duplication)
			if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
				// Anthropic provider with extended thinking: Store as proper `thinking` block
				// This format passes through anthropic-filter.ts and is properly round-tripped
				// for interleaved thinking with tool use (required by Anthropic API)
				const thinkingBlock = {
					type: "thinking",
					thinking: reasoning,
					signature: thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						thinkingBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [thinkingBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thinkingBlock]
				}

				// Also insert any redacted_thinking blocks after the thinking block.
				// Anthropic returns these when safety filters trigger on reasoning content.
				// They must be passed back verbatim for proper reasoning continuity.
				const redactedBlocks = handler.getRedactedThinkingBlocks?.()
				if (redactedBlocks && Array.isArray(messageWithTs.content)) {
					// Insert after the thinking block (index 1, right after thinking at index 0)
					messageWithTs.content.splice(1, 0, ...redactedBlocks)
				}
			} else if (reasoning && !reasoningDetails) {
				// Other providers (non-Anthropic): Store as generic reasoning block
				const reasoningBlock = {
					type: "reasoning",
					text: reasoning,
					summary: reasoningSummary ?? ([] as any[]),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			} else if (reasoningData?.encrypted_content) {
				// OpenAI Native encrypted reasoning
				const reasoningBlock = {
					type: "reasoning",
					summary: [] as any[],
					encrypted_content: reasoningData.encrypted_content,
					...(reasoningData.id ? { id: reasoningData.id } : {}),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol) {
				const thoughtSignatureBlock = {
					type: "thoughtSignature",
					thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
						thoughtSignatureBlock,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...messageWithTs.content, thoughtSignatureBlock]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thoughtSignatureBlock]
				}
			}

			this.apiConversationHistory.push(messageWithTs)
		} else {
			// For user messages, validate tool_result IDs ONLY when the immediately previous message
			// is an assistant message.
			const lastMsg = this.apiConversationHistory[this.apiConversationHistory.length - 1]
			const historyForValidation = lastMsg?.role === "assistant" ? this.apiConversationHistory : []

			// If the previous message is NOT an assistant, convert tool_result blocks to text blocks.
			let messageToAdd = message
			if (lastMsg?.role !== "assistant" && Array.isArray(message.content)) {
				messageToAdd = {
					...message,
					content: message.content.map((block) =>
						block.type === "tool_result"
							? {
									type: "text" as const,
									text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
								}
							: block,
					),
				}
			}

			const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
			const messageWithTs = { ...validatedMessage, ts: Date.now() }
			this.apiConversationHistory.push(messageWithTs)
		}

		await this.saveApiConversationHistory()
	}

	/**
	 * After each assistant turn with plain-text reasoning, remove the reasoning
	 * block from history (it's not needed for context). Full original is persisted
	 * to disk for debugging/recovery.
	 */
	private async compressThinkingInHistory(reasoningText: string): Promise<void> {
		const lastMsg = this.apiConversationHistory[this.apiConversationHistory.length - 1]
		if (!lastMsg || lastMsg.role !== "assistant") return

		const content = lastMsg.content
		if (!Array.isArray(content)) return

		// Find the plain-text reasoning block (not encrypted, not Anthropic thinking)
		const reasoningBlockIndex = content.findIndex(
			(block: any) =>
				block.type === "reasoning" &&
				typeof block.text === "string" &&
				!block.encrypted_content &&
				!block.signature,
		)
		if (reasoningBlockIndex === -1) return

		const reasoningBlock = content[reasoningBlockIndex] as any
		const originalText = reasoningBlock.text as string

		// Remove the reasoning block from history
		content.splice(reasoningBlockIndex, 1)

		// Persist full original to disk (for debugging/recovery)
		const entryId = `thinking_${Date.now()}`
		await saveThinking(this.globalStoragePath, this.taskId, {
			id: entryId,
			timestamp: Date.now(),
			originalLength: originalText.length,
			text: originalText,
		}).catch((err: Error) => console.warn("[Task] Failed to persist thinking:", err))

		// Save updated history
		await this.saveApiConversationHistory()
	}

	/**
	 * Save per-turn LLM data (I/O and thinking) to the task's turns directory.
	 *
	 * Called after each successful API stream completes. Saves two files:
	 *   - turn_NNN_io.json: full input context (system prompt, messages, tools) + output
	 *   - turn_NNN_thinking.json: reasoning/thinking content (only if present)
	 *
	 * Non-critical: failures are logged but do not block task execution.
	 */
	private async saveTurnData(assistantText: string, assistantContent: any[], reasoning?: string): Promise<void> {
		try {
			// Active item = first in_progress, or first pending (many models skip in_progress)
			const currentItem =
				this.todoList?.find((t) => t.status === "in_progress") ||
				this.todoList?.find((t) => t.status === "pending")
			const itemContent = currentItem?.content

			const turnOutput: TurnOutput = {
				turnNumber: this.turnCounter,
				timestamp: Date.now(),
				todoItemId: currentItem?.id,
				todoItemContent: itemContent,
				modelId: this.lastTurnApiInput?.modelId,
				provider: this.lastTurnApiInput?.provider,
				output: {
					assistantMessage: assistantText,
					toolCalls: assistantContent.filter((b: any) => b.type === "tool_use"),
				},
			}

			await saveTurnOutput(
				this.globalStoragePath,
				this.taskId,
				this.taskTimestamp || generateTaskTimestamp(),
				itemContent,
				turnOutput,
			)

			if (reasoning) {
				const turnThinking: TurnThinking = {
					turnNumber: this.turnCounter,
					timestamp: Date.now(),
					todoItemId: currentItem?.id,
					todoItemContent: itemContent,
					reasoning,
					reasoningLength: reasoning.length,
				}

				await saveTurnThinking(
					this.globalStoragePath,
					this.taskId,
					this.taskTimestamp || generateTaskTimestamp(),
					itemContent,
					turnThinking,
				)
			}
		} catch (err) {
			console.warn("[Task] saveTurnData failed (non-critical):", err)
		}
	}

	/**
	 * Build an effective conversation history with context stripping.
	 *
	 * When the AI is focused on a specific todo item, messages from completed
	 * items are replaced with a compact summary pair, reducing context size.
	 *
	 * Returns the full history unchanged if:
	 *   - No todo list exists
	 *   - No item is currently in_progress
	 *   - No boundaries have been recorded
	 */
	public async buildEffectiveHistory(): Promise<ApiMessage[]> {
		// If no todo list or no boundaries, return full history
		if (!this.todoList || this.todoList.length === 0 || this.todoItemBoundaries.size === 0) {
			return this.apiConversationHistory
		}

		// Active item = first in_progress, or first pending (many models skip in_progress)
		const currentItem =
			this.todoList.find((t) => t.status === "in_progress") || this.todoList.find((t) => t.status === "pending")
		if (!currentItem) {
			return this.apiConversationHistory
		}

		let currentItemStart = this.todoItemBoundaries.get(currentItem.id)
		if (currentItemStart === undefined || currentItemStart <= 0) {
			return this.apiConversationHistory
		}

		// Find the earliest boundary across all items (= end of initial context)
		const allBoundaryStarts = Array.from(this.todoItemBoundaries.values())
		let firstBoundary = Math.min(...allBoundaryStarts)

		if (firstBoundary >= this.apiConversationHistory.length) {
			return this.apiConversationHistory
		}

		// ── Boundary alignment: never split tool_use / tool_result pairs ──
		// Boundaries are recorded during tool execution, after the assistant's
		// tool_use is in history but before the tool_result is added. This can
		// leave an orphaned tool_use at the end of the initial context section
		// or an orphaned tool_result at the start of the current-item section.
		if (firstBoundary > 0 && firstBoundary < this.apiConversationHistory.length) {
			const lastKept = this.apiConversationHistory[firstBoundary - 1]
			if (
				lastKept.role === "assistant" &&
				Array.isArray(lastKept.content) &&
				lastKept.content.some((b: any) => b.type === "tool_use")
			) {
				firstBoundary++
			}
		}
		if (currentItemStart > 0 && currentItemStart < this.apiConversationHistory.length) {
			const firstKept = this.apiConversationHistory[currentItemStart]
			if (
				firstKept.role === "user" &&
				Array.isArray(firstKept.content) &&
				firstKept.content.some((b: any) => b.type === "tool_result")
			) {
				currentItemStart--
			}
		}
		// If adjustments closed the gap, no stripping needed
		if (firstBoundary >= currentItemStart) {
			return this.apiConversationHistory
		}

		const result: ApiMessage[] = []

		// 1. Keep initial context: messages before any todo item started working
		for (let i = 0; i < Math.min(firstBoundary, this.apiConversationHistory.length); i++) {
			result.push(this.apiConversationHistory[i])
		}

		// 2. Insert completed-item status markers (project name + completed status only)
		const completedItems = this.todoList.filter((t) => t.status === "completed")
		if (!this.isRefineMode && completedItems.length > 0 && currentItemStart > firstBoundary) {
			const statusLines = completedItems.map((item) => `[x] ${item.content}`).join("\n")

			result.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `${statusLines}\n[-] ${currentItem.content}`,
					},
				],
				ts: Date.now(),
			} as ApiMessage)

			result.push({
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Continuing: ${currentItem.content}`,
					},
				],
				ts: Date.now(),
			} as ApiMessage)
		}

		// 3. Keep all messages from the current item's boundary onwards
		for (let i = currentItemStart; i < this.apiConversationHistory.length; i++) {
			result.push(this.apiConversationHistory[i])
		}

		return result
	}

	private async getRefineResumeStatePath(): Promise<string> {
		const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
		return path.join(taskDir, REFINE_RESUME_STATE_FILE)
	}

	public async persistRefineResumeState(activeTodoItemIds?: string[] | null): Promise<void> {
		try {
			const statePath = await this.getRefineResumeStatePath()
			const ids = this.refineStep1Complete ? (activeTodoItemIds ?? this.activeRefineTodoItemIds ?? []) : []
			const state: RefineResumeState = {
				status: "in_progress",
				activeTodoItemIds: ids,
				step1Complete: this.refineStep1Complete,
				updatedAt: Date.now(),
			}
			await fs.mkdir(path.dirname(statePath), { recursive: true })
			await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8")
		} catch (error) {
			console.warn("[Task] Failed to persist refine resume state:", error)
		}
	}

	public async clearRefineResumeState(): Promise<void> {
		try {
			await fs.rm(await this.getRefineResumeStatePath(), { force: true })
		} catch (error) {
			console.warn("[Task] Failed to clear refine resume state:", error)
		}
	}

	private async readRefineResumeState(): Promise<RefineResumeState | undefined> {
		try {
			const raw = await fs.readFile(await this.getRefineResumeStatePath(), "utf8")
			const parsed = JSON.parse(raw) as Partial<RefineResumeState>
			if (parsed.status !== "in_progress") {
				return undefined
			}
			return {
				status: "in_progress",
				activeTodoItemIds: Array.isArray(parsed.activeTodoItemIds) ? parsed.activeTodoItemIds : [],
				step1Complete: parsed.step1Complete === true,
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			}
		} catch {
			return undefined
		}
	}

	private async getSubagentResumeStatePath(): Promise<string> {
		const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
		return path.join(taskDir, SUBAGENT_RESUME_STATE_FILE)
	}

	private normalizeTodoItemIds(todoItemIds?: string[] | null): string[] {
		const source = todoItemIds ?? (this.todoList ?? []).map((todo) => todo.id)
		return Array.from(
			new Set(
				source
					.map((id) => (typeof id === "string" ? id.trim() : ""))
					.filter((id): id is string => id.length > 0),
			),
		)
	}

	public async persistSubagentResumeState(
		todoItemIds?: string[] | null,
		completedTodoItemIds?: string[] | null,
	): Promise<void> {
		const write = async () => {
			try {
				const previous = await this.readSubagentResumeState()
				const ids = this.normalizeTodoItemIds(todoItemIds ?? previous?.todoItemIds)
				const nextCompletedTodoItemIds = completedTodoItemIds ?? []
				const completedIds = this.normalizeTodoItemIds(
					completedTodoItemIds === undefined
						? previous?.completedTodoItemIds
						: [...(previous?.completedTodoItemIds ?? []), ...nextCompletedTodoItemIds],
				)
				const state: SubagentResumeState = {
					status: "in_progress",
					todoItemIds: ids,
					completedTodoItemIds: completedIds.filter((id) => ids.includes(id)),
					startedAt: previous?.startedAt && previous.startedAt > 0 ? previous.startedAt : Date.now(),
					updatedAt: Date.now(),
				}
				const statePath = await this.getSubagentResumeStatePath()
				await fs.mkdir(path.dirname(statePath), { recursive: true })
				await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8")
			} catch (error) {
				console.warn("[Task] Failed to persist subagent resume state:", error)
			}
		}
		this.subagentResumeStateWriteChain = this.subagentResumeStateWriteChain.then(write, write)
		await this.subagentResumeStateWriteChain
	}

	public async markSubagentResumeTodoCompleted(todoItemId: string): Promise<void> {
		const state = await this.readSubagentResumeState()
		if (!state || !state.todoItemIds.includes(todoItemId)) {
			return
		}
		await this.persistSubagentResumeState(state.todoItemIds, [...state.completedTodoItemIds, todoItemId])
	}

	public async clearSubagentResumeState(): Promise<void> {
		this.subagentResumeReviewPending = false
		try {
			await fs.rm(await this.getSubagentResumeStatePath(), { force: true })
		} catch (error) {
			console.warn("[Task] Failed to clear subagent resume state:", error)
		}
	}

	private async readSubagentResumeState(): Promise<SubagentResumeState | undefined> {
		try {
			const raw = await fs.readFile(await this.getSubagentResumeStatePath(), "utf8")
			const parsed = JSON.parse(raw) as Partial<SubagentResumeState>
			if (parsed.status !== "in_progress") {
				return undefined
			}
			const todoItemIds = this.normalizeTodoItemIds(Array.isArray(parsed.todoItemIds) ? parsed.todoItemIds : [])
			return {
				status: "in_progress",
				todoItemIds,
				completedTodoItemIds: this.normalizeTodoItemIds(
					Array.isArray(parsed.completedTodoItemIds) ? parsed.completedTodoItemIds : [],
				).filter((id) => todoItemIds.includes(id)),
				startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
			}
		} catch {
			return undefined
		}
	}

	private getUnfinishedSubagentTodoIds(state: SubagentResumeState): string[] {
		const existingTodos = this.todoList ?? []
		const completedTodoIds = new Set(state.completedTodoItemIds)
		if (existingTodos.length === 0) {
			return state.todoItemIds.filter((id) => !completedTodoIds.has(id))
		}
		const existingTodoIds = new Set(existingTodos.map((todo) => todo.id))
		return state.todoItemIds.filter((id) => existingTodoIds.has(id) && !completedTodoIds.has(id))
	}

	public async hasSubagentResumeState(): Promise<boolean> {
		const state = await this.readSubagentResumeState()
		if (!state) {
			return false
		}
		const unfinishedTodoIds = this.getUnfinishedSubagentTodoIds(state)
		if (unfinishedTodoIds.length === 0) {
			await this.clearSubagentResumeState()
			return false
		}
		return true
	}

	public async shouldReviewSubagentResumeState(): Promise<boolean> {
		return this.subagentResumeReviewPending && (await this.hasSubagentResumeState())
	}

	public clearSubagentResumeReviewState(): void {
		this.subagentResumeReviewPending = false
	}

	private formatTodoListForPrompt(todos: TodoItem[]): string {
		return todos
			.map((todo) => {
				const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "-" : " "
				return `[${mark}] ${todo.content}`
			})
			.join("\n")
	}

	private async buildRefineResumeReminder(): Promise<string | undefined> {
		const state = await this.readRefineResumeState()
		if (!state) {
			return undefined
		}
		if (!this.isRefineMode && state.step1Complete && state.activeTodoItemIds.length === 0) {
			await this.clearRefineResumeState()
			return undefined
		}
		const activeIds = state.activeTodoItemIds.length > 0 ? state.activeTodoItemIds.join(", ") : "(none recorded)"
		const todoList =
			this.todoList && this.todoList.length > 0 ? this.formatTodoListForPrompt(this.todoList) : "(not available)"
		const updatedAt = state.updatedAt > 0 ? new Date(state.updatedAt).toISOString() : "unknown"
		if (!state.step1Complete) {
			return [
				this.isRefineMode ? "[REFINE IN PROGRESS]" : "[REFINE IN PROGRESS - RESUME CHECK]",
				"STEP 1 has not succeeded yet. The next refine mutation must be exactly one `update_todo_list` call.",
				"The `update_todo_list` call MUST include `todos`, `item_contexts`, and non-empty aligned `item_plan_targets` for every active or pending todo item.",
				"Any earlier successful `update_todo_list` call without `item_plan_targets` was only the pre-refine task list update. It does NOT count as refine STEP 1 and must not be copied.",
				"Do NOT call `write_todo_plan` until STEP 1 succeeds and returns the new refined todo ids.",
				"",
				`Refine state last updated: ${updatedAt}`,
				"",
				"Current todo list:",
				todoList,
			].join("\n")
		}
		const writeTodoPlanFormatReminder = [
			"Do not copy compact previous_context placeholders such as plans=[object Object]; they are lossy summaries, not valid tool arguments.",
			"Every write_todo_plan plans entry must include target, action, and body.",
			"STEP 2 does not create or reclassify targets; every file plan target/action must exactly match one STEP 1 item_plan_targets entry for the current todo item.",
			"Put subtopics such as file purpose, dependencies, routes, exports, functions, tests, and Task Context inside the owning file target's body, never as separate plan entries.",
			'For plan_type="general", target must be a descriptive section title and action must be "GENERAL".',
			"For file-based STEP 2 refine plans, each write_todo_plan call may cover at most 3 STEP 1 file targets; continue the same todo_item_id in batches of up to 3 until complete.",
			"When the previous tool result names the next target batch, the next write_todo_plan call must use exactly those listed target names and actions.",
			"Each write_todo_plan call may cover only a coherent subset of up to 3 remaining STEP 1 file targets; continue the same todo_item_id until the tool result reports no missing targets.",
		].join("\n")
		const step3RetryReminder = this.pendingRefineStep3RetryTodoItemId
			? [
					"[STEP 3 RETRY REQUIRED]",
					`The previous STEP 3 agreement pass failed for todo_item_id "${this.pendingRefineStep3RetryTodoItemId}".`,
					"Do not continue to another todo item and do not create additional plan content.",
					`The next action must be a write_todo_plan call for the same todo_item_id "${this.pendingRefineStep3RetryTodoItemId}" so the tool can reuse the saved plans and retry STEP 3.`,
					"Only after STEP 3 succeeds may you proceed to remaining plan targets or the next todo item.",
				].join("\n")
			: undefined
		if (this.isRefineMode) {
			return [
				"[REFINE IN PROGRESS]",
				"A refine operation is currently active. Keep working in refine mode until all required todo plans are recorded with write_todo_plan.",
				"This temporary marker is injected while refine is active and will be removed when parallel subagents start.",
				"",
				...(step3RetryReminder ? [step3RetryReminder, ""] : []),
				writeTodoPlanFormatReminder,
				"",
				`Recorded active refine todo item ids: ${activeIds}`,
				`Refine state last updated: ${updatedAt}`,
				"",
				"Current todo list:",
				todoList,
			].join("\n")
		}
		return [
			"[REFINE IN PROGRESS - RESUME CHECK]",
			"The previous session stopped after the user entered refine mode and before parallel subagents started.",
			"You are now resuming in the main AI layer, not automatically inside refine mode.",
			"Review the current conversation and todo state, then decide whether the previous refine flow should be resumed or normal main-mode work should continue.",
			"If refine should be resumed, continue the refine workflow and record the remaining implementation plans with write_todo_plan before starting implementation work.",
			"If normal work should continue, proceed in main mode; the pending refine marker will be cleared when normal execution work begins.",
			"",
			writeTodoPlanFormatReminder,
			"",
			`Recorded active refine todo item ids: ${activeIds}`,
			`Refine state last updated: ${updatedAt}`,
			"",
			"Current todo list:",
			todoList,
		].join("\n")
	}

	private async buildHistoryWithRefineContextMarker(messages: ApiMessage[]): Promise<ApiMessage[]> {
		const marker = await this.buildRefineResumeReminder()
		if (!marker) {
			return messages
		}
		return [
			...messages,
			{
				role: "user",
				content: [{ type: "text", text: marker }],
				ts: Date.now(),
			} as ApiMessage,
		]
	}

	private async buildSubagentResumeReminder(): Promise<string | undefined> {
		if (this.isRefineMode || !this.subagentResumeReviewPending) {
			return undefined
		}
		const state = await this.readSubagentResumeState()
		if (!state) {
			return undefined
		}
		const unfinishedTodoIds = this.getUnfinishedSubagentTodoIds(state)
		if (unfinishedTodoIds.length === 0) {
			await this.clearSubagentResumeState()
			return undefined
		}
		const todoList =
			this.todoList && this.todoList.length > 0 ? this.formatTodoListForPrompt(this.todoList) : "(not available)"
		const todoById = new Map((this.todoList ?? []).map((todo) => [todo.id, todo.content]))
		const unfinishedSummary = unfinishedTodoIds
			.map((id) => `${id}: ${todoById.get(id) ?? "(missing todo)"}`)
			.join("\n")
		const completedSummary =
			state.completedTodoItemIds.length > 0
				? state.completedTodoItemIds.map((id) => `${id}: ${todoById.get(id) ?? "(missing todo)"}`).join("\n")
				: "(none recorded)"
		const updatedAt = state.updatedAt > 0 ? new Date(state.updatedAt).toISOString() : "unknown"

		return [
			"[SUBAGENT EXECUTION INTERRUPTED - RESUME CHECK]",
			"The previous session was interrupted after refine planning had handed execution to parallel subagents.",
			"You are now resuming in the main AI layer, not inside any individual subagent.",
			"Do not continue only the most recent child-agent conversation and do not assume a single subagent's local state is authoritative.",
			"Review the current conversation, todo list, and saved plan state, then decide whether parallel subagent execution should be restarted or normal main-mode work should continue.",
			"If parallel subagent execution should continue, call resume_subagents. The scheduler will launch the unfinished refined todo items from saved plan files.",
			"If normal main-mode work should continue, do not call resume_subagents; proceed normally and the pending subagent marker will be cleared when normal execution work begins.",
			"",
			`Subagent state last updated: ${updatedAt}`,
			"",
			"Unfinished subagent todo item ids:",
			unfinishedSummary,
			"",
			"Completed subagent todo item ids:",
			completedSummary,
			"",
			"Current todo list:",
			todoList,
		].join("\n")
	}

	private async buildHistoryWithSubagentContextMarker(messages: ApiMessage[]): Promise<ApiMessage[]> {
		const marker = await this.buildSubagentResumeReminder()
		if (!marker) {
			return messages
		}
		return [
			...messages,
			{
				role: "user",
				content: [{ type: "text", text: marker }],
				ts: Date.now(),
			} as ApiMessage,
		]
	}

	public async hasRefineResumeState(): Promise<boolean> {
		const state = await this.readRefineResumeState()
		if (!state) {
			return false
		}
		if (!state.step1Complete) {
			return true
		}
		if (state.activeTodoItemIds.length === 0) {
			await this.clearRefineResumeState()
			return false
		}
		return true
	}

	private async hasCompletedRefineStep1ResumeState(): Promise<boolean> {
		const state = await this.readRefineResumeState()
		if (!state?.step1Complete) {
			return false
		}
		if (state.activeTodoItemIds.length === 0) {
			await this.clearRefineResumeState()
			return false
		}
		return true
	}

	public async restoreRefineModeFromResumeState(): Promise<boolean> {
		const state = await this.readRefineResumeState()
		if (!state) {
			return false
		}
		if (!state.step1Complete) {
			this.activeRefineTodoItemIds = null
			this.refineStep1Complete = false
			this.isRefineMode = true
			await this.persistRefineResumeState([])
			return true
		}
		const existingTodoIds = new Set((this.todoList ?? []).map((todo) => todo.id))
		const activeTodoItemIds = state.activeTodoItemIds.filter((id) => existingTodoIds.has(id))
		if (activeTodoItemIds.length === 0) {
			return false
		}
		this.activeRefineTodoItemIds = activeTodoItemIds
		this.refineStep1Complete = state.step1Complete
		this.isRefineMode = true
		await this.persistRefineResumeState(activeTodoItemIds)
		return true
	}

	private async prepareRefinePromptForTodos(todos: TodoItem[]): Promise<string | undefined> {
		if (todos.length === 0) {
			return undefined
		}
		const refinePrompt = buildRefinePrompt(this.formatTodoListForPrompt(todos))
		this.activeRefineTodoItemIds = null
		this.refineStep1Complete = false
		this.isRefineMode = true
		await this.persistRefineResumeState([])
		await this.say(
			"todo_item_divider",
			JSON.stringify({ content: "Refine", todoItemId: "__refine__" }),
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
		return refinePrompt
	}

	private async prepareRefinePromptForRequest(todos: TodoItem[], todoItemIds: string[]): Promise<string | undefined> {
		if (todos.length === 0) {
			return undefined
		}
		if (!this.isRefineMode) {
			const restored = await this.restoreRefineModeFromResumeState()
			if (!restored) {
				return this.prepareRefinePromptForTodos(todos)
			}
		}
		const hasRecordedRefineProgress =
			this.refineStep1Complete ||
			!!this.activeRefineTodoItemIds?.length ||
			!!this.pendingRefineStep3RetryTodoItemId
		if (!hasRecordedRefineProgress) {
			return this.prepareRefinePromptForTodos(todos)
		}

		const todoById = new Map(todos.map((todo) => [todo.id, todo]))
		const selectedTodoList =
			todoItemIds
				.map((id) => {
					const todo = todoById.get(id)
					return todo
						? `- ${id}: [${todo.status}] ${todo.content}`
						: `- ${id}: (not found in current todo list)`
				})
				.join("\n") || "(none)"
		const activeIds = this.activeRefineTodoItemIds?.length
			? this.activeRefineTodoItemIds.join(", ")
			: "(none recorded)"
		const currentTodoId = this.pendingRefineStep3RetryTodoItemId ?? this.activeRefineTodoItemIds?.[0]
		const currentTodo = currentTodoId ? todoById.get(currentTodoId) : undefined
		const nextAction = this.pendingRefineStep3RetryTodoItemId
			? `A STEP 3 retry is pending. The next tool call must be write_todo_plan for todo_item_id "${this.pendingRefineStep3RetryTodoItemId}" so the saved plans are reused and STEP 3 is retried before any other todo proceeds.`
			: this.refineStep1Complete
				? currentTodoId
					? `Continue the existing refine sequence from todo_item_id "${currentTodoId}"${currentTodo ? ` (${currentTodo.content})` : ""}. Do not restart STEP 1.`
					: "Continue the existing refine sequence from the latest active refine todo id. Do not restart STEP 1."
				: "STEP 1 is still incomplete. Continue STEP 1 once with update_todo_list; do not reset any completed refine state."

		return [
			"[REFINE REQUEST DURING ACTIVE REFINE]",
			"The user added or adjusted requirements while refine is already in progress.",
			"Preserve the current refine workflow state. Do not restart refine and do not discard recorded STEP 1 targets, saved STEP 2 plans, or STEP 3 retry state.",
			"Only call update_todo_list again if the user's new requirement explicitly requires changing the refined todo breakdown or file ownership; otherwise continue the current STEP 2/STEP 3 sequence and incorporate the requirement into the current or remaining plans.",
			"",
			"Selected todo item ids from the user action:",
			selectedTodoList,
			"",
			"Current refine state:",
			`- STEP 1 complete: ${this.refineStep1Complete ? "yes" : "no"}`,
			`- Active refine todo item ids: ${activeIds}`,
			`- Pending STEP 3 retry todo item id: ${this.pendingRefineStep3RetryTodoItemId ?? "(none)"}`,
			"",
			"Next required action:",
			nextAction,
			"",
			"Current todo list:",
			this.formatTodoListForPrompt(todos),
		].join("\n")
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// Rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	/**
	 * Flush any pending tool results to the API conversation history.
	 *
	 * This is important when tool_result blocks are accumulated in
	 * `userMessageContent` but haven't been saved to the API history yet.
	 * If we don't flush them, the API conversation will be incomplete and cause 400 errors when
	 * the parent resumes (missing tool_result for tool_use blocks).
	 *
	 * NOTE: The assistant message is typically already in history by the time
	 * tools execute (added in recursivelyMakeClineRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		// Only flush if there's actually pending content to save
		if (this.userMessageContent.length === 0) {
			return true
		}

		// CRITICAL: Wait for the assistant message to be saved to API history first.
		// Without this, tool_result blocks would appear BEFORE tool_use blocks in the
		// conversation history, causing API errors like:
		// "unexpected `tool_use_id` found in `tool_result` blocks"
		//
		// This can happen when parallel tools are called.
		// Tools execute during streaming via presentAssistantMessage, BEFORE the assistant
		// message is saved.
		//
		// The assistantMessageSavedToHistory flag is:
		// - Reset to false at the start of each API request
		// - Set to true after the assistant message is saved in recursivelyMakeClineRequests
		if (!this.assistantMessageSavedToHistory) {
			await pWaitFor(() => this.assistantMessageSavedToHistory || this.abort, {
				interval: 50,
				timeout: 30_000, // 30 second timeout as safety net
			}).catch(() => {
				// If timeout or abort, log and proceed anyway to avoid hanging
				console.warn(
					`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
				)
			})
		}

		// If task was aborted while waiting, don't flush
		if (this.abort) {
			return false
		}

		// Save the user message with tool_result blocks
		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: this.userMessageContent,
		}

		// Validate and fix tool_result IDs when the previous message is an assistant message.
		const lastMsg = this.apiConversationHistory[this.apiConversationHistory.length - 1]
		const historyForValidation = lastMsg?.role === "assistant" ? this.apiConversationHistory : []
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
		const userMessageWithTs = { ...validatedMessage, ts: Date.now() }
		this.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await this.saveApiConversationHistory()

		if (saved) {
			// Clear the pending content since it's now saved
			this.userMessageContent = []
		} else {
			console.warn(
				`[Task#${this.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	private async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.apiConversationHistory),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
			return true
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
			return false
		}
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
			console.warn(
				`[Task#${this.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
			)

			const success = await this.saveApiConversationHistory()

			if (success) {
				return true
			}
		}

		return false
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
		// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
		await provider?.postStateToWebviewWithoutTaskHistory()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
			// Track that this message has been synced to cloud
			this.cloudSyncedMessageTimestamps.add(message.ts)
		}
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()

		// When overwriting messages (e.g., during task resume), repopulate the cloud sync tracking Set
		// with timestamps from all non-partial messages to prevent re-syncing previously synced messages
		this.cloudSyncedMessageTimestamps.clear()
		for (const msg of newMessages) {
			if (msg.partial !== true) {
				this.cloudSyncedMessageTimestamps.add(msg.ts)
			}
		}
	}

	/**
	 * Update or create the latest todo list display message. If the latest
	 * updateTodoList message exists, update its text in-place instead of
	 * creating a duplicate todo list entry in chat.
	 */
	public async upsertUserEditTodos(text: string): Promise<void> {
		const lastIdx = findLastIndex(this.clineMessages, (m) => {
			if (!((m.type === "say" && m.say === "user_edit_todos") || (m.type === "ask" && m.ask === "tool"))) {
				return false
			}

			try {
				const data = JSON.parse(m.text || "{}")
				return data.tool === "updateTodoList" && Array.isArray(data.todos)
			} catch {
				return false
			}
		})
		if (lastIdx !== -1) {
			// Preserve the original previousTodos from the first edit in this session
			try {
				const existingData = JSON.parse(this.clineMessages[lastIdx].text || "{}")
				const newData = JSON.parse(text)
				if (existingData.previousTodos && !newData._preservedPrevious) {
					newData.previousTodos = existingData.previousTodos
				}
				const existingPlanTargets = Array.isArray(existingData.planTargets)
					? existingData.planTargets
					: Array.isArray(existingData.item_plan_targets)
						? existingData.item_plan_targets
						: undefined
				if (!Array.isArray(newData.planTargets) && !Array.isArray(newData.item_plan_targets)) {
					if (
						Array.isArray(existingPlanTargets) &&
						Array.isArray(existingData.todos) &&
						Array.isArray(newData.todos)
					) {
						const planTargetsByTodoId = new Map<string, unknown>()
						for (const [index, todo] of existingData.todos.entries()) {
							if (todo && typeof todo.id === "string") {
								planTargetsByTodoId.set(todo.id, existingPlanTargets[index] ?? [])
							}
						}
						const remappedPlanTargets = newData.todos.map((todo: unknown, index: number) => {
							if (todo && typeof todo === "object" && typeof (todo as { id?: unknown }).id === "string") {
								return planTargetsByTodoId.get((todo as { id: string }).id) ?? []
							}
							return existingPlanTargets[index] ?? []
						})
						if (
							remappedPlanTargets.some((targets: unknown) => Array.isArray(targets) && targets.length > 0)
						) {
							newData.planTargets = remappedPlanTargets
						}
					}
					if (!Array.isArray(newData.planTargets) && Array.isArray(newData.todos)) {
						const recoveredPlanTargets = await this.readTodoPlanTargetsForDisplay(newData.todos)
						if (recoveredPlanTargets.some((targets) => targets.length > 0)) {
							newData.planTargets = recoveredPlanTargets
						}
					}
				}
				if (newData.refineMode === undefined && existingData.refineMode !== undefined) {
					newData.refineMode = existingData.refineMode
				}
				if (newData.refineStep === undefined && existingData.refineStep !== undefined) {
					newData.refineStep = existingData.refineStep
				}
				this.clineMessages[lastIdx].text = JSON.stringify(newData)
			} catch {
				this.clineMessages[lastIdx].text = text
			}
			await this.saveClineMessages()
			await this.updateClineMessage(this.clineMessages[lastIdx])
		} else {
			await this.say("user_edit_todos", text)
		}
	}

	private async readTodoPlanTargetsForDisplay(
		todos: unknown[],
	): Promise<Array<Array<{ target: string; action: string }>>> {
		const groups: Array<Array<{ target: string; action: string }>> = []
		for (const todo of todos) {
			if (!todo || typeof todo !== "object") {
				groups.push([])
				continue
			}
			const todoItem = todo as { id?: unknown; content?: unknown }
			if (typeof todoItem.id !== "string" || typeof todoItem.content !== "string") {
				groups.push([])
				continue
			}
			try {
				const readResult = await readPlanFiles(
					this.globalStoragePath,
					this.taskId,
					this.taskTimestamp,
					todoItem.id,
					todoItem.content,
				)
				const targets = [...readResult.stubPlans, ...readResult.plans]
					.map((plan) => parsePlanTargetHeader(plan.content))
					.filter(
						(header): header is { action: "CREATE" | "MODIFY" | "DELETE"; path: string } =>
							!!header &&
							(header.action === "CREATE" || header.action === "MODIFY" || header.action === "DELETE"),
					)
					.map((header) => ({ target: header.path, action: header.action }))
				groups.push(targets)
			} catch {
				groups.push([])
			}
		}
		return groups
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })

		// Check if we should sync to cloud and haven't already synced this message
		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()
		const hasNotBeenSynced = !this.cloudSyncedMessageTimestamps.has(message.ts)

		if (shouldCaptureMessage && hasNotBeenSynced) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
			// Track that this message has been synced to cloud
			this.cloudSyncedMessageTimestamps.add(message.ts)
		}
	}

	private async saveClineMessages(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.clineMessages),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			if (this._taskApiConfigName === undefined) {
				await this.taskApiConfigReady
			}

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
				apiConfigName: this._taskApiConfigName, // Use the task's own provider profile, not the current provider profile.
				initialStatus: this.initialStatus,
			})

			// Emit token/tool usage updates using debounced function
			// The debounce with maxWait ensures:
			// - Immediate first emit (leading: true)
			// - At most one emit per interval during rapid updates (maxWait)
			// - Final state is emitted when updates stop (trailing: true)
			this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
			return false
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	private isRefineStep1UpdateTodoListAsk(type: ClineAsk, text?: string): boolean {
		if (type !== "tool") {
			return false
		}
		try {
			const data = JSON.parse(text || "{}")
			return data.tool === "updateTodoList" && data.refineMode === true && data.refineStep === 1
		} catch {
			return false
		}
	}

	private async upsertRefineStep1UpdateTodoListAsk(
		type: ClineAsk,
		text: string | undefined,
		partial: boolean | undefined,
		progressStatus: ToolProgressStatus | undefined,
		isProtected: boolean | undefined,
	): Promise<number | undefined> {
		if (!this.isRefineStep1UpdateTodoListAsk(type, text)) {
			return undefined
		}

		const lastIdx = findLastIndex(this.clineMessages, (message) => {
			return (
				message.type === "ask" &&
				message.ask !== undefined &&
				this.isRefineStep1UpdateTodoListAsk(message.ask, message.text)
			)
		})
		if (lastIdx === -1) {
			return undefined
		}

		const message = this.clineMessages[lastIdx]
		message.text = text
		message.partial = partial
		message.progressStatus = progressStatus
		message.isProtected = isProtected
		this.lastMessageTs = message.ts
		await this.saveClineMessages()
		await this.updateClineMessage(message)
		return message.ts
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		const upsertedAskTs = await this.upsertRefineStep1UpdateTodoListAsk(
			type,
			text,
			partial,
			progressStatus,
			isProtected,
		)
		if (upsertedAskTs !== undefined) {
			askTs = upsertedAskTs
			if (partial) {
				throw new AskIgnoredError("updating existing refine step1 update_todo_list")
			}
		} else if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					// console.log("Task#ask: current ask promise was ignored (#1)")
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					// console.log("Task#ask: current ask promise was ignored (#2)")
					throw new AskIgnoredError("new partial")
				}
			} else {
				// New now have a complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		let timeouts: NodeJS.Timeout[] = []

		// Automatically approve if the ask according to the user's settings.
		const provider = this.providerRef.deref()
		const state = provider ? await provider.getState() : undefined
		const approval = await checkAutoApproval({ state, ask: type, text, isProtected })

		if (approval.decision === "approve") {
			this.approveAsk()
		} else if (approval.decision === "deny") {
			this.denyAsk()
		} else if (approval.decision === "timeout") {
			// Store the auto-approval timeout so it can be cancelled if user interacts
			this.autoApprovalTimeoutRef = setTimeout(() => {
				const { askResponse, text, images } = approval.fn()
				this.handleWebviewAskResponse(askResponse, text, images)
				this.autoApprovalTimeoutRef = undefined
			}, approval.timeout)
			timeouts.push(this.autoApprovalTimeoutRef)
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		const isStatusMutable = !partial && isBlocking && !isMessageQueued && approval.decision === "ask"

		if (isStatusMutable) {
			const statusMutationTimeout = 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued) {
			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				// Check if this is a tool approval ask that needs to be handled.
				if (
					type === "tool" ||
					type === "command" ||
					type === "browser_action_launch" ||
					type === "use_mcp_server"
				) {
					// For tool approvals, we need to approve first, then send
					// the message if there's text/images.
					this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
				} else {
					// For other ask types (like followup or command_output), fulfill the ask
					// directly.
					this.handleWebviewAskResponse("messageResponse", message.text, message.images)
				}
			}
		}

		// Wait for askResponse to be set
		await pWaitFor(
			() => {
				if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
					return true
				}

				// If a queued message arrives while we're blocked on an ask (e.g. a follow-up
				// suggestion click that was incorrectly queued due to UI state), consume it
				// immediately so the task doesn't hang.
				if (!this.messageQueueService.isEmpty()) {
					const message = this.messageQueueService.dequeueMessage()
					if (message) {
						// If this is a tool approval ask, we need to approve first (yesButtonClicked)
						// and include any queued text/images.
						if (
							type === "tool" ||
							type === "command" ||
							type === "browser_action_launch" ||
							type === "use_mcp_server"
						) {
							this.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
						} else {
							this.handleWebviewAskResponse("messageResponse", message.text, message.images)
						}
					}
				}

				return false
			},
			{ interval: 100 },
		)

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		timeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(): void {
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.lastMessageTs = Date.now()
	}

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings): void {
		// Update the configuration and rebuild the API handler
		this.apiConfiguration = newApiConfiguration
		this.api = buildApiHandler(this.apiConfiguration)
	}

	/**
	 * Returns the API handler to use for memory regression (drilling down summaries).
	 * If the user has selected a specific regression model, builds a separate ApiHandler.
	 * Otherwise returns undefined (regression not configured).
	 */
	public async getRegressionApiHandler(): Promise<ApiHandler | undefined> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) return undefined

			const regressionBaseUrl = provider.contextProxy.getGlobalState("regressionBaseUrl")
			const regressionModelId = provider.contextProxy.getGlobalState("regressionModelId")

			if (regressionBaseUrl) {
				return buildApiHandler({
					apiProvider: "openai",
					openAiApiKey: "none",
					openAiBaseUrl: regressionBaseUrl,
					openAiModelId: regressionModelId || undefined,
				})
			}
		} catch (error) {
			console.error("[Task] Failed to build regression API handler:", error)
		}
		return undefined
	}

	/**
	 * Returns the API handler to use for context condensation during todo list transitions.
	 * If the user has selected a specific condensing model, builds a separate ApiHandler.
	 * Otherwise falls back to the task's main API handler.
	 */
	public async getCondensingApiHandler(): Promise<ApiHandler> {
		try {
			const provider = this.providerRef.deref()
			if (provider) {
				const condensingBaseUrl = provider.contextProxy.getGlobalState("condensingBaseUrl")
				const condensingModelId = provider.contextProxy.getGlobalState("condensingModelId")

				if (condensingBaseUrl) {
					return buildApiHandler({
						apiProvider: "openai",
						openAiApiKey: "none",
						openAiBaseUrl: condensingBaseUrl,
						openAiModelId: condensingModelId || undefined,
					})
				}
			}
		} catch (error) {
			console.error("[Task] Failed to build condensing API handler:", error)
		}
		// Fallback to the task's main API handler
		return this.api
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode && !this.isRefineMode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)

					// Update this task's API configuration to match the new profile
					// This ensures the parser state is synchronized with the selected model
					const newState = await provider.getState()
					if (newState?.apiConfiguration) {
						this.updateApiConfiguration(newState.apiConfiguration)
					}
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				// Handle the message directly instead of routing through the webview.
				// This avoids a race condition where the webview's message state hasn't
				// hydrated yet, causing it to interpret the message as a new task request.
				this.handleWebviewAskResponse("messageResponse", text, images)
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByRoo()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Roo:`, error)
			return undefined
		}
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
					})
				}
			} else {
				// New now have a complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					if (contextCondense) {
						lastMessage.contextCondense = contextCondense
					}
					if (contextTruncation) {
						lastMessage.contextTruncation = contextTruncation
					}

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
			})
		}

		// Broadcast browser session updates to panel when browser-related messages are added
		if (type === "browser_action" || type === "browser_action_result" || type === "browser_session_status") {
			this.broadcastBrowserSessionUpdate()
		}
	}

	// ------------------------------------------------------------------
	// Subagent helpers — used by SubagentRunner to push tagged messages
	// ------------------------------------------------------------------

	/**
	 * Push a ClineMessage tagged with a subagentId into this task's messages
	 * and notify the webview. Used by SubagentRunner for parallel execution UI.
	 */
	async pushSubagentMessage(msg: ClineMessage): Promise<void> {
		// Check if this is an update to an existing partial message
		const existingIdx = this.findLastSubagentPartial(msg.subagentId, msg.say)
		if (msg.partial && existingIdx >= 0) {
			const existing = this.clineMessages[existingIdx]
			existing.text = msg.text
			existing.images = msg.images
			existing.partial = msg.partial
			await this.updateClineMessage(existing)
			return
		}

		// If this is finalizing a partial, update in-place
		if (!msg.partial && existingIdx >= 0 && this.clineMessages[existingIdx].partial) {
			const existing = this.clineMessages[existingIdx]
			existing.text = msg.text
			existing.images = msg.images
			existing.partial = false
			await this.saveClineMessages()
			await this.updateClineMessage(existing)
			return
		}

		// New message
		this.clineMessages.push(msg)
		await this.saveClineMessages()
		await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
	}

	private findLastSubagentPartial(subagentId: string | undefined, sayType: ClineSay | undefined): number {
		if (!subagentId || !sayType) return -1
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			const m = this.clineMessages[i]
			if (m.subagentId === subagentId && m.type === "say" && m.say === sayType && m.partial) {
				return i
			}
		}
		return -1
	}

	/**
	 * Execute a tool on behalf of a subagent. This is a simplified tool execution
	 * path for isolated subagent runs.
	 *
	 * Returns the tool result text.
	 */
	async executeToolForSubagent(
		toolName: string,
		toolParams: Record<string, unknown>,
		toolUseId: string,
		subagentId: string,
	): Promise<string> {
		// For now, delegate to the DiffViewProvider / file system directly
		// This is a simplified execution path — full tool routing via presentAssistantMessage
		// is too coupled to the single-task model.
		const cwd = this.cwd
		const resolvePath = (filePath: string) => (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath))
		const countOccurrences = (source: string, search: string) => (search ? source.split(search).length - 1 : 0)
		const replaceLiteral = (source: string, search: string, replacement: string) =>
			source.split(search).join(replacement)
		const detectLineEnding = (content: string) => (content.includes("\r\n") ? "\r\n" : "\n")
		const restoreLineEnding = (content: string, lineEnding: string) =>
			lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content
		const writeSubagentFile = async (filePath: string, content: string, toolLabel?: string): Promise<string> => {
			const absolutePath = resolvePath(filePath)
			let previousContent = ""
			let fileExists = false
			try {
				previousContent = await fs.readFile(absolutePath, "utf-8")
				fileExists = true
			} catch {}
			await fs.mkdir(path.dirname(absolutePath), { recursive: true })
			await fs.writeFile(absolutePath, content, "utf-8")
			const readablePath = getReadablePath(cwd, filePath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
			let diff = fileExists
				? formatResponse.createPrettyPatch(readablePath, previousContent, content)
				: convertNewFileToUnifiedDiff(content, readablePath)
			diff = sanitizeUnifiedDiff(diff)
			await this.pushSubagentMessage({
				ts: Date.now(),
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: toolLabel ?? (fileExists ? "editedExistingFile" : "newFileCreated"),
					path: readablePath,
					isOutsideWorkspace,
					content: diff,
					diffStats: computeDiffStats(diff) || undefined,
				}),
				subagentId,
			})
			this.didEditFile = true
			return `File written successfully: ${filePath}`
		}
		const deleteSubagentFile = async (filePath: string): Promise<string> => {
			const absolutePath = resolvePath(filePath)
			const previousContent = await fs.readFile(absolutePath, "utf-8")
			await fs.unlink(absolutePath)
			const readablePath = getReadablePath(cwd, filePath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
			let diff = formatResponse.createPrettyPatch(readablePath, previousContent, "")
			diff = sanitizeUnifiedDiff(diff)
			await this.pushSubagentMessage({
				ts: Date.now(),
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: "appliedDiff",
					path: readablePath,
					isOutsideWorkspace,
					content: diff,
					diffStats: computeDiffStats(diff) || undefined,
				}),
				subagentId,
			})
			this.didEditFile = true
			return `File deleted successfully: ${filePath}`
		}
		const globToRegExp = (pattern: string) => {
			const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			const regex = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/\\\\]*").replace(/\?/g, "[^/\\\\]")
			return new RegExp(`^${regex}$`, "i")
		}
		const formatDelegatedToolResponse = (content: ToolResponse): string => {
			if (typeof content === "string") {
				return content || "(tool did not return anything)"
			}
			const text = content
				.map((item) => (item.type === "text" ? item.text : item.type === "image" ? "[image]" : ""))
				.filter(Boolean)
				.join("\n")
			return text || "(tool did not return anything)"
		}
		const executeDelegatedSubagentTool = async (
			requestedToolName: string,
			params: Record<string, unknown>,
		): Promise<string> => {
			if (requestedToolName === "switch_mode" || requestedToolName === "write_todo_plan") {
				return `[ERROR] Tool "${requestedToolName}" is disabled in subagent mode.`
			}

			const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
			const { isMcpTool, parseMcpToolName } = await import("../../utils/mcp-name")
			const canonicalToolName = resolveToolAlias(requestedToolName)
			let resultText = "(tool did not return anything)"
			const pushToolResult = (content: ToolResponse) => {
				resultText = formatDelegatedToolResponse(content)
			}
			const handleError = async (action: string, error: Error) => {
				resultText = `[ERROR] Error ${action}: ${error.message}`
				await this.pushSubagentMessage({
					ts: Date.now(),
					type: "say",
					say: "error",
					text: resultText,
					subagentId,
				})
			}
			const askApproval = async (
				type: ClineAsk,
				partialMessage?: string,
				progressStatus?: ToolProgressStatus,
				forceApproval?: boolean,
			): Promise<boolean> => {
				const { response, text, images } = await this.ask(
					type,
					partialMessage,
					false,
					progressStatus,
					forceApproval,
				)
				if (response !== "yesButtonClicked") {
					resultText = text
						? (formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images) as string)
						: formatResponse.toolDenied()
					return false
				}
				if (text) {
					await this.say("user_feedback", text, images)
				}
				return true
			}
			const block = {
				type: "tool_use" as const,
				id: toolUseId,
				name: canonicalToolName as ToolName,
				originalName: requestedToolName !== canonicalToolName ? requestedToolName : undefined,
				params: params as ToolUse["params"],
				partial: false,
				nativeArgs: params as never,
			}

			if (isMcpTool(requestedToolName)) {
				const parsed = parseMcpToolName(requestedToolName)
				if (!parsed) {
					return `[ERROR] Invalid MCP tool name: ${requestedToolName}`
				}
				const { useMcpToolTool } = await import("../tools/UseMcpToolTool")
				await useMcpToolTool.handle(
					this,
					{
						...block,
						name: "use_mcp_tool",
						params: {
							server_name: parsed.serverName,
							tool_name: parsed.toolName,
							arguments: JSON.stringify(params),
						},
						nativeArgs: {
							server_name: parsed.serverName,
							tool_name: parsed.toolName,
							arguments: params,
						},
					} as ToolUse<"use_mcp_tool">,
					{ askApproval, handleError, pushToolResult },
				)
				return resultText
			}

			const delegatedBlock = block as any
			switch (canonicalToolName) {
				case "read_file": {
					const { readFileTool } = await import("../tools/ReadFileTool")
					await readFileTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "list_files": {
					const { listFilesTool } = await import("../tools/ListFilesTool")
					await listFilesTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "find_by_name": {
					const { findByNameTool } = await import("../tools/FindByNameTool")
					await findByNameTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "codebase_search": {
					const { codebaseSearchTool } = await import("../tools/CodebaseSearchTool")
					await codebaseSearchTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "search_files": {
					const { searchFilesTool } = await import("../tools/SearchFilesTool")
					await searchFilesTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "read_command_output": {
					const { readCommandOutputTool } = await import("../tools/ReadCommandOutputTool")
					await readCommandOutputTool.handle(this, delegatedBlock, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				}
				case "read_terminal": {
					const { readTerminalTool } = await import("../tools/ReadTerminalTool")
					await readTerminalTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "read_url_content": {
					const { readUrlContentTool } = await import("../tools/ReadUrlContentTool")
					await readUrlContentTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "read_notebook": {
					const { readNotebookTool } = await import("../tools/ReadNotebookTool")
					await readNotebookTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "view_content_chunk": {
					const { viewContentChunkTool } = await import("../tools/ViewContentChunkTool")
					await viewContentChunkTool.handle(this, delegatedBlock, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				}
				case "create_memory": {
					const { createMemoryTool } = await import("../tools/CreateMemoryTool")
					await createMemoryTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "recall_memory": {
					const { recallMemoryTool } = await import("../tools/RecallMemoryTool")
					await recallMemoryTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "search_web": {
					const { searchWebTool } = await import("../tools/SearchWebTool")
					await searchWebTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "use_mcp_tool": {
					const { useMcpToolTool } = await import("../tools/UseMcpToolTool")
					await useMcpToolTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "access_mcp_resource": {
					const { accessMcpResourceTool } = await import("../tools/accessMcpResourceTool")
					await accessMcpResourceTool.handle(this, delegatedBlock, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				}
				case "ask_followup_question": {
					const { askFollowupQuestionTool } = await import("../tools/AskFollowupQuestionTool")
					await askFollowupQuestionTool.handle(this, delegatedBlock, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				}
				case "browser_action": {
					const { browserActionTool } = await import("../tools/BrowserActionTool")
					await browserActionTool(this, delegatedBlock, askApproval, handleError, pushToolResult)
					break
				}
				case "execute_command": {
					const { executeCommandTool } = await import("../tools/ExecuteCommandTool")
					await executeCommandTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "command_status": {
					const { commandStatusTool } = await import("../tools/CommandStatusTool")
					await commandStatusTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "generate_image": {
					const { generateImageTool } = await import("../tools/GenerateImageTool")
					await generateImageTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "update_todo_list": {
					const { updateTodoListTool } = await import("../tools/UpdateTodoListTool")
					await updateTodoListTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "run_slash_command": {
					const { runSlashCommandTool } = await import("../tools/RunSlashCommandTool")
					await runSlashCommandTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				case "skill": {
					const { skillTool } = await import("../tools/SkillTool")
					await skillTool.handle(this, delegatedBlock, { askApproval, handleError, pushToolResult })
					break
				}
				default: {
					const state = await this.providerRef.deref()?.getState()
					if (state?.experiments?.customTools) {
						const { customToolRegistry } = await import("@roo-code/core")
						const customTool = customToolRegistry.get(requestedToolName)
						if (customTool) {
							const customToolArgs = customTool.parameters ? customTool.parameters.parse(params) : params
							const customResult = await customTool.execute(customToolArgs, {
								mode: this.taskMode,
								task: this,
							})
							pushToolResult(customResult)
							break
						}
					}
					return `[ERROR] Tool "${requestedToolName}" is not available in subagent mode.`
				}
			}
			return resultText
		}

		switch (toolName) {
			case "read_file": {
				const filePath = toolParams.path as string
				if (!filePath) return "[ERROR] Missing path parameter"
				const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
				try {
					const fs = await import("fs/promises")
					const content = await fs.readFile(absolutePath, "utf-8")
					const readablePath = getReadablePath(cwd, filePath)
					const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
					await this.pushSubagentMessage({
						ts: Date.now(),
						type: "say",
						say: "tool",
						text: JSON.stringify({
							tool: "readFile",
							path: readablePath,
							isOutsideWorkspace,
							content: absolutePath,
						}),
						subagentId,
					})
					return content
				} catch (err) {
					return `[ERROR] Failed to read file: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "write_to_file": {
				const filePath = toolParams.path as string
				const content = toolParams.content as string
				if (!filePath) return "[ERROR] Missing path parameter"
				if (content === undefined) return "[ERROR] Missing content parameter"
				try {
					return await writeSubagentFile(filePath, content)
				} catch (err) {
					return `[ERROR] Failed to write file: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "apply_diff": {
				const filePath = toolParams.path as string
				const diffContent = toolParams.diff as string
				if (!filePath) return "[ERROR] Missing path parameter"
				if (!diffContent) return "[ERROR] Missing diff parameter"
				const absolutePath = resolvePath(filePath)
				try {
					const originalContent = await fs.readFile(absolutePath, "utf-8")
					const diffResult = (await this.diffStrategy?.applyDiff(
						originalContent,
						diffContent,
						parseInt(diffContent.match(/:start_line:(\d+)/)?.[1] ?? ""),
					)) ?? {
						success: false,
						error: "No diff strategy available",
					}
					if (!diffResult.success) {
						return `[ERROR] Failed to apply diff: ${diffResult.error ?? "unknown error"}`
					}
					await writeSubagentFile(filePath, diffResult.content, "appliedDiff")
					return `Applied diff successfully: ${filePath}`
				} catch (err) {
					return `[ERROR] Failed to apply diff: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "apply_patch": {
				const patchContent = toolParams.patch as string
				if (!patchContent) return "[ERROR] Missing patch parameter"
				try {
					const { parsePatch, processAllHunks } = await import("../tools/apply-patch")
					const parsedPatch = parsePatch(patchContent)
					if (parsedPatch.hunks.length === 0) {
						return "No file operations found in patch."
					}
					for (const hunk of parsedPatch.hunks) {
						const hunkPaths = [
							hunk.path,
							hunk.type === "UpdateFile" && hunk.movePath ? hunk.movePath : undefined,
						].filter((candidate): candidate is string => !!candidate)
						for (const hunkPath of hunkPaths) {
							const accessAllowed = this.rooIgnoreController?.validateAccess(hunkPath)
							if (!accessAllowed) {
								return formatResponse.rooIgnoreError(hunkPath) as string
							}
							if (this.rooProtectedController?.isWriteProtected(hunkPath)) {
								return `[ERROR] Cannot modify write-protected path: ${hunkPath}`
							}
						}
						if (hunk.type === "AddFile") {
							try {
								await fs.access(resolvePath(hunk.path))
								return `[ERROR] File already exists: ${hunk.path}. Use Update File instead.`
							} catch {}
						}
						if (
							hunk.type === "UpdateFile" &&
							hunk.movePath &&
							isPathOutsideWorkspace(resolvePath(hunk.movePath))
						) {
							return `[ERROR] Cannot move file to path outside workspace: ${hunk.movePath}`
						}
					}
					const changes = await processAllHunks(parsedPatch.hunks, async (filePath: string) => {
						return await fs.readFile(resolvePath(filePath), "utf-8")
					})
					const touchedFiles: string[] = []
					for (const change of changes) {
						const relPath = change.path
						const absolutePath = resolvePath(relPath)
						const accessAllowed = this.rooIgnoreController?.validateAccess(relPath)
						if (!accessAllowed) {
							return formatResponse.rooIgnoreError(relPath) as string
						}
						if (this.rooProtectedController?.isWriteProtected(relPath)) {
							return `[ERROR] Cannot modify write-protected path: ${relPath}`
						}
						if (change.type === "add") {
							await writeSubagentFile(relPath, change.newContent ?? "", "appliedDiff")
							touchedFiles.push(relPath)
							continue
						}
						if (change.type === "delete") {
							await deleteSubagentFile(relPath)
							touchedFiles.push(relPath)
							continue
						}
						const newContent = change.newContent ?? ""
						if (change.movePath) {
							const movePath = change.movePath
							const moveAbsolutePath = resolvePath(movePath)
							const moveAccessAllowed = this.rooIgnoreController?.validateAccess(movePath)
							if (!moveAccessAllowed) {
								return formatResponse.rooIgnoreError(movePath) as string
							}
							if (this.rooProtectedController?.isWriteProtected(movePath)) {
								return `[ERROR] Cannot move file to write-protected path: ${movePath}`
							}
							if (isPathOutsideWorkspace(moveAbsolutePath)) {
								return `[ERROR] Cannot move file to path outside workspace: ${movePath}`
							}
							await writeSubagentFile(movePath, newContent, "appliedDiff")
							await fs.unlink(absolutePath)
							touchedFiles.push(relPath, movePath)
							continue
						}
						await writeSubagentFile(relPath, newContent, "appliedDiff")
						touchedFiles.push(relPath)
					}
					return `Applied patch successfully: ${Array.from(new Set(touchedFiles)).join(", ")}`
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err)
					const isParseError = err instanceof Error && err.name === "ParseError"
					return `[ERROR] ${isParseError ? "Invalid patch format" : "Failed to apply patch"}: ${message}`
				}
			}

			case "edit":
			case "search_and_replace": {
				const filePath = toolParams.file_path as string
				const oldString = toolParams.old_string as string
				const newString = toolParams.new_string as string
				const replaceAll = toolParams.replace_all === true
				if (!filePath) return "[ERROR] Missing file_path parameter"
				if (!oldString) return "[ERROR] Missing old_string parameter"
				if (newString === undefined) return "[ERROR] Missing new_string parameter"
				try {
					const originalContent = await fs.readFile(resolvePath(filePath), "utf-8")
					const lineEnding = detectLineEnding(originalContent)
					const normalizedContent = originalContent.replace(/\r\n/g, "\n")
					const normalizedOld = oldString.replace(/\r\n/g, "\n")
					const normalizedNew = newString.replace(/\r\n/g, "\n")
					const matches = countOccurrences(normalizedContent, normalizedOld)
					if (matches === 0) return "[ERROR] No match found for old_string"
					if (!replaceAll && matches > 1) return `[ERROR] Found ${matches} matches for old_string`
					const nextContent = restoreLineEnding(
						replaceAll
							? replaceLiteral(normalizedContent, normalizedOld, normalizedNew)
							: normalizedContent.replace(normalizedOld, normalizedNew),
						lineEnding,
					)
					await writeSubagentFile(filePath, nextContent, "appliedDiff")
					return `Edited file successfully: ${filePath}`
				} catch (err) {
					return `[ERROR] Failed to ${toolName}: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "search_replace": {
				const filePath = toolParams.file_path as string
				const oldString = toolParams.old_string as string
				const newString = toolParams.new_string as string
				if (!filePath) return "[ERROR] Missing file_path parameter"
				if (!oldString) return "[ERROR] Missing old_string parameter"
				if (newString === undefined) return "[ERROR] Missing new_string parameter"
				try {
					const originalContent = await fs.readFile(resolvePath(filePath), "utf-8")
					const lineEnding = detectLineEnding(originalContent)
					const normalizedContent = originalContent.replace(/\r\n/g, "\n")
					const normalizedOld = oldString.replace(/\r\n/g, "\n")
					const normalizedNew = newString.replace(/\r\n/g, "\n")
					const matches = countOccurrences(normalizedContent, normalizedOld)
					if (matches === 0) return "[ERROR] No match found for old_string"
					if (matches > 1) return `[ERROR] Found ${matches} matches for old_string; provide more context`
					const nextContent = restoreLineEnding(
						normalizedContent.replace(normalizedOld, normalizedNew),
						lineEnding,
					)
					await writeSubagentFile(filePath, nextContent, "appliedDiff")
					return `Replaced one occurrence successfully: ${filePath}`
				} catch (err) {
					return `[ERROR] Failed to search_replace: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "edit_file": {
				const filePath = toolParams.file_path as string
				const oldString = typeof toolParams.old_string === "string" ? toolParams.old_string : ""
				const newString = typeof toolParams.new_string === "string" ? toolParams.new_string : ""
				const expectedReplacements =
					typeof toolParams.expected_replacements === "number" ? toolParams.expected_replacements : 1
				if (!filePath) return "[ERROR] Missing file_path parameter"
				try {
					const absolutePath = resolvePath(filePath)
					if (oldString === "") {
						try {
							await fs.access(absolutePath)
							return `[ERROR] File already exists: ${filePath}`
						} catch {}
						await writeSubagentFile(filePath, newString)
						return `Created file successfully: ${filePath}`
					}
					const originalContent = await fs.readFile(absolutePath, "utf-8")
					const lineEnding = detectLineEnding(originalContent)
					const normalizedContent = originalContent.replace(/\r\n/g, "\n")
					const normalizedOld = oldString.replace(/\r\n/g, "\n")
					const normalizedNew = newString.replace(/\r\n/g, "\n")
					const matches = countOccurrences(normalizedContent, normalizedOld)
					if (matches !== expectedReplacements) {
						return `[ERROR] Expected ${expectedReplacements} replacement(s), found ${matches}`
					}
					const nextContent = restoreLineEnding(
						replaceLiteral(normalizedContent, normalizedOld, normalizedNew),
						lineEnding,
					)
					await writeSubagentFile(filePath, nextContent, "appliedDiff")
					return `Edited file successfully: ${filePath}`
				} catch (err) {
					return `[ERROR] Failed to edit_file: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "multi_edit": {
				const filePath = toolParams.file_path as string
				const edits = Array.isArray(toolParams.edits)
					? (toolParams.edits as Array<Record<string, unknown>>)
					: []
				if (!filePath) return "[ERROR] Missing file_path parameter"
				if (edits.length === 0) return "[ERROR] Missing edits parameter"
				try {
					const originalContent = await fs.readFile(resolvePath(filePath), "utf-8")
					const lineEnding = detectLineEnding(originalContent)
					let currentContent = originalContent.replace(/\r\n/g, "\n")
					for (let index = 0; index < edits.length; index++) {
						const edit = edits[index]
						const oldString =
							typeof edit.old_string === "string" ? edit.old_string.replace(/\r\n/g, "\n") : ""
						const newString =
							typeof edit.new_string === "string" ? edit.new_string.replace(/\r\n/g, "\n") : ""
						const replaceAll = edit.replace_all === true
						if (!oldString) return `[ERROR] Edit ${index + 1} is missing old_string`
						const matches = countOccurrences(currentContent, oldString)
						if (matches === 0) return `[ERROR] Edit ${index + 1} found no matches`
						if (!replaceAll && matches > 1) return `[ERROR] Edit ${index + 1} found ${matches} matches`
						currentContent = replaceAll
							? replaceLiteral(currentContent, oldString, newString)
							: currentContent.replace(oldString, newString)
					}
					await writeSubagentFile(filePath, restoreLineEnding(currentContent, lineEnding), "appliedDiff")
					return `Applied ${edits.length} edits successfully: ${filePath}`
				} catch (err) {
					return `[ERROR] Failed to multi_edit: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "edit_notebook": {
				const absolutePathParam = toolParams.absolute_path as string
				const newSource = toolParams.new_source as string
				const cellNumber = typeof toolParams.cell_number === "number" ? toolParams.cell_number : 0
				const cellType = toolParams.cell_type === "markdown" ? "markdown" : "code"
				const mode = toolParams.edit_mode === "insert" ? "insert" : "replace"
				const cellId =
					typeof toolParams.cell_id === "string" && toolParams.cell_id ? toolParams.cell_id : undefined
				if (!absolutePathParam) return "[ERROR] Missing absolute_path parameter"
				if (newSource === undefined) return "[ERROR] Missing new_source parameter"
				if (!absolutePathParam.endsWith(".ipynb")) return "[ERROR] File must be a Jupyter notebook (.ipynb)"
				const absolutePath = resolvePath(absolutePathParam)
				const readablePath = getReadablePath(cwd, absolutePathParam)
				const accessAllowed = this.rooIgnoreController?.validateAccess(absolutePathParam)
				if (!accessAllowed) return formatResponse.rooIgnoreError(absolutePathParam) as string
				if (this.rooProtectedController?.isWriteProtected(absolutePathParam)) {
					return `[ERROR] Cannot modify write-protected path: ${absolutePathParam}`
				}
				try {
					let previousContent = ""
					let fileExists = false
					try {
						previousContent = await fs.readFile(absolutePath, "utf-8")
						fileExists = true
					} catch {}
					if (!fileExists && mode === "replace") {
						return `[ERROR] Notebook not found: ${absolutePathParam}`
					}
					const notebook = fileExists
						? JSON.parse(previousContent)
						: { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }
					if (!Array.isArray(notebook.cells)) {
						return "[ERROR] Invalid notebook format: missing cells array"
					}
					let targetIndex = cellNumber
					if (cellId) {
						targetIndex = notebook.cells.findIndex((cell: { id?: string }) => cell.id === cellId)
						if (targetIndex === -1 && mode === "replace") {
							return `[ERROR] Cell with id '${cellId}' not found`
						}
						if (targetIndex === -1) {
							targetIndex = notebook.cells.length
						}
					}
					if (mode === "replace") {
						if (targetIndex < 0 || targetIndex >= notebook.cells.length) {
							return `[ERROR] Cell index ${targetIndex} out of range. Notebook has ${notebook.cells.length} cells.`
						}
					} else if (targetIndex < 0 || targetIndex > notebook.cells.length) {
						return `[ERROR] Insert position ${targetIndex} out of range. Notebook has ${notebook.cells.length} cells.`
					}
					const newCell: Record<string, unknown> = {
						cell_type: cellType,
						id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
						source: newSource
							.split("\n")
							.map((line, index, lines) => (index < lines.length - 1 ? `${line}\n` : line)),
						metadata: {},
					}
					if (cellType === "code") {
						newCell.outputs = []
						newCell.execution_count = null
					}
					if (mode === "insert") {
						notebook.cells.splice(targetIndex, 0, newCell)
					} else {
						const oldCell = notebook.cells[targetIndex]
						newCell.cell_type = oldCell.cell_type
						if (oldCell.id) {
							newCell.id = oldCell.id
						}
						notebook.cells[targetIndex] = newCell
					}
					const nextContent = JSON.stringify(notebook, null, 1)
					await writeSubagentFile(absolutePathParam, nextContent, "editedExistingFile")
					return `${mode === "insert" ? "Inserted" : "Replaced"} cell ${targetIndex} in ${readablePath}`
				} catch (err) {
					return `[ERROR] Failed to edit_notebook: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "search_files": {
				const searchPath = (toolParams.path as string) ?? cwd
				const regex = toolParams.regex as string
				const filePattern = toolParams.file_pattern as string | undefined
				if (!regex) return "[ERROR] Missing regex parameter"
				const absoluteSearchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(cwd, searchPath)
				let result = "No matches found"
				try {
					const { execSync } = await import("child_process")
					result = execSync(`rg --json -e ${JSON.stringify(regex)} ${JSON.stringify(searchPath)}`, {
						encoding: "utf-8",
						maxBuffer: 1024 * 1024,
						timeout: 10000,
					})
						.toString()
						.slice(0, 5000)
				} catch {}
				await this.pushSubagentMessage({
					ts: Date.now(),
					type: "say",
					say: "tool",
					text: JSON.stringify({
						tool: "searchFiles",
						path: getReadablePath(cwd, searchPath),
						regex,
						filePattern: filePattern ?? "",
						isOutsideWorkspace: isPathOutsideWorkspace(absoluteSearchPath),
						content: result,
					}),
					subagentId,
				})
				return result
			}

			case "find_by_name": {
				const searchPath = (toolParams.path as string) || "."
				const pattern = (toolParams.pattern as string) || "*"
				const extensions = Array.isArray(toolParams.extensions)
					? (toolParams.extensions as string[])
							.filter(Boolean)
							.map((ext) => ext.replace(/^\./, "").toLowerCase())
					: []
				const excludes = Array.isArray(toolParams.excludes)
					? (toolParams.excludes as string[]).filter(Boolean)
					: []
				const maxDepth = typeof toolParams.max_depth === "number" ? toolParams.max_depth : undefined
				const entryType = typeof toolParams.type === "string" ? toolParams.type : "any"
				const fullPath = toolParams.full_path === true
				const absoluteSearchPath = resolvePath(searchPath)
				const matcher = globToRegExp(pattern)
				const excludeMatchers = excludes.map(globToRegExp)
				const results: string[] = []
				const visit = async (directory: string, depth: number): Promise<void> => {
					if (results.length >= 50 || (maxDepth !== undefined && depth > maxDepth)) return
					let entries: import("fs").Dirent[]
					try {
						entries = await fs.readdir(directory, { withFileTypes: true })
					} catch {
						return
					}
					for (const entry of entries) {
						if (results.length >= 50) return
						const absoluteEntryPath = path.join(directory, entry.name)
						const relativeEntryPath = path
							.relative(absoluteSearchPath, absoluteEntryPath)
							.replace(/\\/g, "/")
						if (excludeMatchers.some((excludeMatcher) => excludeMatcher.test(relativeEntryPath))) continue
						const isDirectory = entry.isDirectory()
						const isFile = entry.isFile()
						const matchesType =
							entryType === "any" ||
							(entryType === "directory" && isDirectory) ||
							(entryType === "file" && isFile)
						const target = fullPath ? relativeEntryPath : entry.name
						const matchesExtension =
							extensions.length === 0 ||
							(isFile && extensions.includes(path.extname(entry.name).replace(/^\./, "").toLowerCase()))
						if (matchesType && matchesExtension && matcher.test(target)) {
							results.push(`${isDirectory ? "[DIR]" : "[FILE]"} ${relativeEntryPath}`)
						}
						if (isDirectory) {
							await visit(absoluteEntryPath, depth + 1)
						}
					}
				}
				await visit(absoluteSearchPath, 1)
				const result = results.length > 0 ? results.join("\n") : "No matches found"
				await this.pushSubagentMessage({
					ts: Date.now(),
					type: "say",
					say: "tool",
					text: JSON.stringify({
						tool: "findByName",
						path: getReadablePath(cwd, searchPath),
						isOutsideWorkspace: isPathOutsideWorkspace(absoluteSearchPath),
						content: result,
					}),
					subagentId,
				})
				return result
			}

			case "list_files": {
				const dirPath = (toolParams.path as string) ?? cwd
				const recursive = toolParams.recursive === true || toolParams.recursive === "true"
				const absolutePath = path.isAbsolute(dirPath) ? dirPath : path.resolve(cwd, dirPath)
				try {
					const fs = await import("fs/promises")
					const entries = await fs.readdir(absolutePath, { withFileTypes: true })
					const items = entries.map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
					const result = items.join("\n")
					await this.pushSubagentMessage({
						ts: Date.now(),
						type: "say",
						say: "tool",
						text: JSON.stringify({
							tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
							path: getReadablePath(cwd, dirPath),
							isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
							content: result,
						}),
						subagentId,
					})
					return result
				} catch (err) {
					return `[ERROR] Failed to list files: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			case "attempt_completion": {
				return (toolParams.result as string) ?? "Task completed"
			}

			default:
				return await executeDelegatedSubagentTool(toolName, toolParams)
		}
	}

	/**
	 * Launch parallel subagent runners for all todo items that have plans.
	 * Called automatically by WriteTodoPlanTool after all plans are written.
	 * Each subagent runs concurrently within this task, sharing the ApiHandler.
	 */
	async runParallelSubagents(): Promise<void> {
		const todos = this.todoList ?? []
		if (todos.length === 0) {
			console.warn("[runParallelSubagents] No todo items found")
			return
		}
		const resumeState = await this.readSubagentResumeState()
		const unfinishedTodoIds = resumeState ? new Set(this.getUnfinishedSubagentTodoIds(resumeState)) : undefined
		const todosToRun = unfinishedTodoIds ? todos.filter((todo) => unfinishedTodoIds.has(todo.id)) : todos
		if (todosToRun.length === 0) {
			await this.clearSubagentResumeState()
			console.warn("[runParallelSubagents] No unfinished todo items found")
			return
		}

		const globalStoragePath = this.globalStoragePath
		const taskId = this.taskId
		const taskTimestamp = this.taskTimestamp
		await this.persistSubagentResumeState(resumeState?.todoItemIds ?? todos.map((todo) => todo.id))

		// Emit a divider indicating parallel execution is starting
		await this.say("text", "\n\n---\n**Starting parallel execution for unfinished todo items...**\n---\n")

		// Exit refine mode
		this.isRefineMode = false
		this.activeRefineTodoItemIds = null

		// Build system prompt for subagents (build mode)
		const systemPrompt = buildDetachedSubagentExecutionSystemPrompt(this.cwd)
		console.log("[runParallelSubagents] Prepared system prompt", {
			taskId: this.taskId,
			todoCount: todosToRun.length,
			systemPromptHasRefineMarkers:
				systemPrompt.includes("Plan mode ACTIVE") ||
				systemPrompt.includes("write_todo_plan") ||
				systemPrompt.includes("update_todo_list"),
			systemPromptPreview: systemPrompt.slice(0, 320),
		})

		// Get tools for subagents
		const modelInfo = this.api.getModel().info
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider reference lost during subagent tool building")
		}
		const providerState = await provider.getState()
		const { tools: rawSubagentTools } = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: this.cwd,
			mode: this.taskMode,
			customModes: providerState?.customModes,
			experiments: providerState?.experiments,
			apiConfiguration: this.apiConfiguration,
			browserToolEnabled: providerState?.browserToolEnabled ?? true,
			disabledTools: providerState?.disabledTools,
			modelInfo,
			includeAllToolsWithRestrictions: true,
			taskEstablished: true,
		})
		const { subagentAttemptCompletion } = await import("../prompts/tools/native-tools")
		const tools = rawSubagentTools
			.filter(
				(tool) =>
					!("function" in tool) ||
					(tool.function.name !== "switch_mode" &&
						tool.function.name !== "write_todo_plan" &&
						tool.function.name !== "list_files"),
			)
			.map((tool) => {
				if ("function" in tool && tool.function.name === "attempt_completion") {
					return subagentAttemptCompletion
				}
				return tool
			})

		// Import SubagentRunner
		const { SubagentRunner } = await import("./SubagentRunner")

		// Create a runner for each todo item
		const runnerEntries: Array<{
			runner: InstanceType<typeof SubagentRunner>
			todo: TodoItem
			planFiles: PlanFile[]
		}> = []
		for (const todo of todosToRun) {
			// Read plan files for this todo item
			let planResult: { plans: import("../task-persistence/plan-persistence").PlanFile[] }
			try {
				planResult = await readPlanFiles(globalStoragePath, taskId, taskTimestamp, todo.id, todo.content)
			} catch {
				planResult = { plans: [] }
			}

			console.log("[runParallelSubagents] Creating subagent runner", {
				taskId: this.taskId,
				todoId: todo.id,
				todoContent: todo.content,
				planFilePaths: planResult.plans.map((plan) => plan.filePath),
			})

			const runner = new SubagentRunner({
				parentTask: this,
				todoItem: todo,
				planFiles: planResult.plans,
				systemPrompt,
				tools,
			})
			runnerEntries.push({ runner, todo, planFiles: planResult.plans })
		}

		// Run all subagents concurrently
		console.log(`[runParallelSubagents] Starting ${runnerEntries.length} subagents for task ${taskId}`)
		const results = await Promise.allSettled(
			runnerEntries.map(async ({ runner, todo, planFiles }) => {
				const subagentResult = await runner.run()
				const agreementPass = subagentResult.completionResult?.trim()
					? await this.enqueuePostSubtaskAgreementPass(todo, planFiles, subagentResult.completionResult)
					: {
							executed: false,
							appendedCount: 0,
							fileAgreementCount: 0,
							skippedReason: "missing attempt_completion result",
						}
				const agreementPassSucceeded = agreementPass.executed && !agreementPass.error
				const overallSuccess = subagentResult.success && agreementPassSucceeded
				if (overallSuccess) {
					await this.markSubagentResumeTodoCompleted(todo.id)
				}

				return {
					subagentResult,
					agreementPass,
					overallSuccess,
				}
			}),
		)

		// Collect results
		const summaryParts: string[] = []
		let allSucceeded = true
		for (let i = 0; i < results.length; i++) {
			const result = results[i]
			const todo = runnerEntries[i]?.todo ?? todosToRun[i]
			if (result.status === "fulfilled") {
				const { subagentResult, agreementPass, overallSuccess } = result.value
				if (!overallSuccess) {
					allSucceeded = false
				}
				const agreementActions: string[] = []
				if (agreementPass.appendedCount > 0) {
					agreementActions.push(
						`appended agreements to ${agreementPass.appendedCount} task context block${agreementPass.appendedCount === 1 ? "" : "s"}`,
					)
				}
				if (agreementPass.fileAgreementCount > 0) {
					agreementActions.push(
						`merged ${agreementPass.fileAgreementCount} file-owned agreement${agreementPass.fileAgreementCount === 1 ? "" : "s"} into task context`,
					)
				}
				const agreementSummary = agreementPass.error
					? ` (STEP 3 failed: ${agreementPass.error}; subtask not marked complete)`
					: !agreementPass.executed
						? ` (STEP 3 skipped: ${agreementPass.skippedReason ?? "not triggered"}; subtask not marked complete)`
						: agreementActions.length > 0
							? ` (STEP 3 ${agreementActions.join(" and ")})`
							: ` (STEP 3 checked: no new agreements)`
				summaryParts.push(
					`- **${todo.content}**: ${overallSuccess ? "✅ " + (subagentResult.completionResult ?? "Done") : "❌ " + (subagentResult.success ? (subagentResult.completionResult ?? "Subagent completed") : (subagentResult.error ?? "Failed"))}${agreementSummary}`,
				)
			} else {
				allSucceeded = false
				summaryParts.push(`- **${todo.content}**: ❌ Error: ${result.reason}`)
			}
		}

		// Emit aggregated results summary
		await this.say(
			"text",
			`\n\n---\n**Parallel execution ${allSucceeded ? "complete" : "incomplete"}:**\n${summaryParts.join("\n")}\n---`,
		)

		if (allSucceeded) {
			await this.clearSubagentResumeState()
			console.log(`[runParallelSubagents] All ${runnerEntries.length} subagents finished for task ${taskId}`)
		} else {
			this.subagentResumeReviewPending = true
			console.warn(
				`[runParallelSubagents] Parallel execution incomplete for task ${taskId}; unfinished subagent state preserved.`,
			)
		}
	}

	public applyTaskContextAgreementsToPlanEntries(
		planFiles: PlanFile[],
		context?: string,
	): { plans: PlanFile[]; appliedCount: number } {
		return applyPlanAgreementsToPlanEntries(planFiles, getTaskContextPlanAgreements(context, planFiles))
	}

	public applyPlanAgreementsToPlanEntries(
		planFiles: PlanFile[],
		agreements: PlanFileAgreement[],
	): { plans: PlanFile[]; appliedCount: number } {
		return applyPlanAgreementsToPlanEntries(planFiles, agreements)
	}

	private async collectAvailableAgreementTargets(currentTodos: TodoItem[], planFiles: PlanFile[]): Promise<string[]> {
		const targets: string[] = []
		const seen = new Set<string>()
		const addTargets = (nextTargets: string[]) => {
			for (const target of nextTargets) {
				const normalized = normalizeCodeTargetPath(target)
				if (normalized && !seen.has(normalized)) {
					seen.add(normalized)
					targets.push(normalized)
				}
			}
		}

		addTargets(collectAvailableCodeTargets(currentTodos, planFiles))

		for (const todo of currentTodos) {
			if (!todo.id) {
				continue
			}
			try {
				const readResult = await readPlanFiles(
					this.globalStoragePath,
					this.taskId,
					this.taskTimestamp,
					todo.id,
					todo.content,
				)
				addTargets(collectCodePlanTargets([...readResult.plans, ...readResult.stubPlans]))
			} catch (error) {
				console.warn(`[STEP 3] failed to collect available plan targets for "${todo.content}":`, error)
			}
		}

		return targets
	}

	/**
	 * Public entry used by WriteTodoPlanTool to run STEP 3 immediately after
	 * a refine item's plan is recorded. Uses a refine-specific prompt that
	 * mines the just-written plan for concrete cross-task agreements, then
	 * appends them to OTHER refine items' contexts before they are refined.
	 */
	public async enqueuePostRefineAgreementPass(
		refinedTodo: TodoItem,
		planFiles: PlanFile[],
		fileProgress?: { current: number; total: number },
	): Promise<PostSubtaskAgreementPassOutcome> {
		if (planFiles.length === 0) {
			return Promise.resolve({
				executed: false,
				appendedCount: 0,
				fileAgreementCount: 0,
				skippedReason: "no plan files for refine-time agreement pass",
			})
		}
		const progressTotal = Math.max(fileProgress?.total ?? planFiles.length, planFiles.length)
		const progressBaseFileCount = fileProgress
			? Math.min(Math.max(0, fileProgress.current - planFiles.length), progressTotal)
			: 0
		const batches: PlanFile[][] = []
		for (let i = 0; i < planFiles.length; i += STEP3_REFINE_PLAN_BATCH_SIZE) {
			batches.push(planFiles.slice(i, i + STEP3_REFINE_PLAN_BATCH_SIZE))
		}

		const extractedFileAgreements: PostSubtaskFileAgreement[] = []
		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i]
			const processedFileCount = Math.min((i + 1) * STEP3_REFINE_PLAN_BATCH_SIZE, planFiles.length)
			const currentFileCount = Math.min(progressBaseFileCount + processedFileCount, progressTotal)
			const extraction = await this.enqueueAgreementExtractionPass(
				refinedTodo,
				(todos, availableTargets) =>
					buildPostRefineAgreementPrompt({
						refinedTodo,
						planFiles: batch,
						todos,
						availableTargets,
					}),
				batch,
				{
					progress: {
						label: "STEP 3 file agreement progress",
						current: currentFileCount,
						total: progressTotal,
						detail: `Processing ${batch.length} file${batch.length === 1 ? "" : "s"} in this STEP 3 pass`,
					},
					updateAllTodoContexts: true,
				},
			)

			if (!extraction.executed || extraction.error) {
				return {
					executed: extraction.executed,
					appendedCount: 0,
					fileAgreementCount: 0,
					planAgreementCount: 0,
					planAgreements: [],
					skippedReason: extraction.skippedReason,
					error: extraction.error,
				}
			}

			extractedFileAgreements.push(...extraction.fileAgreements)
		}

		return this.mergeAgreementPassFileAgreements(
			refinedTodo,
			mergePostSubtaskFileAgreements(extractedFileAgreements),
			{
				updateAllTodoContexts: true,
				progress: {
					label: "STEP 3 file agreement progress",
					current: Math.min(progressBaseFileCount + planFiles.length, progressTotal),
					total: progressTotal,
					detail:
						progressBaseFileCount + planFiles.length >= progressTotal
							? "All plan files checked"
							: "Current STEP 3 plan batch checked",
				},
			},
		)
	}

	private enqueuePostSubtaskAgreementPass(
		completedTodo: TodoItem,
		planFiles: PlanFile[],
		completionResult: string,
	): Promise<PostSubtaskAgreementPassOutcome> {
		const trimmedCompletionResult = completionResult.trim()
		if (!trimmedCompletionResult) {
			return Promise.resolve({
				executed: false,
				appendedCount: 0,
				fileAgreementCount: 0,
				skippedReason: "empty attempt_completion result",
			})
		}
		return this.enqueueAgreementPass(
			completedTodo,
			(todos, availableTargets) =>
				buildPostSubtaskAgreementPrompt({
					completedTodo,
					planFiles,
					completionResult: trimmedCompletionResult,
					todos,
					availableTargets,
				}),
			planFiles,
			{
				updateAllTodoContexts: true,
				...(planFiles.length > 0
					? {
							progress: {
								label: "STEP 3 file agreement progress",
								current: planFiles.length,
								total: planFiles.length,
								detail: "All plan files checked",
							},
						}
					: {}),
			},
		)
	}

	private enqueueAgreementPass(
		focusTodo: TodoItem,
		buildPrompt: AgreementPassPromptBuilder,
		planFiles: PlanFile[] = [],
		options: AgreementPassOptions = {},
	): Promise<PostSubtaskAgreementPassOutcome> {
		let release: (() => void) | undefined
		const previous = this.subtaskAgreementPassChain
		this.subtaskAgreementPassChain = new Promise<void>((resolve) => {
			release = resolve
		})

		return previous
			.catch(() => undefined)
			.then(async () => {
				try {
					return await this.runAgreementPass(focusTodo, buildPrompt, planFiles, options)
				} finally {
					release?.()
				}
			})
	}

	private enqueueAgreementExtractionPass(
		focusTodo: TodoItem,
		buildPrompt: AgreementPassPromptBuilder,
		planFiles: PlanFile[] = [],
		options: AgreementPassOptions = {},
	): Promise<AgreementPassExtractionOutcome> {
		let release: (() => void) | undefined
		const previous = this.subtaskAgreementPassChain
		this.subtaskAgreementPassChain = new Promise<void>((resolve) => {
			release = resolve
		})

		return previous
			.catch(() => undefined)
			.then(async () => {
				try {
					return await this.extractAgreementPass(focusTodo, buildPrompt, planFiles, options)
				} finally {
					release?.()
				}
			})
	}

	private async runAgreementPass(
		focusTodo: TodoItem,
		buildPrompt: AgreementPassPromptBuilder,
		planFiles: PlanFile[] = [],
		options: AgreementPassOptions = {},
	): Promise<PostSubtaskAgreementPassOutcome> {
		const extraction = await this.extractAgreementPass(focusTodo, buildPrompt, planFiles, options)
		if (!extraction.executed || extraction.error) {
			return {
				executed: extraction.executed,
				appendedCount: 0,
				fileAgreementCount: 0,
				skippedReason: extraction.skippedReason,
				error: extraction.error,
			}
		}
		return this.mergeAgreementPassFileAgreements(focusTodo, extraction.fileAgreements, options)
	}

	private async extractAgreementPass(
		focusTodo: TodoItem,
		buildPrompt: AgreementPassPromptBuilder,
		planFiles: PlanFile[] = [],
		options: AgreementPassOptions = {},
	): Promise<AgreementPassExtractionOutcome> {
		const currentTodos = (this.todoList ?? []).map((todo) => ({ ...todo }))
		if (currentTodos.length === 0) {
			return {
				executed: false,
				fileAgreements: [],
				skippedReason: "todo list unavailable",
			}
		}
		const availableSharedTargets = await this.collectAvailableAgreementTargets(currentTodos, planFiles)
		const agreementPrompt = buildPrompt(currentTodos, availableSharedTargets)
		const progressLabel = options.progressLabel ? ` ${options.progressLabel}` : ""

		let rawResponse: string
		try {
			ContextInspectorPanel.getInstance().logRefinePayloadDiagnostic({
				step: "STEP 3",
				stage: "singleCompletion",
				taskId: this.taskId,
				modelId: this.api.getModel().id,
				provider: this.apiConfiguration?.apiProvider,
				stepState: {
					refineStep1Complete: this.refineStep1Complete,
					activeRefineTodoItemIds: this.activeRefineTodoItemIds,
					focusTodoId: focusTodo.id,
					focusTodoContent: focusTodo.content,
					planFileCount: planFiles.length,
				},
				promptChecks: {
					hasStep3: agreementPrompt.includes("STEP 3"),
					hasAgreementSchema: agreementPrompt.includes("file_agreements"),
					hasPlanTargets: agreementPrompt.includes("target"),
				},
				promptText: agreementPrompt,
				extra: {
					planFiles: planFiles.map((plan) => ({
						filePath: plan.filePath,
						contentPreview: plan.content.slice(0, 2000),
					})),
				},
			})
			rawResponse = await withTimeout(
				completeStep3AgreementPrompt(this.apiConfiguration, agreementPrompt),
				STEP3_AGREEMENT_PASS_TIMEOUT_MS,
				`STEP 3 agreement pass for "${focusTodo.content}"`,
			)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const failureMessage = formatStep3ApiFailureMessage(message)
			console.error(`[STEP 3] agreement pass API call failed for "${focusTodo.content}":`, error)
			const details: Step3ModelTransferDiagnostic = {
				stage: "api_call",
				todoItemId: focusTodo.id,
				todoContent: focusTodo.content,
				progressLabel: options.progressLabel,
				progress: options.progress,
				provider: this.apiConfiguration?.apiProvider,
				modelId: this.api.getModel().id,
				errorMessage: message,
				errorData: sanitizeStep3DiagnosticData(error),
				promptText: agreementPrompt,
				planFiles: planFiles.map((plan) => ({
					filePath: plan.filePath,
					content: plan.content,
				})),
			}
			await this.say(
				"text",
				formatStep3MessageWithModelTransferDetails(
					`\u26a0\ufe0f STEP 3${progressLabel} error for "${focusTodo.content}": ${failureMessage}`,
					details,
				),
				undefined,
				undefined,
				undefined,
				undefined,
				{ isNonInteractive: true },
			)
			return { executed: true, fileAgreements: [], error: failureMessage }
		}

		let agreementResponse: PostSubtaskAgreementResponse
		try {
			agreementResponse = parsePostSubtaskAgreementResponse(rawResponse)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`[STEP 3] failed to parse agreement response for "${focusTodo.content}":`, error, rawResponse)
			const details: Step3ModelTransferDiagnostic = {
				stage: "parse_response",
				todoItemId: focusTodo.id,
				todoContent: focusTodo.content,
				progressLabel: options.progressLabel,
				progress: options.progress,
				provider: this.apiConfiguration?.apiProvider,
				modelId: this.api.getModel().id,
				errorMessage: message,
				errorData: sanitizeStep3DiagnosticData(error),
				promptText: agreementPrompt,
				rawResponse,
				planFiles: planFiles.map((plan) => ({
					filePath: plan.filePath,
					content: plan.content,
				})),
			}
			await this.say(
				"text",
				formatStep3MessageWithModelTransferDetails(
					`\u26a0\ufe0f STEP 3${progressLabel} parse error for "${focusTodo.content}": ${message}`,
					details,
				),
				undefined,
				undefined,
				undefined,
				undefined,
				{ isNonInteractive: true },
			)
			return { executed: true, fileAgreements: [], error: message }
		}

		const fileAgreements = normalizeFileAgreements(
			agreementResponse.fileAgreements,
			planFiles,
			availableSharedTargets,
		)
		if (fileAgreements.length === 0) {
			return { executed: true, fileAgreements: [] }
		}

		return { executed: true, fileAgreements }
	}

	private async mergeAgreementPassFileAgreements(
		focusTodo: TodoItem,
		fileAgreements: PostSubtaskFileAgreement[],
		options: AgreementPassOptions = {},
	): Promise<PostSubtaskAgreementPassOutcome> {
		const currentTodos = (this.todoList ?? []).map((todo) => ({ ...todo }))
		if (currentTodos.length === 0) {
			return {
				executed: false,
				appendedCount: 0,
				fileAgreementCount: 0,
				skippedReason: "todo list unavailable",
			}
		}
		if (fileAgreements.length === 0) {
			return { executed: true, appendedCount: 0, fileAgreementCount: 0, planAgreements: [] }
		}

		const previousTodos = currentTodos.map((todo) => ({ ...todo }))
		const updatedTodos = currentTodos.map((todo) => ({ ...todo }))
		let appendedCount = 0
		for (const todo of updatedTodos) {
			if (!options.updateAllTodoContexts && todo.id !== focusTodo.id) {
				continue
			}
			const nextContext = mergeStep3FileAgreementsIntoContext(todo.context, fileAgreements)
			if ((todo.context?.trim() ?? "") !== nextContext.trim()) {
				todo.context = nextContext
				appendedCount++
			}
		}

		if (appendedCount > 0) {
			await this.recordStep3TodoContextUpdate(previousTodos, updatedTodos, focusTodo, appendedCount)
		}

		const successParts: string[] = []
		if (appendedCount > 0) {
			successParts.push(
				`appended agreements to ${appendedCount} task context block${appendedCount === 1 ? "" : "s"}`,
			)
		}
		const fileAgreementCount = fileAgreements.reduce((count, entry) => count + entry.agreements.length, 0)
		if (fileAgreementCount > 0) {
			successParts.push(
				`merged ${fileAgreementCount} file-owned agreement${fileAgreementCount === 1 ? "" : "s"} into task context`,
			)
		}

		if (successParts.length === 0) {
			return { executed: true, appendedCount, fileAgreementCount, planAgreementCount: 0, planAgreements: [] }
		} else {
			console.debug(`[STEP 3] ${focusTodo.content}: ${successParts.join(" and ")}`)
		}

		return { executed: true, appendedCount, fileAgreementCount, planAgreementCount: 0, planAgreements: [] }
	}

	private async recordStep3TodoContextUpdate(
		previousTodos: TodoItem[],
		updatedTodos: TodoItem[],
		completedTodo: TodoItem,
		appendedCount: number,
	): Promise<void> {
		await setTodoListForTask(this, updatedTodos)
		await this.upsertUserEditTodos(
			JSON.stringify({
				tool: "updateTodoList",
				todos: updatedTodos,
				previousTodos,
				source: "step3",
				step3: {
					completedTodoItemId: completedTodo.id,
					completedTodoContent: completedTodo.content,
					appendedCount,
				},
			}),
		)
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	private async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const { mcpEnabled } = (await provider.getState()) ?? {}
			if (!(mcpEnabled ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const mcpHub = await McpServerManager.getInstance(provider.context, provider)
			if (!mcpHub) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const servers = mcpHub.getServers()
			return countEnabledMcpTools(servers)
		} catch (error) {
			console.error("[Task#getEnabledMcpToolsCount] Error counting MCP tools:", error)
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}
	}

	/**
	 * Manually start a **new** task when it was created with `startTask: false`.
	 *
	 * This fires `startTask` as a background async operation for the
	 * `task/images` code-path only.  It does **not** handle the
	 * `historyItem` resume path (use the constructor with `startTask: true`
	 * for that).  The primary use-case is in the delegation flow where the
	 * parent's metadata must be persisted to globalState **before** the
	 * child task begins writing its own history (avoiding a read-modify-write
	 * race on globalState).
	 */
	public start(): void {
		if (this._started) {
			return
		}
		this._started = true

		const { task, images } = this.metadata

		if (task || images) {
			this.startTask(task ?? undefined, images ?? undefined)
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		try {
			if (this.enableBridge) {
				try {
					await BridgeOrchestrator.subscribeToTask(this)
				} catch (error) {
					console.error(
						`[Task#startTask] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			// `conversationHistory` (for API) and `clineMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `clineMessages` might not be empty, so we need to set it to [] when
			// we create a new Cline client (otherwise webview would show stale
			// messages from previous session).
			this.clineMessages = []
			this.apiConversationHistory = []

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			await this.say("text", task, images)

			// Check for too many MCP tools and warn the user
			const { enabledToolCount, enabledServerCount } = await this.getEnabledMcpToolsCount()
			if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
				await this.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold: MAX_MCP_TOOLS_THRESHOLD,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			this.isInitialized = true

			// Generate timestamp-based folder name for per-turn persistence
			this.taskTimestamp = generateTaskTimestamp()

			// Create summary folder structure proactively
			try {
				const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
				const summaryDir = path.join(taskDir, "summary", "task", this.taskTimestamp)
				await fs.mkdir(summaryDir, { recursive: true })
				await getTaskOptimizePlanPath(this.globalStoragePath, this.taskId, this.taskTimestamp)
			} catch (err) {
				console.warn("[Task] Failed to create summary directory (non-critical):", err)
			}

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			await this.initiateTaskLoop([
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...imageBlocks,
			]).catch((error) => {
				// Swallow loop rejection when the task was intentionally abandoned/aborted
				// during delegation or user cancellation to prevent unhandled rejections.
				if (this.abandoned === true || this.abortReason === "user_cancelled") {
					return
				}
				throw error
			})
		} catch (error) {
			// In tests and some UX flows, tasks can be aborted while `startTask` is still
			// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	private async resumeTaskFromHistory() {
		if (this.enableBridge) {
			try {
				await BridgeOrchestrator.subscribeToTask(this)
			} catch (error) {
				console.error(
					`[Task#resumeTaskFromHistory] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		const modifiedClineMessages = await this.getSavedClineMessages()

		// Remove any resume messages that may have been added before.
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1]
			if (last.type === "say" && last.say === "reasoning") {
				modifiedClineMessages.pop()
			} else {
				break
			}
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()
		this.subagentResumeReviewPending = await this.hasSubagentResumeState()

		// Restore taskTimestamp from existing turn directories on disk, or generate new one.
		// Turn files and context_refs.json are stored under <taskDir>/task/<timestamp>/,
		// so we must reuse the old timestamp to find them.
		if (!this.taskTimestamp) {
			try {
				const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
				const taskSubDir = path.join(taskDir, "task")
				const entries = await fs.readdir(taskSubDir)
				const timestamps = entries.filter((e) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e)).sort()
				if (timestamps.length > 0) {
					this.taskTimestamp = timestamps[timestamps.length - 1]
					console.log(`[Task.resumeTaskFromHistory] Restored taskTimestamp from disk: ${this.taskTimestamp}`)
				}
			} catch {
				// task/ directory doesn't exist yet — will generate new timestamp below
			}
			if (!this.taskTimestamp) {
				this.taskTimestamp = generateTaskTimestamp()
			}
		}

		// Create summary folder structure proactively and restore contextRefsPath if exists
		try {
			const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			const summaryDir = path.join(taskDir, "summary", "task", this.taskTimestamp)
			await fs.mkdir(summaryDir, { recursive: true })
			await getTaskOptimizePlanPath(this.globalStoragePath, this.taskId, this.taskTimestamp)

			// Restore contextRefsPath from disk (check paths in priority order)
			if (!this.contextRefsPath) {
				const contextDir = path.join(taskDir, "summary", "context", this.taskTimestamp, "context_refs.json")
				const oldSummaryPath = path.join(summaryDir, "context_refs.json")
				const legacyPath = path.join(taskDir, "task", this.taskTimestamp, "context_refs.json")
				for (const candidate of [contextDir, oldSummaryPath, legacyPath]) {
					try {
						await fs.access(candidate)
						this.contextRefsPath = candidate
						break
					} catch {
						// Try next candidate
					}
				}
			}
		} catch (err) {
			console.warn("[Task] Failed to create summary directory (non-critical):", err)
		}

		// Restore refine mode from persisted resume state so that subsequent
		// API calls use the correct system prompt and refine-only tool set.
		// Without this, a resumed task falls back to normal mode (28 tools)
		// even though the conversation history contains refine prompts,
		// causing the model to repeat STEP 1 indefinitely.
		if (!this.isRefineMode) {
			const restored = await this.restoreRefineModeFromResumeState()
			if (restored) {
				console.log(
					`[Task.resumeTaskFromHistory] Restored refine mode: step1Complete=${this.refineStep1Complete}, activeIds=${JSON.stringify(this.activeRefineTodoItemIds)}`,
				)
			}
		}

		// Restore needsContextCompression: if clineMessages show a completed task
		// but no context_refs.json exists, Phase 1 (transition selection) hasn't run yet.
		// This handles the case where the user completed a task, then closed VSCode
		// before the next attemptApiRequest could execute Phase 1.
		if (!this.contextRefsPath) {
			const hasTaskCompleted = this.clineMessages.some(
				(m) => m.say === "task_completed" || m.say === "user_feedback",
			)
			if (hasTaskCompleted) {
				this.needsContextCompression = true
				console.log(
					"[Task.resumeTask] Detected completed task without context_refs — setting needsContextCompression=true",
				)
			}
		}

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

		let responseText: string | undefined
		let responseImages: string[] | undefined

		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

		// Tool blocks are always preserved; native tool calling only.

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					// If attempt_completion was interrupted, perform the same cleanup
					// that would have happened in AttemptCompletionTool.execute
					const hadAttemptCompletion = toolUseBlocks.some((block) => block.name === "attempt_completion")
					if (hadAttemptCompletion) {
						this.todoList = []
						this.taskEstablished = false
						this.needsContextCompression = true
					}

					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: ApiMessage | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						// If attempt_completion was interrupted, perform cleanup
						if (missingToolResponses.length > 0) {
							const hadAttemptCompletion = toolUseBlocks.some(
								(block) => block.name === "attempt_completion",
							)
							if (hadAttemptCompletion) {
								this.todoList = []
								this.taskEstablished = false
								this.needsContextCompression = true
							}
						}

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API.
		// If newUserContent is empty, add a minimal resumption message.
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		// Task resuming from history item.
		await this.initiateTaskLoop(newUserContent)
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 */
	public cancelCurrentRequest(): void {
		if (this.currentRequestAbortController) {
			console.log(`[Task#${this.taskId}.${this.instanceId}] Aborting current HTTP request`)
			this.currentRequestAbortController.abort()
			this.currentRequestAbortController = undefined
		}
	}

	/**
	 * Force emit a final token usage update, ignoring throttle.
	 * Called before task completion or abort to ensure final stats are captured.
	 * Triggers the debounce with current values and immediately flushes to ensure emit.
	 */
	public emitFinalTokenUsageUpdate(): void {
		const tokenUsage = this.getTokenUsage()
		this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)
		this.debouncedEmitTokenUsage.flush()
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true

		// Reset consecutive error counters on abort (manual intervention)
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0

		// Force final token usage update before abort event
		this.emitFinalTokenUsageUpdate()

		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)

		// Cancel any in-progress HTTP request
		try {
			this.cancelCurrentRequest()
		} catch (error) {
			console.error("Error cancelling current request:", error)
		}

		// Remove provider profile change listener
		try {
			if (this.providerProfileChangeListener) {
				const provider = this.providerRef.deref()
				if (provider) {
					provider.off(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
				}
				this.providerProfileChangeListener = undefined
			}
		} catch (error) {
			console.error("Error removing provider profile change listener:", error)
		}

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		if (this.enableBridge) {
			BridgeOrchestrator.getInstance()
				?.unsubscribeFromTask(this.taskId)
				.catch((error) =>
					console.error(
						`[Task#dispose] BridgeOrchestrator#unsubscribeFromTask() failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Cleanup command output artifacts
		getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			.then((taskDir) => {
				const outputDir = path.join(taskDir, "command-output")
				return OutputInterceptor.cleanup(outputDir)
			})
			.catch((error) => {
				console.error("Error cleaning up command output artifacts:", error)
			})

		try {
			this.urlContentFetcher.closeBrowser()
		} catch (error) {
			console.error("Error closing URL content fetcher browser:", error)
		}

		try {
			this.browserSession.closeBrowser()
		} catch (error) {
			console.error("Error closing browser session:", error)
		}
		// Also close the Browser Session panel when the task is disposed
		try {
			const provider = this.providerRef.deref()
			if (provider) {
				const { BrowserSessionPanelManager } = require("../webview/BrowserSessionPanelManager")
				BrowserSessionPanelManager.getInstance(provider).dispose()
			}
		} catch (error) {
			console.error("Error closing browser session panel:", error)
		}

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		const provider = this.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		const child = await (provider as any).delegateParentAndOpenChild({
			parentTaskId: this.taskId,
			message,
			initialTodos,
			mode,
		})
		return child
	}

	/**
	 * Resume parent task after delegation completion without showing resume ask.
	 * Used in metadata-driven subtask flow.
	 *
	 * This method:
	 * - Clears any pending ask states
	 * - Resets abort and streaming flags
	 * - Ensures next API call includes full context
	 * - Immediately continues task loop without user interaction
	 */
	public async resumeAfterDelegation(): Promise<void> {
		// Clear any ask states that might have been set during history load
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined

		// Reset abort and streaming state to ensure clean continuation
		this.abort = false
		this.abandoned = false
		this.abortReason = undefined
		this.didFinishAbortingStream = false
		this.isStreaming = false
		this.isWaitingForFirstChunk = false

		// Ensure next API call includes full context after delegation
		this.skipPrevResponseIdOnce = true

		// Mark as initialized and active
		this.isInitialized = true
		this.emit(RooCodeEventName.TaskActive, this.taskId)

		// Load conversation history if not already loaded
		if (this.apiConversationHistory.length === 0) {
			this.apiConversationHistory = await this.getSavedApiConversationHistory()
		}

		// Add environment details to the existing last user message (which contains the tool_result)
		// This avoids creating a new user message which would cause consecutive user messages
		const environmentDetails = this.isRefineMode ? undefined : await getEnvironmentDetails(this, true)
		let lastUserMsgIndex = -1
		for (let i = this.apiConversationHistory.length - 1; i >= 0; i--) {
			if (this.apiConversationHistory[i].role === "user") {
				lastUserMsgIndex = i
				break
			}
		}
		if (lastUserMsgIndex >= 0 && environmentDetails) {
			const lastUserMsg = this.apiConversationHistory[lastUserMsgIndex]
			if (Array.isArray(lastUserMsg.content)) {
				// Remove any existing environment_details blocks before adding fresh ones
				const contentWithoutEnvDetails = lastUserMsg.content.filter(
					(block: Anthropic.Messages.ContentBlockParam) => {
						if (block.type === "text" && typeof block.text === "string") {
							const isEnvironmentDetailsBlock =
								block.text.trim().startsWith("<environment_details>") &&
								block.text.trim().endsWith("</environment_details>")
							return !isEnvironmentDetailsBlock
						}
						return true
					},
				)
				// Add fresh environment details
				lastUserMsg.content = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			}
		}

		// Save the updated history
		await this.saveApiConversationHistory()

		// Continue task loop - pass empty array to signal no new user content needed
		// The initiateTaskLoop will handle this by skipping user message addition
		await this.initiateTaskLoop([])
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				if (this.subagentsPending) {
					// Main loop exited because subagents are taking over.
					// Launch parallel execution now that the main loop is no longer interfering.
					this.subagentsPending = false
					await this.clearRefineResumeState()
					try {
						await this.runParallelSubagents()
					} catch (err) {
						console.error(`[initiateTaskLoop] runParallelSubagents failed:`, err)
						if (!this.abort) {
							await this.say(
								"error",
								`Parallel subagent execution failed: ${err instanceof Error ? err.message : String(err)}`,
							)
						}
					}
				}
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.abort) {
				throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			// Subagents are about to launch — exit the main loop cleanly
			// so runParallelSubagents() can run without interference.
			if (this.subagentsPending) {
				console.log(
					`[recursivelyMakeClineRequests] subagentsPending=true, exiting main loop for task ${this.taskId}`,
				)
				return true
			}

			if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
				// Track consecutive mistake errors in telemetry via event and PostHog exception tracking.
				// The reason is "no_tools_used" because this limit is reached via initiateTaskLoop
				// which increments consecutiveMistakeCount when the model doesn't use any tools.
				TelemetryService.instance.captureConsecutiveMistakeError(this.taskId)
				TelemetryService.instance.captureException(
					new ConsecutiveMistakeError(
						`Task reached consecutive mistake limit (${this.consecutiveMistakeLimit})`,
						this.taskId,
						this.consecutiveMistakeCount,
						this.consecutiveMistakeLimit,
						"no_tools_used",
						this.apiConfiguration.apiProvider,
						getModelId(this.apiConfiguration),
					),
				)

				const { response, text, images } = await this.ask(
					"mistake_limit_reached",
					t("common:errors.mistake_limit_guidance"),
				)

				if (response === "messageResponse") {
					currentUserContent.push(
						...[
							{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
							...formatResponse.imageBlocks(images),
						],
					)

					await this.say("user_feedback", text, images)
				}

				this.consecutiveMistakeCount = 0
			}

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

			// Determine API protocol based on provider and model
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)

			// Respect user-configured provider rate limiting BEFORE we emit api_req_started.
			// This prevents the UI from showing an "API Request..." spinner while we are
			// intentionally waiting due to the rate limit slider.
			//
			// NOTE: We also set Task.lastGlobalApiRequestTime here to reserve this slot
			// before we build environment details (which can take time).
			// This ensures subsequent requests (including subtasks) still honour the
			// provider rate-limit window.
			await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
			Task.lastGlobalApiRequestTime = performance.now()

			await this.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const {
				showRooIgnoredFiles = false,
				includeDiagnosticMessages = true,
				maxDiagnosticMessages = 50,
			} = (await this.providerRef.deref()?.getState()) ?? {}

			const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
				userContent: currentUserContent,
				cwd: this.cwd,
				urlContentFetcher: this.urlContentFetcher,
				fileContextTracker: this.fileContextTracker,
				rooIgnoreController: this.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
			})

			// Switch mode if specified in a slash command's frontmatter
			if (slashCommandMode) {
				const provider = this.providerRef.deref()
				if (provider) {
					const state = await provider.getState()
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.handleModeSwitch(slashCommandMode)
					}
				}
			}

			const environmentDetails = this.isRefineMode
				? undefined
				: await getEnvironmentDetails(this, currentIncludeFileDetails)

			// Remove any existing environment_details blocks before adding fresh ones.
			// This prevents duplicate environment details when resuming tasks,
			// where the old user message content may already contain environment details from the previous session.
			// We check for both opening and closing tags to ensure we're matching complete environment detail blocks,
			// not just mentions of the tag in regular content.
			const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
				if (block.type === "text" && typeof block.text === "string") {
					// Check if this text block is a complete environment_details block
					// by verifying it starts with the opening tag and ends with the closing tag
					const isEnvironmentDetailsBlock =
						block.text.trim().startsWith("<environment_details>") &&
						block.text.trim().endsWith("</environment_details>")
					return !isEnvironmentDetailsBlock
				}
				return true
			})

			// Add environment details as its own text block, separate from tool
			// results.
			let finalUserContent = environmentDetails
				? [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
				: contentWithoutEnvDetails
			// Only add user message to conversation history if:
			// 1. This is the first attempt (retryAttempt === 0), AND
			// 2. The original userContent was not empty (empty signals delegation resume where
			//    the user message with tool_result and env details is already in history), OR
			// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
			// This prevents consecutive user messages while allowing re-add when needed
			const isEmptyUserContent = currentUserContent.length === 0
			const shouldAddUserMessage =
				((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved

			if (shouldAddUserMessage) {
				await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
				TelemetryService.instance.captureConversationMessage(this.taskId, "user")
			}

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

			this.clineMessages[lastApiReqIndex].text = JSON.stringify({
				apiProtocol,
			} satisfies ClineApiReqInfo)

			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let totalCost: number | undefined

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")

					// Calculate total tokens and cost using provider-aware function
					const modelId = getModelId(this.apiConfiguration)
					const apiProvider = this.apiConfiguration.apiProvider
					const apiProtocol = getApiProtocol(
						apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
						modelId,
					)

					const costResult =
						apiProtocol === "anthropic"
							? calculateApiCostAnthropic(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)
							: calculateApiCostOpenAI(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)

					this.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: costResult.totalInputTokens,
						tokensOut: costResult.totalOutputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						cost: totalCost ?? costResult.totalCost,
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (this.diffViewProvider.isEditing) {
						await this.diffViewProvider.revertChanges() // closes diff view
					}

					// if last message is a partial we need to update and save it
					const lastMessage = this.clineMessages.at(-1)

					if (lastMessage && lastMessage.partial) {
						// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
						lastMessage.partial = false
						// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					}

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await this.saveClineMessages()

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					this.didFinishAbortingStream = true
				}

				// Reset streaming state for each new API request
				this.currentStreamingContentIndex = 0
				this.currentStreamingDidCheckpoint = false
				this.assistantMessageContent = []
				this.didCompleteReadingStream = false
				this.userMessageContent = []
				this.userMessageContentReady = false
				this.didRejectTool = false
				this.didAlreadyUseTool = false
				this.assistantMessageSavedToHistory = false
				// Reset tool failure flag for each new assistant turn - this ensures that tool failures
				// only prevent attempt_completion within the same assistant message, not across turns
				// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
				this.didToolFailInCurrentTurn = false
				this.presentAssistantMessageLocked = false
				this.presentAssistantMessageHasPendingUpdates = false
				// No legacy text-stream tool parser.
				this.streamingToolCallIndices.clear()
				// Clear any leftover streaming tool call state from previous interrupted streams
				NativeToolCallParser.clearAllStreamingToolCalls()
				NativeToolCallParser.clearRawChunkState()

				await this.diffViewProvider.reset()

				// Cache model info once per API request to avoid repeated calls during streaming
				// This is especially important for tools and background usage collection
				this.cachedStreamingModel = this.api.getModel()
				const streamModelInfo = this.cachedStreamingModel.info
				const cachedModelId = this.cachedStreamingModel.id

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
				let assistantMessage = ""
				let reasoningMessage = ""
				let pendingGroundingSources: GroundingSource[] = []
				this.isStreaming = true

				try {
					const iterator = stream[Symbol.asyncIterator]()

					// Helper to race iterator.next() with abort signal
					const nextChunkWithAbort = async () => {
						const nextPromise = iterator.next()

						// If we have an abort controller, race it with the next chunk
						if (this.currentRequestAbortController) {
							const abortPromise = new Promise<never>((_, reject) => {
								const signal = this.currentRequestAbortController!.signal
								if (signal.aborted) {
									reject(new Error("Request cancelled by user"))
								} else {
									signal.addEventListener("abort", () => {
										reject(new Error("Request cancelled by user"))
									})
								}
							})
							return await Promise.race([nextPromise, abortPromise])
						}

						// No abort controller, just return the next chunk normally
						return await nextPromise
					}

					let item = await nextChunkWithAbort()
					while (!item.done) {
						const chunk = item.value
						item = await nextChunkWithAbort()
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							continue
						}

						switch (chunk.type) {
							case "reasoning": {
								reasoningMessage += chunk.text
								// Only apply formatting if the message contains sentence-ending punctuation followed by **
								let formattedReasoning = reasoningMessage
								if (reasoningMessage.includes("**")) {
									// Add line breaks before **Title** patterns that appear after sentence endings
									// This targets section headers like "...end of sentence.**Title Here**"
									// Handles periods, exclamation marks, and question marks
									formattedReasoning = reasoningMessage.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								await this.say("reasoning", formattedReasoning, undefined, true)
								break
							}
							case "usage":
								inputTokens += chunk.inputTokens
								outputTokens += chunk.outputTokens
								cacheWriteTokens += chunk.cacheWriteTokens ?? 0
								cacheReadTokens += chunk.cacheReadTokens ?? 0
								totalCost = chunk.totalCost
								break
							case "grounding":
								// Handle grounding sources separately from regular content
								// to prevent state persistence issues - store them separately
								if (chunk.sources && chunk.sources.length > 0) {
									pendingGroundingSources.push(...chunk.sources)
								}
								break
							case "tool_call_partial": {
								// Process raw tool call chunk through NativeToolCallParser
								// which handles tracking, buffering, and emits events
								const events = NativeToolCallParser.processRawChunk({
									index: chunk.index,
									id: chunk.id,
									name: chunk.name,
									arguments: chunk.arguments,
								})

								for (const event of events) {
									this.handleToolCallEvent(event)
								}
								break
							}

							// Direct handlers for AI SDK tool streaming events (DeepSeek, Moonshot, etc.)
							// These providers emit tool_call_start/delta/end directly instead of tool_call_partial
							case "tool_call_start":
							case "tool_call_delta":
							case "tool_call_end":
								this.handleToolCallEvent(chunk)
								break

							case "tool_call": {
								// Legacy: Handle complete tool calls (for backward compatibility)
								// Convert native tool call to ToolUse format
								const toolUse = NativeToolCallParser.parseToolCall({
									id: chunk.id,
									name: chunk.name as ToolName,
									arguments: chunk.arguments,
								})

								if (!toolUse) {
									console.error(`Failed to parse tool call for task ${this.taskId}:`, chunk)
									break
								}

								// Store the tool call ID on the ToolUse object for later reference
								// This is needed to create tool_result blocks that reference the correct tool_use_id
								toolUse.id = chunk.id

								// Add the tool use to assistant message content
								this.assistantMessageContent.push(toolUse)

								// Mark that we have new content to process
								this.userMessageContentReady = false

								// Present the tool call to user - presentAssistantMessage will execute
								// tools sequentially and accumulate all results in userMessageContent
								presentAssistantMessage(this)
								break
							}
							case "text": {
								assistantMessage += chunk.text

								// Native tool calling: text chunks are plain text.
								// Create or update a text content block directly
								const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
								if (lastBlock?.type === "text" && lastBlock.partial) {
									lastBlock.content = assistantMessage
								} else {
									this.assistantMessageContent.push({
										type: "text",
										content: assistantMessage,
										partial: true,
									})
									this.userMessageContentReady = false
								}
								presentAssistantMessage(this)
								break
							}
						}

						if (this.abort) {
							console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

							if (!this.abandoned) {
								// Only need to gracefully abort if this instance
								// isn't abandoned (sometimes OpenRouter stream
								// hangs, in which case this would affect future
								// instances of Cline).
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (this.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// this.userMessageContentReady = true
							break
						}

						if (this.pendingTodoEdit) {
							assistantMessage += "\n\n[Response interrupted by user todo list edit]"
							break
						}

						if (this.pendingRefineRequest) {
							assistantMessage += "\n\n[Response interrupted by user refine request]"
							break
						}

						if (this.didAlreadyUseTool) {
							assistantMessage +=
								"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
							break
						}
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = performance.now()
						const modelId = getModelId(this.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// Helper function to capture telemetry and update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								// Update the shared variables atomically
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								// Update the API request message with the latest usage data
								updateApiReqMsg()
								await this.saveClineMessages()

								// Update the specific message in the webview
								const apiReqMessage = this.clineMessages[messageIndex]
								if (apiReqMessage) {
									await this.updateClineMessage(apiReqMessage)
								}

								// Capture telemetry with provider-aware cost calculation
								const modelId = getModelId(this.apiConfiguration)
								const apiProvider = this.apiConfiguration.apiProvider
								const apiProtocol = getApiProtocol(
									apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
									modelId,
								)

								// Use the appropriate cost function based on the API protocol
								const costResult =
									apiProtocol === "anthropic"
										? calculateApiCostAnthropic(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)
										: calculateApiCostOpenAI(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)

								TelemetryService.instance.captureLlmCompletion(this.taskId, {
									inputTokens: costResult.totalInputTokens,
									outputTokens: costResult.totalOutputTokens,
									cacheWriteTokens: tokens.cacheWrite,
									cacheReadTokens: tokens.cacheRead,
									cost: tokens.total ?? costResult.totalCost,
								})
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (performance.now() - startTime > timeoutMs) {
									console.warn(
										`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								console.warn(
									`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
							}
						} catch (error) {
							console.error("Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						console.error("Background usage collection failed:", error)
					})
				} catch (error) {
					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to this.abort).
					if (!this.abandoned) {
						// PRIORITY: Check for intentional interrupts BEFORE abortStream.
						// abortStream updates UI with error messages which corrupts state
						// for refine/edit requests that are not actual errors.
						if (this.pendingRefineRequest) {
							// Stream was intentionally aborted for a refine request.
							// Consume it here and push refine prompt onto the stack.
							const refineRequest = this.pendingRefineRequest
							this.pendingRefineRequest = null
							console.log(
								`[Task#${this.taskId}.${this.instanceId}] Stream aborted for refine request, injecting refine prompt`,
							)

							const allTodos = this.todoList ?? []
							// Emit a refine divider so exploration messages are grouped
							// below the entire old todo list, not under the first old item.
							const refinePrompt = await this.prepareRefinePromptForRequest(
								allTodos,
								refineRequest.todoItemIds,
							)
							if (refinePrompt) {
								stack.push({
									userContent: [{ type: "text", text: refinePrompt }],
									includeFileDetails: false,
								})
							}
							continue
						} else if (this.pendingTodoEdit) {
							// Stream was intentionally aborted for a todo edit.
							// Consume it here and push the diff onto the stack.
							const { oldTodos, newTodos } = this.pendingTodoEdit
							this.pendingTodoEdit = null
							console.log(
								`[Task#${this.taskId}.${this.instanceId}] Stream aborted for todo edit, injecting diff`,
							)

							const formatTodoList = (todos: TodoItem[]) =>
								todos.length === 0
									? "(empty)"
									: todos
											.map((t) => {
												const mark =
													t.status === "completed"
														? "x"
														: t.status === "in_progress"
															? "-"
															: " "
												return `[${mark}] ${t.content}`
											})
											.join("\n")

							const diffText = [
								"[USER TODO LIST EDIT] The user has manually modified the todo list while you were working.",
								"",
								"Previous todo list:",
								formatTodoList(oldTodos),
								"",
								"Updated todo list (user-edited):",
								formatTodoList(newTodos),
								"",
								"Adjust your plan accordingly.",
							].join("\n")

							stack.push({
								userContent: [{ type: "text", text: diffText }],
								includeFileDetails: false,
							})
							continue
						}

						// Normal error handling path (not a refine/edit interrupt)
						const cancelReason: ClineApiReqCancelReason = this.abort ? "user_cancelled" : "streaming_failed"
						const rawErrorMessage = error.message ?? JSON.stringify(serializeError(error), null, 2)

						const stateForBackoff = await this.providerRef.deref()?.getState()
						const willAutoRetry = !this.abort && stateForBackoff?.autoApprovalEnabled

						const streamingFailedMessage = this.abort
							? undefined
							: willAutoRetry
								? undefined
								: `${t("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

						// Clean up partial state
						await abortStream(cancelReason, streamingFailedMessage)

						if (this.abort) {
							// User cancelled - abort the entire task
							this.abortReason = cancelReason
							await this.abortTask()
						} else {
							// Stream failed - log the error and retry with the same content
							console.error(
								`[Task#${this.taskId}.${this.instanceId}] Stream failed, will retry: ${rawErrorMessage}`,
							)

							// Apply exponential backoff similar to first-chunk errors when auto-resubmit is enabled
							if (stateForBackoff?.autoApprovalEnabled) {
								await this.backoffAndAnnounce(currentItem.retryAttempt ?? 0, error)

								// Check if task was aborted during the backoff
								if (this.abort) {
									console.log(
										`[Task#${this.taskId}.${this.instanceId}] Task aborted during mid-stream retry backoff`,
									)
									this.abortReason = "user_cancelled"
									await this.abortTask()
									break
								}
							}

							// Push the same content back onto the stack to retry
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							})

							continue
						}
					}
				} finally {
					this.isStreaming = false
					// Clean up the abort controller when streaming completes
					this.currentRequestAbortController = undefined
				}

				if (this.pendingRefineRequest) {
					await abortStream("user_cancelled")

					const refineRequest = this.pendingRefineRequest
					this.pendingRefineRequest = null
					console.log(
						`[Task#${this.taskId}.${this.instanceId}] Stream interrupted for refine request, injecting refine prompt`,
					)

					const allTodos = this.todoList ?? []
					// Emit a refine divider so exploration messages are grouped
					// below the entire old todo list, not under the first old item.
					const refinePrompt = await this.prepareRefinePromptForRequest(allTodos, refineRequest.todoItemIds)
					if (refinePrompt) {
						stack.push({
							userContent: [{ type: "text", text: refinePrompt }],
							includeFileDetails: false,
						})
					}
					continue
				}

				if (this.pendingTodoEdit) {
					await abortStream("user_cancelled")

					const { oldTodos, newTodos } = this.pendingTodoEdit
					this.pendingTodoEdit = null
					console.log(
						`[Task#${this.taskId}.${this.instanceId}] Stream interrupted for todo edit, injecting diff`,
					)

					const formatTodoList = (todos: TodoItem[]) =>
						todos.length === 0
							? "(empty)"
							: todos
									.map((t) => {
										const mark =
											t.status === "completed" ? "x" : t.status === "in_progress" ? "-" : " "
										return `[${mark}] ${t.content}`
									})
									.join("\n")

					const diffText = [
						"[USER TODO LIST EDIT] The user has manually modified the todo list while you were working.",
						"",
						"Previous todo list:",
						formatTodoList(oldTodos),
						"",
						"Updated todo list (user-edited):",
						formatTodoList(newTodos),
						"",
						"Adjust your plan accordingly.",
					].join("\n")

					stack.push({
						userContent: [{ type: "text", text: diffText }],
						includeFileDetails: false,
					})
					continue
				}

				// Need to call here in case the stream was aborted.
				if (this.abort || this.abandoned) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				this.didCompleteReadingStream = true

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)

				// Finalize any remaining streaming tool calls that weren't explicitly ended
				// This is critical for MCP tools which need tool_call_end events to be properly
				// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
				const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
				for (const event of finalizeEvents) {
					if (event.type === "tool_call_end") {
						// Finalize the streaming tool call
						const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

						// Get the index for this tool call
						const toolUseIndex = this.streamingToolCallIndices.get(event.id)

						if (finalToolUse) {
							// Store the tool call ID
							;(finalToolUse as any).id = event.id

							// Get the index and replace partial with final
							if (toolUseIndex !== undefined) {
								this.assistantMessageContent[toolUseIndex] = finalToolUse
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the finalized tool call
							presentAssistantMessage(this)
						} else if (toolUseIndex !== undefined) {
							// finalizeStreamingToolCall returned null (malformed JSON or missing args)
							// We still need to mark the tool as non-partial so it gets executed
							// The tool's validation will catch any missing required parameters
							const existingToolUse = this.assistantMessageContent[toolUseIndex]
							if (existingToolUse && existingToolUse.type === "tool_use") {
								existingToolUse.partial = false
								// Ensure it has the ID for native protocol
								;(existingToolUse as any).id = event.id
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the tool call - validation will handle missing params
							presentAssistantMessage(this)
						}
					}
				}

				// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
				// Tools finalized above are already presented, so we only want blocks still partial after finalization.
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// this.assistantMessageContent.forEach((e) => (e.partial = false))

				// No legacy streaming parser to finalize.

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it exists
				// We can't use say() here because the reasoning message may not be the last message
				// (other messages like text blocks or tool uses may have been added after it during streaming)
				if (reasoningMessage) {
					const lastReasoningIndex = findLastIndex(
						this.clineMessages,
						(m) => m.type === "say" && m.say === "reasoning",
					)

					if (lastReasoningIndex !== -1 && this.clineMessages[lastReasoningIndex].partial) {
						this.clineMessages[lastReasoningIndex].partial = false
						await this.updateClineMessage(this.clineMessages[lastReasoningIndex])
					}
				}

				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

				// No legacy text-stream tool parser state to reset.

				// CRITICAL: Save assistant message to API history BEFORE executing tools.
				// This ensures tool_result blocks appear AFTER their corresponding tool_use blocks.

				// Check if we have any content to process (text or tool uses)
				const hasTextContent = assistantMessage.length > 0

				const hasToolUses = this.assistantMessageContent.some(
					(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
				)

				if (hasTextContent || hasToolUses) {
					// Reset counter when we get a successful response with content
					this.consecutiveNoAssistantMessagesCount = 0
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
						const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

						await this.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					// Build the assistant message content array
					const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

					// Add text content if present
					if (assistantMessage) {
						assistantContent.push({
							type: "text" as const,
							text: assistantMessage,
						})
					}

					// Add tool_use blocks with their IDs for native protocol
					// This handles both regular ToolUse and McpToolUse types
					// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
					// Duplicate tool_use IDs cause Anthropic API 400 errors:
					// "tool_use ids must be unique"
					const seenToolUseIds = new Set<string>()
					const toolUseBlocks = this.assistantMessageContent.filter(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)
					for (const block of toolUseBlocks) {
						if (block.type === "mcp_tool_use") {
							// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
							// The arguments are the raw tool arguments (matching the simplified schema)
							const mcpBlock = block as import("../../shared/tools").McpToolUse
							if (mcpBlock.id) {
								const sanitizedId = sanitizeToolUseId(mcpBlock.id)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: mcpBlock.name, // Original dynamic name
									input: mcpBlock.arguments, // Direct tool arguments
								})
							}
						} else {
							// Regular ToolUse
							const toolUse = block as import("../../shared/tools").ToolUse
							const toolCallId = toolUse.id
							if (toolCallId) {
								const sanitizedId = sanitizeToolUseId(toolCallId)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								// nativeArgs is already in the correct API format for all tools
								const input = toolUse.nativeArgs || toolUse.params

								// Use originalName (alias) if present for API history consistency.
								// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
								// we want the alias name in the conversation history to match what the model
								// was told the tool was named, preventing confusion in multi-turn conversations.
								const toolNameForHistory = toolUse.originalName ?? toolUse.name

								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: toolNameForHistory,
									input,
								})
							}
						}
					}

					// Save assistant message BEFORE executing tools.
					await this.addToApiConversationHistory(
						{ role: "assistant", content: assistantContent },
						reasoningMessage || undefined,
					)
					this.assistantMessageSavedToHistory = true

					// HIGHEST PRIORITY: Compress thinking/reasoning into summary and replace in history.
					// This runs after every assistant turn that includes plain-text reasoning.
					// The compressed summary becomes part of future API context instead of being stripped.
					// MUST be awaited to prevent race conditions: the next API call could run
					// before compression completes, causing the raw reasoning to be sent/stripped.
					if (reasoningMessage) {
						try {
							await this.compressThinkingInHistory(reasoningMessage)
						} catch (err) {
							console.warn("[Task] compressThinkingInHistory failed (non-critical):", err)
						}
					}

					TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")

					// Per-turn persistence: save I/O and thinking to disk
					this.turnCounter++
					try {
						await this.saveTurnData(assistantMessage, assistantContent, reasoningMessage || undefined)
					} catch (err) {
						console.warn("[Task] Per-turn persistence failed (non-critical):", err)
					}
				}

				// Present any partial blocks that were just completed.
				// Tool calls are typically presented during streaming via tool_call_partial events,
				// but we still present here if any partial blocks remain (e.g., malformed streams).
				// NOTE: This MUST happen AFTER saving the assistant message to API history.
				if (partialBlocks.length > 0) {
					// If there is content to update then it will complete and
					// update `this.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request.
					presentAssistantMessage(this)
				}

				if (hasTextContent || hasToolUses) {
					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (this.currentStreamingContentIndex >= completeBlocks.length) {
					// 	this.userMessageContentReady = true
					// }

					await pWaitFor(() => this.userMessageContentReady)

					// Per-turn persistence: save tool results as separate tools_消息N/output.json
					try {
						const toolResultBlocks = this.userMessageContent.filter(
							(block: any) => block.type === "tool_result",
						)
						if (toolResultBlocks.length > 0) {
							const currentItem =
								this.todoList?.find((t) => t.status === "in_progress") ||
								this.todoList?.find((t) => t.status === "pending")
							await saveToolResultsOutput(
								this.globalStoragePath,
								this.taskId,
								this.taskTimestamp || generateTaskTimestamp(),
								this.turnCounter,
								currentItem?.content,
								toolResultBlocks,
							)
						}
					} catch (err) {
						console.warn("[Task] saveToolResultsOutput failed (non-critical):", err)
					}

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					const didToolUse = this.assistantMessageContent.some(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)

					if (!didToolUse) {
						// Increment consecutive no-tool-use counter
						this.consecutiveNoToolUseCount++

						// Only show error and count toward mistake limit after 2 consecutive failures
						if (this.consecutiveNoToolUseCount >= 2) {
							await this.say("error", "MODEL_NO_TOOLS_USED")
							// Only count toward mistake limit after second consecutive failure
							this.consecutiveMistakeCount++
						}

						// Use the task's locked protocol for consistent behavior
						this.userMessageContent.push({
							type: "text",
							text: formatResponse.noToolsUsed(),
						})
					} else {
						// Reset counter when tools are used successfully
						this.consecutiveNoToolUseCount = 0
					}

					// If user edited the todo list mid-execution, inject a diff message
					if (this.pendingTodoEdit) {
						const { oldTodos, newTodos } = this.pendingTodoEdit
						this.pendingTodoEdit = null

						const formatTodoList = (todos: TodoItem[]) =>
							todos.length === 0
								? "(empty)"
								: todos
										.map((t) => {
											const mark =
												t.status === "completed" ? "x" : t.status === "in_progress" ? "-" : " "
											return `[${mark}] ${t.content}`
										})
										.join("\n")

						const diffText = [
							"[USER TODO LIST EDIT] The user has manually modified the todo list while you were working. Please review the changes and adjust your plan accordingly.",
							"",
							"Previous todo list:",
							formatTodoList(oldTodos),
							"",
							"Updated todo list (user-edited):",
							formatTodoList(newTodos),
							"",
							"Analyze the differences. If items were removed or changed, you may need to roll back or skip related work. If items were added or re-prioritized, adjust your execution plan. Respond with your assessment and continue working on the updated list.",
						].join("\n")

						this.userMessageContent.push({
							type: "text",
							text: diffText,
						})
					}

					// If user requested todo item refinement, inject a prompt asking AI to create plans
					if (this.pendingRefineRequest) {
						const refineRequest = this.pendingRefineRequest
						this.pendingRefineRequest = null

						const allTodos = this.todoList ?? []
						// Emit a refine divider so exploration messages are grouped
						// below the entire old todo list, not under the first old item.
						const refinePrompt = await this.prepareRefinePromptForRequest(
							allTodos,
							refineRequest.todoItemIds,
						)
						if (refinePrompt) {
							this.userMessageContent.push({
								type: "text",
								text: refinePrompt,
							})
						}
					}

					// Push to stack if there's content OR if we're paused waiting for a subtask.
					// When paused, we push an empty item so the loop continues to the pause check.
					if (this.userMessageContent.length > 0 || this.isPaused) {
						stack.push({
							userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))
					}

					continue
				} else {
					// If there's no assistant_responses, that means we got no text
					// or tool_use content blocks from API which we should assume is
					// an error.

					// Increment consecutive no-assistant-messages counter
					this.consecutiveNoAssistantMessagesCount++

					// Only show error and count toward mistake limit after 2 consecutive failures
					// This provides a "grace retry" - first failure retries silently
					if (this.consecutiveNoAssistantMessagesCount >= 2) {
						await this.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
					}

					// IMPORTANT: We already added the user message to
					// apiConversationHistory at line 1876. Since the assistant failed to respond,
					// we need to remove that message before retrying to avoid having two consecutive
					// user messages (which would cause tool_result validation errors).
					let state = await this.providerRef.deref()?.getState()
					if (this.apiConversationHistory.length > 0) {
						const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
						if (lastMessage.role === "user") {
							// Remove the last user message that we added earlier
							this.apiConversationHistory.pop()
						}
					}

					// Check if we should auto-retry or prompt the user
					// Reuse the state variable from above
					if (state?.autoApprovalEnabled) {
						// Auto-retry with backoff - don't persist failure message when retrying
						await this.backoffAndAnnounce(
							currentItem.retryAttempt ?? 0,
							new Error(
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							),
						)

						// Check if task was aborted during the backoff
						if (this.abort) {
							console.log(
								`[Task#${this.taskId}.${this.instanceId}] Task aborted during empty-assistant retry backoff`,
							)
							break
						}

						// Push the same content back onto the stack to retry, incrementing the retry attempt counter
						// Mark that user message was removed so it gets re-added on retry
						stack.push({
							userContent: currentUserContent,
							includeFileDetails: false,
							retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							userMessageWasRemoved: true,
						})

						// Continue to retry the request
						continue
					} else {
						// Prompt the user for retry decision
						const { response } = await this.ask(
							"api_req_failed",
							"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
						)

						if (response === "yesButtonClicked") {
							await this.say("api_req_retried")

							// Push the same content back to retry
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							})

							// Continue to retry the request
							continue
						} else {
							// User declined to retry
							// Re-add the user message we removed.
							await this.addToApiConversationHistory({
								role: "user",
								content: currentUserContent,
							})

							await this.say(
								"error",
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							)

							await this.addToApiConversationHistory({
								role: "assistant",
								content: [{ type: "text", text: "Failure: I did not provide a response." }],
							})
						}
					}
				}

				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// This should never happen since the only thing that can throw an
				// error is the attemptApiRequest, which is wrapped in a try catch
				// that sends an ask where if noButtonClicked, will clear current
				// task and destroy this instance. However to avoid unhandled
				// promise rejection, we will end this loop which will end execution
				// of this instance (see `startTask`).
				return true // Needs to be true so parent loop knows to end task.
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	private async getSystemPrompt(skipBuildSwitch?: boolean): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			browserViewportSize,
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			browserToolEnabled,
			language,
			apiConfiguration,
			enableSubfolderRules,
		} = state ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			// Align browser tool enablement with generateSystemPrompt: require model image support,
			// mode to include the browser group, and the user setting to be enabled.
			const modeConfig = getModeBySlug(mode ?? defaultModeSlug, customModes)
			const modeSupportsBrowser = modeConfig?.groups.some((group) => getGroupName(group) === "browser") ?? false

			// Check if model supports browser capability (images)
			const modelInfo = this.api.getModel().info
			const modelSupportsBrowser = (modelInfo as any)?.supportsImages === true

			const canUseBrowserTool = modelSupportsBrowser && modeSupportsBrowser && (browserToolEnabled ?? true)

			const basePrompt = await SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				canUseBrowserTool,
				mcpHub,
				this.diffStrategy,
				browserViewportSize ?? "900x600",
				mode ?? defaultModeSlug,
				customModePrompts,
				customModes,
				customInstructions,
				experiments,
				language,
				rooIgnoreInstructions,
				{
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					browserToolEnabled: browserToolEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					isStealthModel: modelInfo?.isStealthModel,
					suppressCompletionInstructions: this.isRefineMode,
				},
				undefined, // todoList
				this.api.getModel().id,
				provider.getSkillsManager(),
			)

			const currentTodo =
				this.todoList?.find((t) => t.status === "in_progress") ||
				this.todoList?.find((t) => t.status === "pending")
			if (!currentTodo || skipBuildSwitch) {
				return basePrompt
			}

			let planResult: Awaited<ReturnType<typeof readPlanFiles>> = { plans: [], stubPlans: [], contexts: [] }
			try {
				planResult = await readPlanFiles(
					this.globalStoragePath,
					this.taskId,
					this.taskTimestamp,
					currentTodo.id,
					currentTodo.content,
				)
			} catch (err) {
				console.warn("[Task] Failed to read current todo plan files for build prompt (non-critical):", err)
			}

			return `${basePrompt}\n\n${buildOpencodeBuildSystemPrompt(currentTodo, this.todoList ?? [], planResult.plans)}`
		})()
	}

	private async getRefineBaseSystemPrompt(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}

		const state = await provider.getState()
		const { mode, customModePrompts, customInstructions, language, apiConfiguration, enableSubfolderRules } =
			state ?? {}
		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()
		const refineMode = mode ?? defaultModeSlug
		const modeCustomInstructions = customModePrompts?.[refineMode]?.customInstructions ?? ""
		const modelInfo = this.api.getModel().info
		const projectInstructions = await addCustomInstructions(
			modeCustomInstructions,
			customInstructions || "",
			this.cwd,
			refineMode,
			{
				language: language ?? formatLanguage(vscode.env.language),
				rooIgnoreInstructions,
				settings: {
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					isStealthModel: modelInfo?.isStealthModel,
					suppressCompletionInstructions: true,
				},
			},
		)

		return `You are a refine planning agent preparing isolated execution packages for parallel subagents.

You are not the build/execution agent. You must not implement code changes, edit files, run mutating commands, complete the task, or present final results.

Your purpose in this phase:
- Understand the user's request and the existing codebase using read-only exploration.
- Rewrite the current todo list into architecture-based implementation units.
- Ensure every active or pending todo item can later be executed by exactly one isolated subagent.
- Create task contexts, file-target ownership, and plans that make each subagent self-contained without seeing sibling tasks.

====

REFINE TOOL USE

Use the provider-native tool-calling mechanism. Do not use XML markup.
Use only the tools actually provided in this refine session.

Allowed refine actions:
- Read/search/list project information.
- Ask focused follow-up questions when required.
- Call update_todo_list to rewrite the task list, attach task contexts, and seed exact file targets.
- After STEP 1 succeeds, call write_todo_plan to record implementation plans for the rewritten todo items.

Forbidden refine actions:
- Do not edit, create, delete, or overwrite project files.
- Do not run commands that mutate files, install packages, change configuration, start/stop services, or modify system state.
- Do not call attempt_completion.
- Do not switch modes.
- Do not create execution subtasks manually; parallel subagents are launched automatically after refine planning is complete.

Tool selection rules:
1. First decide what information is missing.
2. Prefer targeted code search/read tools over broad exploration when the likely files or symbols are known.
3. Use broad search/listing only when the relevant subsystem or files are unknown.
4. Do not assume tool results. Base each next step on the returned evidence.
5. When multiple independent read-only lookups are useful, issue them together if the API/tooling supports it.

====

REFINE PATH AND SAFETY RULES

- Project base directory: ${this.cwd.toPosix()}
- All file paths in todos, task contexts, and plans must be relative to the project base directory.
- Respect ignore/protection rules included in the custom instructions section.
- environment_details is automatically generated context, not a direct user request.
- Use environment_details to understand visible files, open tabs, terminals, workspace structure, and project state when relevant.
- Ask the user only when a real requirement, product decision, or unsafe ambiguity cannot be resolved from code/context.
- Do not ask for file paths or facts that can be discovered with available read-only tools.

${getSystemInfoSection(this.cwd)}

${projectInstructions}`
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 *
	 * NOTE: This is intentionally treated as expected behavior and is surfaced via
	 * the `api_req_rate_limit_wait` say type (not an error).
	 */
	private async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const rateLimitSeconds =
			state?.apiConfiguration?.rateLimitSeconds ?? this.apiConfiguration?.rateLimitSeconds ?? 0

		if (rateLimitSeconds <= 0 || !Task.lastGlobalApiRequestTime) {
			return
		}

		const now = performance.now()
		const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
		const rateLimitDelay = Math.ceil(
			Math.min(rateLimitSeconds, Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest) / 1000),
		)

		// Only show the countdown UX on the first attempt. Retry flows have their own delay messaging.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			for (let i = rateLimitDelay; i > 0; i--) {
				// Send structured JSON data for i18n-safe transport
				const delayMessage = JSON.stringify({ seconds: i })
				await this.say("api_req_rate_limit_wait", delayMessage, undefined, true)
				await delay(1000)
			}
			// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
			await this.say("api_req_rate_limit_wait", undefined, undefined, false)
		}
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		const state = await this.providerRef.deref()?.getState()

		const { apiConfiguration, autoApprovalEnabled, requestDelaySeconds, mode } = state ?? {}

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt)
		}

		// Update last request time right before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		//
		// NOTE: When recursivelyMakeClineRequests handles rate limiting, it sets the
		// timestamp earlier to include the environment details build. We still set it
		// here for direct callers (tests) and for the case where we didn't rate-limit
		// in the caller.
		Task.lastGlobalApiRequestTime = performance.now()

		if (this.isRefineMode && !this.refineStep1Complete && this.activeRefineTodoItemIds?.length) {
			this.activeRefineTodoItemIds = null
			await this.persistRefineResumeState([])
		}

		let systemPrompt: string
		if (this.isRefineMode) {
			const currentRefineTodoId = this.activeRefineTodoItemIds?.[0]
			const currentRefineTodo = currentRefineTodoId
				? this.todoList?.find((t) => t.id === currentRefineTodoId)
				: undefined
			systemPrompt =
				(await this.getRefineBaseSystemPrompt()) +
				"\n\n" +
				buildRefineSystemPrompt(this.refineStep1Complete, currentRefineTodo)
		} else {
			systemPrompt = await this.getSystemPrompt()
		}

		// Phase 1: Cross-task transition selection (one-time, when needsContextCompression is set)
		// Skipped when autoCondenseContext is enabled (mutually exclusive with Phase 3)
		console.log(
			`[attemptApiRequest] Phase 1 check: needsContextCompression=${this.needsContextCompression}, autoCondenseContext=${this.autoCondenseContext}, taskTimestamp=${this.taskTimestamp}, contextRefsPath=${this.contextRefsPath}`,
		)
		if (this.needsContextCompression && !this.autoCondenseContext) {
			try {
				await executeTransitionSelection(this)
				console.log(
					`[attemptApiRequest] Phase 1: Transition selection completed, contextRefsPath=${this.contextRefsPath}`,
				)
			} catch (err) {
				console.warn("[attemptApiRequest] Phase 1: Transition selection failed (non-critical):", err)
			}
			// Emit a non-partial condense_context message with backpack+summary detail
			const condenseDetailText = await loadCondenseDetail(this)
			const condenseText =
				condenseDetailText ?? JSON.stringify({ content: "Context Retention: transition selection completed" })
			await this.say("condense_context", condenseText, undefined, undefined, undefined, undefined, {
				isNonInteractive: true,
			})
			this.needsContextCompression = false
		} else if (this.needsContextCompression && this.autoCondenseContext) {
			// In auto-condense mode, still run context selection (read-only, no history replacement)
			// so we can display context info in the UI and enable Phase 2 injection
			try {
				const count = await performContextSelection(this)
				console.log(
					`[attemptApiRequest] Phase 1 (auto-condense): Context selection completed, ${count} blocks selected`,
				)
			} catch (err) {
				console.warn(
					"[attemptApiRequest] Phase 1 (auto-condense): Context selection failed (non-critical):",
					err,
				)
			}
			// Emit condense_context message with whatever detail is available
			const condenseDetailText = await loadCondenseDetail(this)
			if (condenseDetailText) {
				await this.say("condense_context", condenseDetailText, undefined, undefined, undefined, undefined, {
					isNonInteractive: true,
				})
			}
			this.needsContextCompression = false
		}

		// Phase 2: Dynamic context block injection (every API call)
		try {
			await injectContextBlocks(this)
		} catch (err) {
			console.warn("[attemptApiRequest] Phase 2: Context block injection failed (non-critical):", err)
		}

		// Phase 3: Auto-condense — backpack filling + summary compression (when autoCondenseContext is enabled)
		try {
			const compressed = await compressInTaskContext(this)
			if (compressed) {
				console.log("[attemptApiRequest] Phase 3: Auto-condense (backpack+summary) compression applied")
			}
		} catch (err) {
			console.warn("[attemptApiRequest] Phase 3: Auto-condense compression failed (non-critical):", err)
		}

		// Full history pipeline: apply context stripping, merge consecutive same-role messages, then clean for API submission.
		const effectiveHistory = await this.buildEffectiveHistory()
		const effectiveHistoryWithRefineMarker = await this.buildHistoryWithRefineContextMarker(effectiveHistory)
		const effectiveHistoryWithResumeMarkers = await this.buildHistoryWithSubagentContextMarker(
			effectiveHistoryWithRefineMarker,
		)
		const requestHistory = this.isRefineMode
			? this.buildRefineSafeHistory(effectiveHistoryWithResumeMarkers)
			: effectiveHistoryWithResumeMarkers
		const mergedMessages = mergeConsecutiveApiMessages(requestHistory)
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedMessages, this.api)
		const cleanConversationHistory = this.buildCleanConversationHistory(messagesWithoutImages as ApiMessage[])

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Whether we include tools is determined by whether we have any tools to send.
		const modelInfo = this.api.getModel().info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined

		const hasRefineResumeState = await this.hasRefineResumeState()
		const hasCompletedRefineStep1ResumeState = await this.hasCompletedRefineStep1ResumeState()
		const hasSubagentResumeState = !this.isRefineMode && (await this.shouldReviewSubagentResumeState())

		if (this.isRefineMode) {
			const { getRefineOnlyTools } = await import("../prompts/tools/native-tools")
			allTools = getRefineOnlyTools({ supportsImages: (modelInfo as any)?.supportsImages === true })
			if (!this.refineStep1Complete) {
				allTools = allTools.filter((tool) => !("function" in tool) || tool.function.name !== "write_todo_plan")
			}
			const refineToolNames = allTools.map((t) => ("function" in t ? t.function.name : "unknown")).join(", ")
			console.log(
				`[build-tools DEBUG] Refine tools (${allTools.length}): ${refineToolNames}, step1Complete=${this.refineStep1Complete}, activeRefineTodoItemIds=${JSON.stringify(this.activeRefineTodoItemIds)}`,
			)
		} else {
			// Gemini requires all tool definitions to be present for history compatibility,
			// but uses allowedFunctionNames to restrict which tools can be called.
			// Other providers (Anthropic, OpenAI, etc.) don't support this feature yet,
			// so they continue to receive only the filtered tools for the current mode.
			const supportsAllowedFunctionNames = apiConfiguration?.apiProvider === "gemini"

			{
				const provider = this.providerRef.deref()
				if (!provider) {
					throw new Error("Provider reference lost during tool building")
				}

				const toolsResult = await buildNativeToolsArrayWithRestrictions({
					provider,
					cwd: this.cwd,
					mode,
					customModes: state?.customModes,
					experiments: state?.experiments,
					apiConfiguration,
					browserToolEnabled: state?.browserToolEnabled ?? true,
					disabledTools: state?.disabledTools,
					modelInfo,
					includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
					discoveredTools: this.discoveredTools,
					taskEstablished: this.taskEstablished,
				})
				allTools = toolsResult.tools
				allowedFunctionNames = toolsResult.allowedFunctionNames
			}
			if (hasCompletedRefineStep1ResumeState) {
				const { default: writeTodoPlan } = await import("../prompts/tools/native-tools/write_todo_plan")
				if (!allTools.some((tool) => "function" in tool && tool.function.name === "write_todo_plan")) {
					allTools = [...allTools, writeTodoPlan]
				}
				if (allowedFunctionNames && !allowedFunctionNames.includes("write_todo_plan")) {
					allowedFunctionNames = [...allowedFunctionNames, "write_todo_plan"]
				}
			}
			if (hasSubagentResumeState) {
				const { default: resumeSubagents } = await import("../prompts/tools/native-tools/resume_subagents")
				if (!allTools.some((tool) => "function" in tool && tool.function.name === "resume_subagents")) {
					allTools = [...allTools, resumeSubagents]
				}
				if (allowedFunctionNames && !allowedFunctionNames.includes("resume_subagents")) {
					allowedFunctionNames = [...allowedFunctionNames, "resume_subagents"]
				}
			}
		}

		const shouldIncludeTools = allTools.length > 0

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			behaviorRole: this.isRefineMode ? "refining" : mode,
			taskId: this.taskId,
			suppressPreviousResponseId: this.skipPrevResponseIdOnce,
			// Include tools whenever they are present.
			...(shouldIncludeTools
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						// When mode restricts tools, provide allowedFunctionNames so providers
						// like Gemini can see all tools in history but only call allowed ones
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		// Create an AbortController to allow cancelling the request mid-stream
		this.currentRequestAbortController = new AbortController()
		const abortSignal = this.currentRequestAbortController.signal
		// Reset the flag after using it
		this.skipPrevResponseIdOnce = false

		// Auto-capture full context and auto-show the inspector panel on every API request
		{
			const inspector = ContextInspectorPanel.getInstance()
			inspector.show()
			if (this.isRefineMode) {
				const currentRefineTodoId = this.activeRefineTodoItemIds?.[0]
				const currentRefineTodo = currentRefineTodoId
					? this.todoList?.find((todo) => todo.id === currentRefineTodoId)
					: undefined
				inspector.logRefinePayloadDiagnostic({
					step: getRefinePayloadStep(this.refineStep1Complete),
					stage: "createMessage",
					taskId: this.taskId,
					modelId: this.api.getModel().id,
					provider: this.apiConfiguration?.apiProvider,
					stepState: {
						refineStep1Complete: this.refineStep1Complete,
						activeRefineTodoItemIds: this.activeRefineTodoItemIds,
						currentRefineTodoId,
						currentRefineTodoContent: currentRefineTodo?.content,
						subagentsPending: this.subagentsPending,
						hasRefineResumeState,
						retryAttempt,
					},
					promptChecks: buildRefinePromptDiagnostics(systemPrompt),
					historyChecks: buildRefineHistoryDiagnostics(cleanConversationHistory as ApiMessage[]),
					toolChecks: buildRefineToolDiagnostics(allTools),
					systemPrompt,
					messages: cleanConversationHistory as any[],
					metadata,
				})
			}
			inspector.logCapturedContext({
				systemPrompt,
				messages: cleanConversationHistory as any[],
				metadata,
				modelId: this.api.getModel().id,
				provider: this.apiConfiguration?.apiProvider,
			})
		}

		// Capture turn metadata for per-turn persistence (only modelId/provider, not full context)
		this.lastTurnApiInput = {
			modelId: this.api.getModel().id,
			provider: this.apiConfiguration?.apiProvider,
		}

		// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
		const stream = this.api.createMessage(
			systemPrompt,
			cleanConversationHistory as unknown as Anthropic.Messages.MessageParam[],
			metadata,
		)
		const iterator = stream[Symbol.asyncIterator]()

		// Set up abort handling - when the signal is aborted, clean up the controller reference
		abortSignal.addEventListener("abort", () => {
			console.log(`[Task#${this.taskId}.${this.instanceId}] AbortSignal triggered for current request`)
			this.currentRequestAbortController = undefined
		})

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true

			// Race between the first chunk and the abort signal
			const firstChunkPromise = iterator.next()
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(new Error("Request cancelled by user"))
				} else {
					abortSignal.addEventListener("abort", () => {
						reject(new Error("Request cancelled by user"))
					})
				}
			})

			const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			this.currentRequestAbortController = undefined

			if (this.abort || this.pendingRefineRequest || this.pendingTodoEdit) {
				throw error
			}

			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled) {
				// Apply shared exponential backoff and countdown UX
				await this.backoffAndAnnounce(retryAttempt, error)

				// CRITICAL: Check if task was aborted during the backoff countdown
				// This prevents infinite loops when users cancel during auto-retry
				// Without this check, the recursive call below would continue even after abort
				if (this.abort) {
					throw new Error(
						`[Task#attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted during retry`,
					)
				}

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const { response } = await this.ask(
					"api_req_failed",
					error.message ?? JSON.stringify(serializeError(error), null, 2),
				)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest()
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		yield* iterator
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	private async backoffAndAnnounce(retryAttempt: number, error: any): Promise<void> {
		try {
			const state = await this.providerRef.deref()?.getState()
			const baseDelay = state?.requestDelaySeconds || 5

			let exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)

			// Respect provider rate limit window
			let rateLimitDelay = 0
			const rateLimit = (state?.apiConfiguration ?? this.apiConfiguration)?.rateLimitSeconds || 0
			if (Task.lastGlobalApiRequestTime && rateLimit > 0) {
				const elapsed = performance.now() - Task.lastGlobalApiRequestTime
				rateLimitDelay = Math.ceil(Math.min(rateLimit, Math.max(0, rateLimit * 1000 - elapsed) / 1000))
			}

			// Prefer RetryInfo on 429 if present
			if (error?.status === 429) {
				const retryInfo = error?.errorDetails?.find(
					(d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
				)
				const match = retryInfo?.retryDelay?.match?.(/^(\d+)s$/)
				if (match) {
					exponentialDelay = Number(match[1]) + 1
				}
			}

			const finalDelay = Math.max(exponentialDelay, rateLimitDelay)
			if (finalDelay <= 0) {
				return
			}

			// Build header text; fall back to error message if none provided
			let headerText
			if (error.status) {
				// Include both status code (for ChatRow parsing) and detailed message (for error details)
				// Format: "<status>\n<message>" allows ChatRow to extract status via parseInt(text.substring(0,3))
				// while preserving the full error message in errorDetails for debugging
				const errorMessage = error?.message || "Unknown error"
				headerText = `${error.status}\n${errorMessage}`
			} else if (error?.message) {
				headerText = error.message
			} else {
				headerText = "Unknown error"
			}

			headerText = headerText ? `${headerText}\n` : ""

			// Show countdown timer with exponential backoff
			for (let i = finalDelay; i > 0; i--) {
				// Check abort flag during countdown to allow early exit
				if (this.abort) {
					throw new Error(`[Task#${this.taskId}] Aborted during retry countdown`)
				}

				await this.say("api_req_retry_delayed", `${headerText}<retry_timer>${i}</retry_timer>`, undefined, true)
				await delay(1000)
			}

			await this.say("api_req_retry_delayed", headerText, undefined, false)
		} catch (err) {
			console.error("Exponential backoff failed:", err)
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	private buildCleanConversationHistory(
		messages: ApiMessage[],
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []

		for (const msg of messages) {
			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (msg.encrypted_content) {
					cleanConversationHistory.push({
						type: "reasoning",
						summary: msg.summary,
						encrypted_content: msg.encrypted_content!,
						...(msg.id ? { id: msg.id } : {}),
					})
				}
				continue
			}

			// Preferred path: assistant message with embedded reasoning as first content block
			if (msg.role === "assistant") {
				const rawContent = msg.content

				const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
					? (rawContent as Anthropic.Messages.ContentBlockParam[])
					: rawContent !== undefined
						? ([
								{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
							] as Anthropic.Messages.ContentBlockParam[])
						: []

				const [first, ...rest] = contentArray

				// Check if this message has reasoning_details (OpenRouter format for Gemini 3, etc.)
				const msgWithDetails = msg
				if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
					// Build the assistant message with reasoning_details
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (contentArray.length === 0) {
						assistantContent = ""
					} else if (contentArray.length === 1 && contentArray[0].type === "text") {
						assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = contentArray
					}

					// Create message with reasoning_details property
					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted (send) or plain text (skip)
				const hasEncryptedReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).encrypted_content === "string"
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					const reasoningBlock = first as any

					// Send as separate reasoning item (OpenAI Native)
					cleanConversationHistory.push({
						type: "reasoning",
						summary: reasoningBlock.summary ?? [],
						encrypted_content: reasoningBlock.encrypted_content,
						...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
					})

					// Send assistant message without reasoning
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					// NOTE: After compressThinkingInHistory runs, the reasoning block is removed.
					// So this branch only triggers for UN-compressed reasoning (e.g. if compression
					// hasn't run yet, or for Anthropic thinking/encrypted blocks handled above).

					// Preserve raw plain-text reasoning blocks for:
					// - models explicitly opting in via preserveReasoning
					// - AI SDK providers (provider packages decide what to include in the native request)
					const shouldPreserveForApi =
						this.api.getModel().info.preserveReasoning === true || this.api.isAiSdkProvider()

					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (shouldPreserveForApi) {
						assistantContent = contentArray
					} else {
						// Strip raw (uncompressed) reasoning out - stored for history only, not sent back to API
						if (rest.length === 0) {
							assistantContent = ""
						} else if (rest.length === 1 && rest[0].type === "text") {
							assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
						} else {
							assistantContent = rest
						}
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
				})
			}
		}

		return cleanConversationHistory
	}

	private buildRefineSafeHistory(messages: ApiMessage[]): ApiMessage[] {
		const filteredToolUseIds = new Set<string>()
		const sanitizedMessages: ApiMessage[] = []

		for (const msg of messages) {
			if ((msg as any).type === "reasoning") {
				continue
			}

			if (!msg.role) {
				continue
			}

			if (typeof msg.content === "string") {
				const sanitizedText = this.sanitizeRefineTextBlock(msg.content)
				if (!sanitizedText) {
					continue
				}
				sanitizedMessages.push({
					...msg,
					content: sanitizedText,
				} as ApiMessage)
				continue
			}

			if (!Array.isArray(msg.content)) {
				sanitizedMessages.push(msg)
				continue
			}

			const sanitizedContent = msg.content.flatMap((block: any) => {
				if (block?.type === "text" && typeof block.text === "string") {
					const sanitizedText = this.sanitizeRefineTextBlock(block.text)
					return sanitizedText ? [{ ...block, text: sanitizedText }] : []
				}

				if (block?.type === "tool_use" || block?.type === "mcp_tool_use") {
					if (!REFINE_HISTORY_ALLOWED_TOOL_NAMES.has(block.name)) {
						if (typeof block.id === "string") {
							filteredToolUseIds.add(block.id)
						}
						return []
					}
					if (
						!this.refineStep1Complete &&
						block.name === "update_todo_list" &&
						(!block.input ||
							typeof block.input !== "object" ||
							!("item_plan_targets" in (block.input as Record<string, unknown>)))
					) {
						if (typeof block.id === "string") {
							filteredToolUseIds.add(block.id)
						}
						return []
					}
				}

				if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
					if (filteredToolUseIds.has(block.tool_use_id)) {
						return []
					}
				}

				return [block]
			})

			if (sanitizedContent.length === 0) {
				continue
			}

			sanitizedMessages.push({
				...msg,
				content: sanitizedContent,
			} as ApiMessage)
		}

		return sanitizedMessages
	}

	private sanitizeRefineTextBlock(text: string): string | undefined {
		const trimmed = text.trim()
		if (!trimmed) {
			return undefined
		}

		if (trimmed.startsWith("<environment_details>") && trimmed.endsWith("</environment_details>")) {
			return undefined
		}

		if (trimmed.startsWith("[IMPLEMENTATION PLAN for")) {
			return undefined
		}

		if (trimmed.startsWith("[USER TODO LIST EDIT]")) {
			return undefined
		}

		const postRefineExecutionIndex = text.indexOf("=== POST-REFINE EXECUTION ===")
		const sanitized = postRefineExecutionIndex >= 0 ? text.slice(0, postRefineExecutionIndex).trimEnd() : text

		return sanitized.trim() ? sanitized : undefined
	}
	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Provides convenient access to high-level message operations.
	 * Uses lazy initialization - the MessageManager is only created when first accessed.
	 * Subsequent accesses return the same cached instance.
	 *
	 * ## Important: Single Coordination Point
	 *
	 * **All MessageManager operations must go through this getter** rather than
	 * instantiating `new MessageManager(task)` directly. This ensures:
	 * - A single shared instance for consistent behavior
	 * - Centralized coordination of all rewind/message operations
	 * - Ability to add internal state or instrumentation in the future
	 *
	 * @example
	 * ```typescript
	 * // Correct: Use the getter
	 * await task.messageManager.rewindToTimestamp(ts)
	 *
	 * // Incorrect: Do NOT create new instances directly
	 * // const manager = new MessageManager(task) // Don't do this!
	 * ```
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/**
	 * Broadcast browser session updates to the browser panel (if open)
	 */
	private broadcastBrowserSessionUpdate(): void {
		const provider = this.providerRef.deref()
		if (!provider) {
			return
		}

		try {
			const { BrowserSessionPanelManager } = require("../webview/BrowserSessionPanelManager")
			const panelManager = BrowserSessionPanelManager.getInstance(provider)

			// Get browser session messages
			const browserSessionStartIndex = this.clineMessages.findIndex(
				(m) =>
					m.ask === "browser_action_launch" ||
					(m.say === "browser_session_status" && m.text?.includes("opened")),
			)

			const browserSessionMessages =
				browserSessionStartIndex !== -1 ? this.clineMessages.slice(browserSessionStartIndex) : []

			const isBrowserSessionActive = this.browserSession?.isSessionActive() ?? false

			// Update the panel asynchronously
			panelManager.updateBrowserSession(browserSessionMessages, isBrowserSessionActive).catch((error: Error) => {
				console.error("Failed to broadcast browser session update:", error)
			})
		} catch (error) {
			// Silently fail if panel manager is not available
			console.debug("Browser panel not available for update:", error)
		}
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		try {
			if (!this.messageQueueService.isEmpty()) {
				const queued = this.messageQueueService.dequeueMessage()
				if (queued) {
					setTimeout(() => {
						this.submitUserMessage(queued.text, queued.images).catch((err) =>
							console.error(`[Task] Failed to submit queued message:`, err),
						)
					}, 0)
				}
			}
		} catch (e) {
			console.error(`[Task] Queue processing error:`, e)
		}
	}
}

const REFINE_HISTORY_ALLOWED_TOOL_NAMES = new Set([
	"ask_followup_question",
	"codebase_search_broad",
	"codebase_search_precise",
	"find_by_name",
	"list_files",
	"read_file",
	"read_url_content",
	"search_files",
	"search_web",
	"update_todo_list",
	"view_content_chunk",
	"write_todo_plan",
])

// OpenCode build-switch.txt — verbatim from https://github.com/anomalyco/opencode
// Plan reference pattern from prompt.ts: BUILD_SWITCH + "\n\n" + "A plan file exists at ... You should execute on the plan defined within it"
function buildOpencodeBuildSystemPrompt(currentTodo: TodoItem, todos: TodoItem[], planFiles: PlanFile[]): string {
	const planReference =
		planFiles.length > 0
			? `A refine plan exists for the active todo. You should execute on the plan defined within it.`
			: ""

	return `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>

${planReference}`
}

function buildDetachedSubagentExecutionSystemPrompt(cwd: string): string {
	return `You are a coding subagent responsible for executing one already-assigned task inside a larger workflow.

Your assignment has already been scoped and planned by the parent agent.
You are not the planner, coordinator, or user-facing assistant.
You are the execution agent for this task.
You are a child execution subagent spawned after the parent agent already decomposed and scoped the work.

Operating mode:
- You are in execution mode, not planning mode.
- You have exactly one assigned task in this subagent run.
- Do not orient yourself like a fresh top-level agent. Do not begin by listing workspace directories.
- The user message is the complete task package for this subagent. Treat it as your entire user-provided context.
- If a later request includes current execution state, it is only continuation state for this same assigned task after tool feedback or an API interruption.
- The assigned refined todo item and relevant memories provided to you are the working brief for this run.
- Treat the todo item's context and relevant memories as authoritative coordination guidance prepared to keep parallel subagents aligned.
- Your goal is to complete the assigned coding work correctly, efficiently, and strictly within scope.

Instruction priority:
1. Follow the system prompt.
2. Follow the assigned refined todo item, its context, and relevant memories.
3. Follow the existing codebase's established patterns and conventions.
4. Prefer the smallest correct change set that fully satisfies the assigned work.

Core rules:
- Use only the tools that are actually provided to you in this session.
- Do not switch tasks, split into new tasks, or wait for another task. Finish this one assigned task.
- Avoid rewriting todo lists, plans, coordination notes, or workflow artifacts unless the assigned task explicitly requires it.
- Ask follow-up questions only when the assigned task cannot proceed safely without clarification.
- Do not invent files, APIs, library usage, behavior, or code structure. Read first, then change.
- Read the minimum relevant code needed to remove uncertainty before editing.
- Do not list workspace directories to understand the project. The parent agent already performed task scoping; your assigned refined todo item is your scope.
- If the assigned refined todo item names files, symbols, routes, types, or components, go directly to those targets instead of exploring the project tree.
- If no exact target is named, use one precise file/symbol/content search to locate the change surface, not a directory listing.
- Focus edits on the assigned refined todo item, its context, and relevant memories.
- Do not modify unrelated files even if they appear related.
- Preserve unrelated behavior and existing project architecture unless your assigned task explicitly changes it.
- Treat tool results from this session as authoritative. Do not wait for extra confirmation after successful tool execution.
- If implementation reveals a concrete cross-task agreement or mismatch that other tasks may need to honor, report it in attempt_completion with exact names and full shapes/signatures when relevant. The parent agent will handle STEP 3 task-context updates.
- If the task cannot be completed with the available tools or context, report that in attempt_completion.
- As soon as the assigned work is complete, call attempt_completion with a concise, factual summary.

Execution workflow:
1. Understand the assigned refined todo item, its context, and relevant memories.
2. Go directly to the named targets. Only use targeted read/search when it is necessary to remove uncertainty about the assigned task.
3. Before editing, check whether the todo item context or relevant memories define any conventions or coordination details your changes must preserve.
4. Make the required code changes.
5. Perform lightweight verification when feasible with the available tools.
6. Immediately call attempt_completion when done or when blocked.

Coordination behavior:
- Apply only the conventions and coordination details that materially affect your assigned files and task.
- If todo item context or relevant memories define a convention, follow it even if another local file uses an older pattern, unless the task explicitly requires updating that older pattern.
- If you discover a likely cross-task mismatch but cannot safely fix it within your assigned task scope, do not guess. Keep your changes locally consistent, then report the mismatch clearly in attempt_completion.
- If the codebase already establishes a stable convention, match it exactly rather than introducing a parallel convention.
- Prefer additive compatibility over risky cross-cutting rewrites.

When blocked:
- Do not loop or keep retrying without new information.
- State the exact blocker.
- State what you checked.
- State what additional context, file access, or tool would be required.

attempt_completion must include:
- what was changed or concluded
- which files were modified or inspected
- what verification was performed
- any concrete shared contract, exact identifier, payload/type/route shape, or cross-task mismatch learned during implementation that other tasks may need to honor
- any remaining risks, assumptions, cross-task mismatches, or blockers

Environment:
- Project base directory: ${cwd.toPosix()}
- All file paths must be relative to this directory.
}`
}

// OpenCode plan.txt + experimental plan workflow — merged into ONE system prompt block.
// System prompt is guaranteed present in every API call, unlike user messages which can
// be stripped by buildEffectiveHistory or merged by mergeConsecutiveApiMessages.
// Source: https://github.com/anomalyco/opencode  plan.txt + prompt.ts insertReminders()
function buildRefineSystemPrompt(refineStep1Complete: boolean, currentRefineTodo?: TodoItem): string {
	const workflowState = refineStep1Complete
		? [
				"## Current Refine State",
				"",
				"STEP 1 is already complete. The refined todo list and STEP 1 plan target skeletons have been recorded.",
				"Do NOT call `update_todo_list` again unless the previous update failed or the user explicitly asks to change the refined task breakdown.",
				currentRefineTodo
					? `Next required tool call: \`write_todo_plan\` with todo_item_id "${currentRefineTodo.id}" for "${currentRefineTodo.content}".`
					: "Continue with `write_todo_plan` for the current unfinished refine todo id from the latest tool result.",
			].join("\n")
		: [
				"## Current Refine State",
				"",
				"STEP 1 has not succeeded yet. Your next refine mutation should be exactly one `update_todo_list` call. First extract the required file targets from the previous todo list, task context, and known codebase context; then classify those files into architecture/subsystem groups and encode the classified files in required `item_plan_targets`.",
				"Any earlier `update_todo_list` result that did not include `item_plan_targets` was a pre-refine task-list update, not a successful refine STEP 1. Do not imitate that old call shape.",
				"Do NOT call `write_todo_plan` until `update_todo_list` succeeds and returns the new todo ids.",
			].join("\n")

	return `<system-reminder>
# Refine Planning Reminder

CRITICAL: Refine mode is active. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user
edit requests. You may ONLY observe, analyze, rewrite the todo list, and record
plans with the refine tools. Any project-file modification attempt is a critical
violation. ZERO exceptions.

---

## Immediate Objective

Your current job is to prepare execution packages for automatic parallel subagents.

${workflowState}

Use read-only tools only when needed to identify exact file paths or resolve a real
requirement ambiguity. Ask the user only for product decisions or unsafe ambiguity
that cannot be resolved from the codebase.

Do NOT implement. Do NOT call \`attempt_completion\`. Do NOT create execution
subtasks manually.

---

## STEP 1 — Rewrite Todo List and Seed File Targets

This section applies ONLY before a successful refine STEP 1 \`update_todo_list\`
result exists in the conversation. If STEP 1 is already complete, skip this
section and follow "After STEP 1" below.

Call \`update_todo_list\` exactly once to replace the entire old todo list. STEP 1
is a file-target extraction and classification pass:

1. Extract every file that must be created, modified, or deleted from the previous
   todo list, existing task contexts, conversation requirements, and known codebase
   context.
2. Classify those files by architecture/subsystem ownership, not by feature wording
   and not one todo per file.
3. Convert each file classification group into one concise todo item.
4. Put the exact files for each classification group into that todo item's aligned
   \`item_plan_targets\` inner array.

The classification MUST be visible in the tool arguments: each \`todos\` row names
one architecture/subsystem group, and the same row's \`item_plan_targets\` inner
array lists that group's files.

The \`update_todo_list\` call MUST include:

1. \`todos\`
   - Full replacement markdown checklist.
   - Single-level only, in execution order.
   - Coarse architecture/subsystem implementation groups.
   - Do NOT create one todo per file.
   - Do NOT pack the full file list into todo text.

2. \`item_contexts\`
   - Array aligned 1:1 with \`todos\`.
   - Every active or pending item needs a non-empty entry starting with "## Task Context".
   - Keep it brief: describe the task role, boundaries, and key dependencies.
   - Do NOT write detailed implementation plans here.

3. \`item_plan_targets\`
   - Array aligned 1:1 with \`todos\`.
   - Required output of the file extraction and classification pass.
   - Every active or pending todo item MUST have a non-empty inner array.
   - Each inner array MUST enumerate every exact file that the matching todo item
     needs to create, modify, or delete.
   - Each target must be { "target": "relative/project/path.ext", "action": "CREATE|MODIFY|DELETE" }.
   - Do NOT omit known files.
   - Do NOT duplicate the same file target across unfinished todo items.
   - Do NOT write plan body text here; the system records these as empty STEP 1
         plan target skeletons for STEP 2 to fill.

You MUST complete STEP 1 before STEP 2. Do NOT call \`write_todo_plan\` on the
old todo items. After calling \`update_todo_list\`, stop and wait for the tool
result with the new todo ids. Once that tool result is available, STEP 1 is done;
do not rewrite the todo list again.

---

## STEP 2 — Fill Detailed Plans

After STEP 1 succeeds, use \`write_todo_plan\` for the new todo ids to fill the
seeded file targets with detailed implementation plans. The next tool call after
a successful STEP 1 should be \`write_todo_plan\` for the first unfinished/current
refine todo id. Call \`write_todo_plan\` for exactly one todo item at a time and
wait for the returned sequential refine state before moving on.

STEP 2 does NOT discover, create, rename, split, or reclassify targets. Every
\`write_todo_plan\` \`plans[].target\` for file plans MUST exactly match one remaining
STEP 1 \`item_plan_targets\` file for the current todo item, and \`plans[].action\`
MUST match the STEP 1 action. Treat each STEP 1 file target as the responsibility
boundary: all required modifications, file purpose notes, dependencies, routes,
exports, functions, tests, and Task Context references for that file must stay
inside that file target's \`body\`, never as separate plan entries.

If the current todo has many seeded file targets, you may fill only a coherent
subset of the remaining targets in one \`write_todo_plan\` call; the plan entries
accumulate. Continue the same todo id with additional \`write_todo_plan\` calls
until the tool result reports no remaining missing targets, then move to the next
todo.

## STEP 3 — Agreement Pass And Automatic Execution

After each successful STEP 2 \`write_todo_plan\` call, the system automatically runs
STEP 3 for that refined todo item to mine concrete cross-task agreements and merge
them into other refine contexts or plan sections. You do NOT call a STEP 3 tool.

When all plans are recorded and refine mode exits, parallel subagent execution is
automatically triggered. You do NOT need to call any additional tool. The system
launches one subagent per rewritten todo item concurrently. Each subagent receives
ONLY its assigned todo item, that item's task context, and that item's filled plan
entries; it does not see sibling plans or the full conversation.

After each subagent finishes, the system may also run a dedicated agreement pass
that reviews the completed todo item, its plan, and the subagent's final result.
Concrete cross-task agreements are merged into task contexts under a structured
file-owned agreement section grouped by code-file path. You do NOT call a tool for
this.
</system-reminder>`
}

// User message: shows the full current todo list.
// The workflow instructions are in the system prompt (buildRefineSystemPrompt) so they
// are always visible regardless of message history stripping.
function buildRefinePrompt(fullTodoList: string): string {
	return `[REFINE REQUEST] The user wants you to refine the project plan. Here is the current todo list:

${fullTodoList}

STEP 1: First extract every file that must be created, modified, or deleted from the previous todo list, existing task context, conversation requirements, and known codebase context. Classify those files by architecture/subsystem ownership. Then call \`update_todo_list\` once to rewrite the whole list so each classification group becomes one concise todo item. Include required \`item_contexts\` and required \`item_plan_targets\`; every active or pending todo item must have a non-empty aligned \`item_plan_targets\` inner array enumerating its exact files. Keep todo text concise and do not pack the full file list into the todo text.
STEP 2: After STEP 1 succeeds, do not call \`update_todo_list\` again unless the tool result reported an error or the user explicitly asks to change the refined task breakdown. Use \`write_todo_plan\` sequentially for the new todo ids to fill the seeded file targets with detailed plans.
STEP 3: After each successful STEP 2 plan write, the system automatically runs the agreement pass and merges concrete cross-task agreements into task contexts or plan sections. You do not call a STEP 3 tool. When all plans are recorded, the system automatically launches one subagent per rewritten todo item. Each subagent receives only its assigned todo item, task context, and filled plan entries.

Follow the refine reminder in the system prompt. If no successful refine STEP 1 marker exists yet, identify any missing exact file paths and perform STEP 1. After STEP 1 succeeds, continue with STEP 2 instead of rewriting the todo list again.`
}

const AGREEMENT_OUTPUT_SCHEMA = `Return JSON ONLY. No prose. No markdown fences.

Schema:
{
  "file_agreements": [
    {
      "file_path": "one exact path from Current refined code-file targets",
      "agreements": [
        {
          "text": "one concrete cross-task agreement owned by this refine file",
          "shared_with": [
            "exact path from Available cross-task file targets that consumes or must honor this agreement"
          ]
        }
      ]
    }
  ]
}`

const AGREEMENT_GENERAL_RULES = `General rules:
- Extract ONLY cross-task agreements. A cross-task agreement is a concrete rule, contract, shape, identifier, route, event, storage key, env key, import boundary, ownership boundary, or behavior that at least one other todo item, refined file, or subagent must independently honor.
- Do NOT record file-local implementation details that only affect the owning file.
- Always use the EXACT identifier names and the full required shapes/signatures/values/keys/routes when relevant. Never write vague reminders such as "use the shared interface", "match the backend payload", or "follow the existing contract".
  Bad:  "Use the shared user interface."
  Good: "Use \`UserSummary\` with fields \`{ id: string; email: string; role: \\\"admin\\\" | \\\"member\\\" }\` in both the backend response and the frontend consumer."
- Do NOT restate architecture context, plan prose, generic intent, status summaries, or background.
- Do NOT invent agreements that are not actually committed to in the source material.
- Every agreement must be owned by exactly one refine code file via \`file_path\`.
- If there is nothing concrete worth recording, return {"file_agreements":[]}.`

const AGREEMENT_CATEGORY_INSTRUCTIONS = `The checklist below is a relevance filter for finding cross-task agreements, not a mandatory output scaffold. Use only the categories that actually matter for the source material; ignore the rest. Do NOT force a rigid format like always writing "接口 / 函数 / 重要方法 / 类".

Inspect the source material for concrete shared agreements, expectations, and integration constraints that other todo items or refined files must independently honor when relevant, including:
${renderAgreementChecklistBullets()}`

const AGREEMENT_FILE_BLOCK_INSTRUCTIONS = `File agreement rules:
- Emit "file_agreements" entries only for paths listed under "Current refined code-file targets". Do NOT emit entries for GENERAL sections or any owner path not listed there.
- Group agreements by owning refine code file. Each "file_path" must be an exact current refined target path, and each "agreements" item must belong to that file.
- For each current refined code-file target, inspect its entire plan body and include only concrete cross-task agreements from task context, the plan, and completion details that apply to that file.
- For each current refined code-file target, perform a coverage pass over API interfaces, routes, HTTP methods, request bodies, response bodies, error response shapes, auth/token headers, JWT payload/secret rules, storage keys, env keys, model/database field mappings, and frontend/backend consumer files. Record every concrete cross-task agreement owned by that file; if an agreement is consumed by another available cross-task file target, include that consuming file path in "shared_with".
- For API agreements, distinguish producer files from consumer files: backend route files own "implements/accepts/returns" agreements, while frontend files own "calls/sends/handles/stores" agreements. Always include HTTP method, full route, request body shape, success response shape, error response shape, status code expectations, auth header/token requirements, and consuming/producing refined file paths when they exist.
- Each agreement item must be an object with "text" and "shared_with". Put only exact paths from "Available cross-task file targets" in "shared_with"; use an empty array only when the agreement is cross-task but the consuming file is not listed there.
- Do NOT output markdown headings, example implementations, boilerplate, or long prose. Output agreement objects only.
- If the same agreement affects multiple files, repeat it under each owning file_path so the ownership is explicit.
- Use "file_agreements": [] only when the active todo produced no concrete cross-task agreement worth recording.`

function buildPostSubtaskAgreementPrompt({
	completedTodo,
	planFiles,
	completionResult,
	todos,
	availableTargets,
}: {
	completedTodo: TodoItem
	planFiles: PlanFile[]
	completionResult: string
	todos: TodoItem[]
	availableTargets?: string[]
}): string {
	const todoListText = todos
		.map((todo) => {
			const context = todo.context?.trim() ? `\nContext:\n${todo.context.trim()}` : ""
			const marker = todo.id === completedTodo.id ? " (just completed)" : ""
			return `- [${todo.id}]${marker} ${todo.content}${context}`
		})
		.join("\n\n")

	const planText =
		planFiles.length > 0
			? planFiles.map((plan) => `### ${plan.filePath}\n${plan.content.trim()}`).join("\n\n")
			: "(no plan files)"
	const refinedTargetsText =
		collectCodePlanTargets(planFiles)
			.map((target) => `- ${target}`)
			.join("\n") || "(none)"
	const availableTargetsText =
		(availableTargets?.length ? availableTargets : collectAvailableCodeTargets(todos, planFiles))
			.map((target) => `- ${target}`)
			.join("\n") || "(none)"

	return `You are performing STEP 3 (post-execution agreement pass) in a task workflow.

A subagent just finished implementing ONE todo item. Your only job is to read the listed refined code-file targets, that subagent's plan, and its \`attempt_completion\` result, then extract ONLY cross-task agreements grouped by the owning refine code file.

${AGREEMENT_OUTPUT_SCHEMA}

${AGREEMENT_GENERAL_RULES}
- Anchor every append on something actually implemented, confirmed, or clearly committed to in the plan + completion result.

${AGREEMENT_CATEGORY_INSTRUCTIONS}

${AGREEMENT_FILE_BLOCK_INSTRUCTIONS}

Current refined code-file targets:
${refinedTargetsText}

Available cross-task file targets:
${availableTargetsText}

Just-completed todo:
- id: ${completedTodo.id}
- content: ${completedTodo.content}

Just-completed todo current context:
${completedTodo.context?.trim() || "(empty)"}

Plan for the completed todo:
${planText}

Subagent attempt_completion result:
${completionResult}

Current todo list and contexts:
${todoListText}`
}

function buildPostRefineAgreementPrompt({
	refinedTodo,
	planFiles,
	todos,
	availableTargets,
}: {
	refinedTodo: TodoItem
	planFiles: PlanFile[]
	todos: TodoItem[]
	availableTargets?: string[]
}): string {
	const todoListText = todos
		.map((todo) => {
			const context = todo.context?.trim() ? `\nContext:\n${todo.context.trim()}` : ""
			const marker = todo.id === refinedTodo.id ? " (just refined)" : ""
			return `- [${todo.id}]${marker} ${todo.content}${context}`
		})
		.join("\n\n")

	const planText =
		planFiles.length > 0
			? planFiles.map((plan) => `### ${plan.filePath}\n${plan.content.trim()}`).join("\n\n")
			: "(no plan files)"
	const refinedTargetsText =
		collectCodePlanTargets(planFiles)
			.map((target) => `- ${target}`)
			.join("\n") || "(none)"
	const availableTargetsText =
		(availableTargets?.length ? availableTargets : collectAvailableCodeTargets(todos, planFiles))
			.map((target) => `- ${target}`)
			.join("\n") || "(none)"

	return `You are performing STEP 3 (refine-time agreement pass) in a task workflow.

A plan was just written for ONE todo item via \`write_todo_plan\`. Your only job is to inspect the listed refined code-file targets and that plan, then extract ONLY cross-task agreements grouped by the owning refined code file.


${AGREEMENT_OUTPUT_SCHEMA}

${AGREEMENT_GENERAL_RULES}
- Anchor every append on something actually written in the plan body. If the plan does not yet commit to a concrete shape (e.g. it only says "decide later"), do not invent one.
- Return {"file_agreements":[]} only when the plan contains no concrete cross-task agreement worth recording.

${AGREEMENT_CATEGORY_INSTRUCTIONS}

${AGREEMENT_FILE_BLOCK_INSTRUCTIONS}

Current refined code-file targets:
${refinedTargetsText}

Available cross-task file targets:
${availableTargetsText}

Just-refined todo:
- id: ${refinedTodo.id}
- content: ${refinedTodo.content}

Just-refined todo current context:
${refinedTodo.context?.trim() || "(empty)"}

Plan just written for the refined todo:
${planText}

Current todo list and contexts:
${todoListText}`
}

function parsePostSubtaskAgreementResponse(rawResponse: string): PostSubtaskAgreementResponse {
	const trimmed = rawResponse.trim()
	const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	const candidate =
		fencedMatch?.[1]?.trim() ??
		(() => {
			const start = trimmed.indexOf("{")
			const end = trimmed.lastIndexOf("}")
			return start !== -1 && end !== -1 && end >= start ? trimmed.slice(start, end + 1) : trimmed
		})()

	const parsed = JSON.parse(candidate) as { file_agreements?: unknown }
	const parseAgreementItem = (agreement: unknown): PostSubtaskAgreementItem | undefined => {
		if (typeof agreement === "string") {
			const text = agreement.trim()
			return text ? { text, shared_with: [] } : undefined
		}
		if (!agreement || typeof agreement !== "object") {
			return undefined
		}

		const entry = agreement as { text?: unknown; shared_with?: unknown }
		const text = typeof entry.text === "string" ? entry.text.trim() : ""
		if (!text) {
			return undefined
		}

		const shared_with = Array.isArray(entry.shared_with)
			? entry.shared_with
					.map((target) => (typeof target === "string" ? target.trim() : ""))
					.filter((target) => target.length > 0)
			: typeof entry.shared_with === "string"
				? parseSharedWithTargets(entry.shared_with)
				: []

		return { text, shared_with }
	}
	const rawFileAgreements = Array.isArray(parsed.file_agreements)
		? parsed.file_agreements
				.filter(
					(entry): entry is { file_path?: unknown; agreements?: unknown } =>
						!!entry && typeof entry === "object",
				)
				.map((entry) => ({
					file_path: typeof entry.file_path === "string" ? entry.file_path.trim() : "",
					agreements: Array.isArray(entry.agreements)
						? entry.agreements
								.map(parseAgreementItem)
								.filter((agreement): agreement is PostSubtaskAgreementItem => !!agreement)
						: [],
				}))
				.filter((entry) => entry.file_path.length > 0 && entry.agreements.length > 0)
		: []

	const fileAgreementsByTarget = new Map<string, PostSubtaskAgreementItem[]>()
	for (const entry of rawFileAgreements) {
		const existing = fileAgreementsByTarget.get(entry.file_path) ?? []
		for (const agreement of entry.agreements) {
			mergeAgreementItem(existing, agreement)
		}
		fileAgreementsByTarget.set(entry.file_path, existing)
	}
	const fileAgreements = Array.from(fileAgreementsByTarget.entries()).map(([file_path, agreements]) => ({
		file_path,
		agreements,
	}))

	return {
		fileAgreements,
	}
}
