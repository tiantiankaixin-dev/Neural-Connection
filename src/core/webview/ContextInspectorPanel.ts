import * as vscode from "vscode"
import { getNonce } from "./getNonce"

export interface InspectorLogEntry {
	id: number
	timestamp: string
	direction: "ext→webview" | "webview→ext" | "ext→api" | "api→ext" | "HTTP→OUT" | "HTTP←IN" | "HTTP✗ERR"
	type: string
	summary: string
	data: any
	marker?: "subagent" | "refine"
}

/**
 * A debug panel that displays context data flowing through the extension.
 * Opens in the editor area (right side) to allow real-time inspection of:
 * - Network-level HTTP/HTTPS requests and responses (primary)
 * - Extension → Webview messages
 * - Webview → Extension messages
 * - Extension → API requests (system prompt + conversation history)
 */
export class ContextInspectorPanel {
	private static instance: ContextInspectorPanel | undefined
	private panel: vscode.WebviewPanel | undefined
	private disposables: vscode.Disposable[] = []
	private logEntries: InspectorLogEntry[] = []
	private entryCounter = 0
	private isReady = false
	private enabled = true
	private _captureNextContext = false
	private subagentNetworkRequestIds = new Set<number>()
	private refineNetworkRequestIds = new Set<number>()
	private pendingSubagentNetworkMarkers: Array<{ subagentId?: string; expiresAt: number }> = []
	private pendingRefineNetworkMarkers: Array<{ expiresAt: number }> = []

	private constructor() {}

	public static getInstance(): ContextInspectorPanel {
		if (!ContextInspectorPanel.instance) {
			ContextInspectorPanel.instance = new ContextInspectorPanel()
		}
		return ContextInspectorPanel.instance
	}

	public show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Two)
			return
		}

		this.panel = vscode.window.createWebviewPanel(
			"roo.contextInspector",
			"Context Inspector",
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		)

		this.panel.webview.html = this.getHtmlContent()

		this.panel.webview.onDidReceiveMessage(
			(message: any) => {
				if (message.type === "ready") {
					this.isReady = true
					this.sendAllEntries()
				} else if (message.type === "clear") {
					this.logEntries = []
					this.entryCounter = 0
				} else if (message.type === "toggleEnabled") {
					this.enabled = message.enabled
				} else if (message.type === "captureContext") {
					this._captureNextContext = true
					vscode.window.showInformationMessage("Context capture armed — will capture on next API request.")
				}
			},
			undefined,
			this.disposables,
		)

		this.panel.onDidDispose(
			() => {
				this.panel = undefined
				this.isReady = false
				while (this.disposables.length) {
					this.disposables.pop()?.dispose()
				}
			},
			null,
			this.disposables,
		)
	}

	public toggle(): void {
		if (this.panel) {
			this.panel.dispose()
			this.panel = undefined
		} else {
			this.show()
		}
	}

	public isOpen(): boolean {
		return !!this.panel
	}

	// ── Context capture (system prompt + conversation history) ──

	/**
	 * Returns true if a capture has been requested, then resets the flag.
	 * Called from Task.attemptApiRequest.
	 */
	public shouldCaptureContext(): boolean {
		if (this._captureNextContext) {
			this._captureNextContext = false
			return true
		}
		return false
	}

	/**
	 * Log a captured full context (system prompt + conversation history).
	 */
	public logCapturedContext(data: {
		systemPrompt: string
		messages: any[]
		metadata?: any
		modelId?: string
		provider?: string
	}): void {
		const isSubagent = data.metadata?.behaviorRole === "subagent" || !!data.metadata?.subagentId
		const isRefine = !isSubagent && data.metadata?.behaviorRole === "refining"
		const behaviorRole = data.metadata?.behaviorRole ? ` role=${data.metadata.behaviorRole}` : ""
		const subagent = data.metadata?.subagentId ? ` subagent=${data.metadata.subagentId}` : ""
		if (isSubagent) {
			this.queueSubagentNetworkMarker(data.metadata?.subagentId)
		} else if (isRefine) {
			this.queueRefineNetworkMarker()
		}
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "ext\u2192api",
			type: isSubagent ? "SUBAGENT CONTEXT" : "CAPTURED CONTEXT",
			summary: `[${data.provider ?? "?"}] model=${data.modelId ?? "?"}${behaviorRole}${subagent} msgs=${data.messages?.length ?? 0} sysPromptLen=${data.systemPrompt?.length ?? 0}`,
			data,
			marker: isSubagent ? "subagent" : isRefine ? "refine" : undefined,
		})
		if (this.panel) {
			this.panel.webview.postMessage({ type: "contextCaptured" })
		}
	}

	public logRefinePayloadDiagnostic(data: {
		step: "STEP 1" | "STEP 2" | "STEP 3"
		stage: string
		taskId?: string
		modelId?: string
		provider?: string
		stepState?: any
		promptChecks?: any
		historyChecks?: any
		toolChecks?: any
		systemPrompt?: string
		messages?: any[]
		metadata?: any
		promptText?: string
		extra?: any
	}): void {
		if (!this.enabled) return
		this.queueRefineNetworkMarker()
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "ext→api",
			type: "REFINE PAYLOAD",
			summary: `[${data.provider ?? "?"}] model=${data.modelId ?? "?"} ${data.step} ${data.stage} task=${data.taskId ?? "?"} msgs=${data.messages?.length ?? 0}`,
			data,
			marker: "refine",
		})
	}

	// ── Network-level logging (HTTP/HTTPS interceptor) ──

	/**
	 * Log an outgoing HTTP/HTTPS request (captured at network layer).
	 */
	public logNetworkRequest(entry: {
		requestId: number
		method: string
		url: string
		headers: Record<string, any>
		requestBody: string
		startTime: number
	}): void {
		if (!this.enabled) return
		const isSubagent = this.isSubagentNetworkRequest(entry) || !!this.consumeSubagentNetworkMarker()
		const isRefine = !isSubagent && (this.isRefineNetworkRequest(entry) || !!this.consumeRefineNetworkMarker())
		if (isSubagent) {
			this.subagentNetworkRequestIds.add(entry.requestId)
		} else if (isRefine) {
			this.refineNetworkRequestIds.add(entry.requestId)
		}
		const bodyLen = entry.requestBody?.length ?? 0
		let bodyPreview = ""
		try {
			const parsed = JSON.parse(entry.requestBody)
			if (parsed.messages) {
				bodyPreview = ` messages=${parsed.messages.length}`
			}
			if (parsed.model) {
				bodyPreview += ` model=${parsed.model}`
			}
		} catch {}
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date(entry.startTime).toISOString(),
			direction: "HTTP→OUT",
			type: `${entry.method}`,
			summary: `${entry.url} (body=${bodyLen}${bodyPreview})`,
			data: {
				requestId: entry.requestId,
				method: entry.method,
				url: entry.url,
				headers: entry.headers,
				requestBody: this.safeParseJson(entry.requestBody),
			},
			marker: isSubagent ? "subagent" : isRefine ? "refine" : undefined,
		})
	}

	/**
	 * Log an incoming HTTP/HTTPS response (captured at network layer).
	 */
	public logNetworkResponse(entry: {
		requestId: number
		method: string
		url: string
		statusCode?: number
		responseHeaders?: Record<string, any>
		responseBody?: string
		startTime: number
		endTime?: number
	}): void {
		if (!this.enabled) return
		const isSubagent = this.subagentNetworkRequestIds.has(entry.requestId)
		const isRefine = this.refineNetworkRequestIds.has(entry.requestId)
		this.subagentNetworkRequestIds.delete(entry.requestId)
		this.refineNetworkRequestIds.delete(entry.requestId)
		const duration = entry.endTime ? entry.endTime - entry.startTime : 0
		const bodyLen = entry.responseBody?.length ?? 0
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "HTTP←IN",
			type: `${entry.statusCode ?? "???"}`,
			summary: `${entry.method} ${entry.url} (${duration}ms, body=${bodyLen})`,
			data: {
				requestId: entry.requestId,
				statusCode: entry.statusCode,
				duration: `${duration}ms`,
				url: entry.url,
				responseHeaders: entry.responseHeaders,
				responseBody: this.safeParseJson(entry.responseBody ?? ""),
			},
			marker: isSubagent ? "subagent" : isRefine ? "refine" : undefined,
		})
	}

	/**
	 * Log a network error.
	 */
	public logNetworkError(entry: {
		requestId: number
		method: string
		url: string
		error?: string
		startTime: number
		endTime?: number
	}): void {
		if (!this.enabled) return
		const isSubagent = this.subagentNetworkRequestIds.has(entry.requestId)
		const isRefine = this.refineNetworkRequestIds.has(entry.requestId)
		this.subagentNetworkRequestIds.delete(entry.requestId)
		this.refineNetworkRequestIds.delete(entry.requestId)
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "HTTP✗ERR",
			type: "ERROR",
			summary: `${entry.method} ${entry.url} — ${entry.error ?? "unknown error"}`,
			data: entry,
			marker: isSubagent ? "subagent" : isRefine ? "refine" : undefined,
		})
	}

	// ── Application-level logging ──

	public logExtToWebview(message: any): void {
		if (!this.enabled) return
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "ext→webview",
			type: message?.type ?? "unknown",
			summary: this.summarizeExtMessage(message),
			data: message,
		})
	}

	public logWebviewToExt(message: any): void {
		if (!this.enabled) return
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "webview→ext",
			type: message?.type ?? "unknown",
			summary: this.summarizeWebviewMessage(message),
			data: message,
		})
	}

	public logApiRequest(data: {
		systemPrompt: string
		messages: any[]
		metadata?: any
		modelId?: string
		provider?: string
	}): void {
		if (!this.enabled) return
		const isSubagent = data.metadata?.behaviorRole === "subagent" || !!data.metadata?.subagentId
		const isRefine = !isSubagent && data.metadata?.behaviorRole === "refining"
		const behaviorRole = data.metadata?.behaviorRole ? ` role=${data.metadata.behaviorRole}` : ""
		const subagent = data.metadata?.subagentId ? ` subagent=${data.metadata.subagentId}` : ""
		if (isSubagent) {
			this.queueSubagentNetworkMarker(data.metadata?.subagentId)
		} else if (isRefine) {
			this.queueRefineNetworkMarker()
		}
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "ext→api",
			type: isSubagent ? "subagent.createMessage" : "createMessage",
			summary: `[${data.provider ?? "?"}] model=${data.modelId ?? "?"}${behaviorRole}${subagent} msgs=${data.messages?.length ?? 0} sysPromptLen=${data.systemPrompt?.length ?? 0}`,
			data,
			marker: isSubagent ? "subagent" : isRefine ? "refine" : undefined,
		})
	}

	public logApiResponse(data: { type: string; [key: string]: any }): void {
		if (!this.enabled) return
		this.addEntry({
			id: ++this.entryCounter,
			timestamp: new Date().toISOString(),
			direction: "api→ext",
			type: data.type ?? "chunk",
			summary: this.summarizeApiResponse(data),
			data,
		})
	}

	// ── Internal helpers ──

	private safeParseJson(str: string): any {
		try {
			return JSON.parse(str)
		} catch {
			return str
		}
	}

	private isSubagentNetworkRequest(entry: { headers?: Record<string, any>; requestBody?: string }): boolean {
		const headers = entry.headers ?? {}
		const getHeader = (name: string): string => {
			const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
			return Array.isArray(value) ? value.join(" ") : String(value ?? "")
		}
		const taskHeaders = [getHeader("session_id"), getHeader("x-roo-task-id"), getHeader("trace_id")]
		if (taskHeaders.some((value) => value.includes(":"))) {
			return true
		}
		const requestBody = entry.requestBody ?? ""
		if (requestBody.includes('"behaviorRole":"subagent"') || requestBody.includes('"subagentId"')) {
			return true
		}
		try {
			const parsed = JSON.parse(requestBody)
			const metadata = parsed?.metadata ?? parsed?.extra_body?.metadata ?? parsed?.extraBody?.metadata
			return metadata?.behaviorRole === "subagent" || typeof metadata?.subagentId === "string"
		} catch {
			return false
		}
	}

	private isRefineNetworkRequest(entry: { requestBody?: string }): boolean {
		const requestBody = entry.requestBody ?? ""
		if (requestBody.includes('"behaviorRole":"refining"') || requestBody.includes("Refine Planning Reminder")) {
			return true
		}
		try {
			const parsed = JSON.parse(requestBody)
			const metadata = parsed?.metadata ?? parsed?.extra_body?.metadata ?? parsed?.extraBody?.metadata
			return metadata?.behaviorRole === "refining"
		} catch {
			return false
		}
	}

	private queueSubagentNetworkMarker(subagentId?: string): void {
		const now = Date.now()
		this.pendingSubagentNetworkMarkers = this.pendingSubagentNetworkMarkers.filter(
			(marker) => marker.expiresAt > now,
		)
		this.pendingSubagentNetworkMarkers.push({ subagentId, expiresAt: now + 10_000 })
	}

	private consumeSubagentNetworkMarker(): { subagentId?: string; expiresAt: number } | undefined {
		const now = Date.now()
		this.pendingSubagentNetworkMarkers = this.pendingSubagentNetworkMarkers.filter(
			(marker) => marker.expiresAt > now,
		)
		return this.pendingSubagentNetworkMarkers.shift()
	}

	private queueRefineNetworkMarker(): void {
		const now = Date.now()
		this.pendingRefineNetworkMarkers = this.pendingRefineNetworkMarkers.filter((marker) => marker.expiresAt > now)
		this.pendingRefineNetworkMarkers.push({ expiresAt: now + 10_000 })
	}

	private consumeRefineNetworkMarker(): { expiresAt: number } | undefined {
		const now = Date.now()
		this.pendingRefineNetworkMarkers = this.pendingRefineNetworkMarkers.filter((marker) => marker.expiresAt > now)
		return this.pendingRefineNetworkMarkers.shift()
	}

	private addEntry(entry: InspectorLogEntry): void {
		this.logEntries.push(entry)
		if (this.logEntries.length > 2000) {
			this.logEntries = this.logEntries.slice(-1500)
		}
		if (this.isReady && this.panel) {
			this.panel.webview.postMessage({ type: "addEntry", entry })
		}
	}

	private sendAllEntries(): void {
		if (this.isReady && this.panel) {
			this.panel.webview.postMessage({ type: "allEntries", entries: this.logEntries })
		}
	}

	private summarizeExtMessage(msg: any): string {
		if (!msg) return "(null)"
		switch (msg.type) {
			case "state":
				return `state update (keys: ${msg.state ? Object.keys(msg.state).length : 0})`
			case "action":
				return `action: ${msg.action}`
			case "invoke":
				return `invoke: ${msg.invoke}`
			case "partialMessage":
				return `partial msg (say=${msg.partialMessage?.say}, len=${msg.partialMessage?.text?.length ?? 0})`
			default:
				return msg.type
		}
	}

	private summarizeWebviewMessage(msg: any): string {
		if (!msg) return "(null)"
		switch (msg.type) {
			case "newTask":
				return `newTask (textLen=${msg.text?.length ?? 0})`
			case "askResponse":
				return `askResponse: ${msg.askResponse}`
			case "webviewDidLaunch":
				return "webviewDidLaunch"
			default:
				return msg.type
		}
	}

	private summarizeApiResponse(data: any): string {
		if (!data) return "(null)"
		switch (data.type) {
			case "text":
				return `text (len=${data.text?.length ?? 0})`
			case "usage":
				return `usage (in=${data.inputTokens ?? 0}, out=${data.outputTokens ?? 0})`
			default:
				return data.type
		}
	}

	private getHtmlContent(): string {
		const nonce = getNonce()

		return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<title>Context Inspector</title>
	<style nonce="${nonce}">
		:root {
			--bg: var(--vscode-editor-background, #1e1e1e);
			--fg: var(--vscode-editor-foreground, #cccccc);
			--border: var(--vscode-panel-border, #444);
			--hover: var(--vscode-list-hoverBackground, #2a2d2e);
			--accent: var(--vscode-textLink-foreground, #3794ff);
			--c-http-out: #e06c75;
			--c-http-in: #98c379;
			--c-http-err: #ff5555;
			--c-ext-wv: #4ec9b0;
			--c-wv-ext: #dcdcaa;
			--c-ext-api: #569cd6;
			--c-api-ext: #c586c0;
			--c-subagent: #4ec9b0;
			--c-refine: #dcdcaa;
		}
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
			font-size: 12px;
			color: var(--fg);
			background: var(--bg);
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 10px;
			border-bottom: 1px solid var(--border);
			flex-shrink: 0;
		}
		.toolbar button {
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
			border: none;
			padding: 3px 10px;
			cursor: pointer;
			border-radius: 2px;
			font-size: 11px;
		}
		.toolbar button:hover { opacity: 0.85; }
		.toolbar button.secondary {
			background: var(--vscode-button-secondaryBackground, #3a3d41);
			color: var(--vscode-button-secondaryForeground, #ccc);
		}
		.toolbar .spacer { flex: 1; }
		.toolbar .status { font-size: 11px; opacity: 0.7; }
		.filter-bar {
			display: flex;
			gap: 4px;
			padding: 4px 10px;
			border-bottom: 1px solid var(--border);
			flex-shrink: 0;
			flex-wrap: wrap;
			align-items: center;
		}
		.filter-chip {
			font-size: 10px;
			padding: 2px 8px;
			border: 1px solid var(--border);
			border-radius: 10px;
			cursor: pointer;
			opacity: 0.5;
			user-select: none;
			white-space: nowrap;
		}
		.filter-chip.active { opacity: 1; border-color: var(--accent); }
		.filter-chip[data-dir="HTTP→OUT"]  { color: var(--c-http-out); }
		.filter-chip[data-dir="HTTP←IN"]   { color: var(--c-http-in); }
		.filter-chip[data-dir="HTTP✗ERR"]  { color: var(--c-http-err); }
		.filter-chip[data-dir="ext→webview"] { color: var(--c-ext-wv); }
		.filter-chip[data-dir="webview→ext"] { color: var(--c-wv-ext); }
		.filter-chip[data-dir="ext→api"]     { color: var(--c-ext-api); }
		.filter-chip[data-dir="api→ext"]     { color: var(--c-api-ext); }
		.sep { width: 1px; height: 16px; background: var(--border); flex-shrink: 0; }
		input.search {
			flex: 1;
			min-width: 120px;
			background: var(--vscode-input-background, #3c3c3c);
			color: var(--fg);
			border: 1px solid var(--vscode-input-border, #555);
			padding: 2px 6px;
			font-size: 11px;
			border-radius: 2px;
			outline: none;
		}
		.log-container { flex: 1; overflow-y: auto; overflow-x: hidden; }
		.log-entry {
			display: flex;
			align-items: flex-start;
			gap: 6px;
			padding: 3px 10px;
			border-bottom: 1px solid var(--border);
			cursor: pointer;
			font-size: 11px;
			line-height: 1.5;
		}
		.log-entry:hover { background: var(--hover); }
		.log-entry.expanded { background: var(--hover); }
		.log-entry.subagent {
			border-left: 3px solid var(--c-subagent);
			background: rgba(78,201,176,0.06);
		}
		.log-entry.subagent .msg-type,
		.log-entry.subagent .summary {
			color: var(--c-subagent);
		}
		.log-entry.refine {
			border-left: 3px solid var(--c-refine);
			background: rgba(220,220,170,0.06);
		}
		.log-entry.refine .msg-type,
		.log-entry.refine .summary {
			color: var(--c-refine);
		}
		.log-entry .copy-btn {
			background: transparent; border: 1px solid #555; color: #aaa; font-size: 10px;
			padding: 1px 5px; border-radius: 3px; cursor: pointer; flex-shrink: 0; margin-right: 2px;
		}
		.log-entry .copy-btn:hover { background: #444; color: #fff; }
		.log-entry .seq { color: #888; min-width: 36px; text-align: right; flex-shrink: 0; }
		.log-entry .time { color: #888; min-width: 80px; flex-shrink: 0; }
		.log-entry .badge {
			font-size: 9px;
			padding: 1px 5px;
			border-radius: 3px;
			font-weight: bold;
			min-width: 72px;
			text-align: center;
			flex-shrink: 0;
		}
		.badge.http-out { background: rgba(224,108,117,0.15); color: var(--c-http-out); }
		.badge.http-in  { background: rgba(152,195,121,0.15); color: var(--c-http-in); }
		.badge.http-err { background: rgba(255,85,85,0.15);   color: var(--c-http-err); }
		.badge.ext-wv   { background: rgba(78,201,176,0.15);  color: var(--c-ext-wv); }
		.badge.wv-ext   { background: rgba(220,220,170,0.15); color: var(--c-wv-ext); }
		.badge.ext-api  { background: rgba(86,156,214,0.15);  color: var(--c-ext-api); }
		.badge.api-ext  { background: rgba(197,134,192,0.15); color: var(--c-api-ext); }
		.badge.subagent { background: rgba(78,201,176,0.18); color: var(--c-subagent); }
		.badge.refine { background: rgba(220,220,170,0.18); color: var(--c-refine); }
		.log-entry .msg-type { color: var(--accent); min-width: 60px; flex-shrink: 0; }
		.log-entry .summary { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.detail-pane {
			display: none;
			padding: 6px 10px 6px 50px;
			border-bottom: 1px solid var(--border);
			background: rgba(0,0,0,0.15);
		}
		.detail-pane.visible { display: block; }
		.detail-pane pre {
			white-space: pre-wrap;
			word-break: break-all;
			font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
			font-size: 11px;
			max-height: 500px;
			overflow-y: auto;
			color: var(--fg);
		}
		.scroll-btn {
			position: fixed;
			bottom: 10px;
			right: 20px;
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
			padding: 4px 10px;
			border-radius: 3px;
			cursor: pointer;
			font-size: 11px;
			display: none;
			z-index: 10;
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<strong style="font-size:13px;">Context Inspector (Network)</strong>
		<span class="spacer"></span>
		<span class="status" id="countStatus">0 entries</span>
		<button class="secondary" id="toggleBtn">Pause</button>
		<button class="secondary" id="clearBtn">Clear</button>
		<button class="secondary" id="exportBtn">Export JSON</button>
	</div>
	<div class="filter-bar">
		<div class="filter-chip active" data-dir="HTTP→OUT"  onclick="toggleFilter(this)">HTTP→OUT</div>
		<div class="filter-chip active" data-dir="HTTP←IN"   onclick="toggleFilter(this)">HTTP←IN</div>
		<div class="filter-chip active" data-dir="HTTP✗ERR"  onclick="toggleFilter(this)">HTTP✗ERR</div>
		<div class="sep"></div>
		<div class="filter-chip active" data-dir="ext→api"     onclick="toggleFilter(this)">EXT→API</div>
		<div class="filter-chip active" data-dir="ext→webview" onclick="toggleFilter(this)">EXT→WV</div>
		<div class="filter-chip active" data-dir="webview→ext" onclick="toggleFilter(this)">WV→EXT</div>
		<div class="filter-chip active" data-dir="api→ext"     onclick="toggleFilter(this)">API→EXT</div>
		<input class="search" id="searchInput" placeholder="Filter by URL, type, or content..." />
	</div>
	<div class="log-container" id="logContainer"></div>
	<div class="scroll-btn" id="scrollBtn" onclick="scrollToBottom()">↓ Scroll to bottom</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const logContainer = document.getElementById('logContainer');
		const countStatus  = document.getElementById('countStatus');
		const searchInput  = document.getElementById('searchInput');
		const scrollBtn    = document.getElementById('scrollBtn');

		let entries = [];
		let expandedId = null;
		let autoScroll = true;
		let enabled = true;
		const ALL_DIRS = ['HTTP→OUT','HTTP←IN','HTTP✗ERR','ext→webview','webview→ext','ext→api','api→ext'];
		let activeFilters = new Set(ALL_DIRS);

		function toggleFilter(chip) {
			const dir = chip.getAttribute('data-dir');
			if (activeFilters.has(dir)) { activeFilters.delete(dir); chip.classList.remove('active'); }
			else { activeFilters.add(dir); chip.classList.add('active'); }
			renderAll();
		}

		document.getElementById('toggleBtn').addEventListener('click', function() {
			enabled = !enabled;
			this.textContent = enabled ? 'Pause' : 'Resume';
			vscode.postMessage({ type: 'toggleEnabled', enabled });
		});
		document.getElementById('clearBtn').addEventListener('click', function() {
			entries = []; expandedId = null; logContainer.innerHTML = ''; updateCount();
			vscode.postMessage({ type: 'clear' });
		});
		document.getElementById('exportBtn').addEventListener('click', function() {
			const blob = JSON.stringify(entries, null, 2);
			const el = document.createElement('textarea');
			el.value = blob; document.body.appendChild(el); el.select();
			document.execCommand('copy'); document.body.removeChild(el);
			this.textContent = 'Copied!';
			setTimeout(() => { this.textContent = 'Export JSON'; }, 1500);
		});

		searchInput.addEventListener('input', () => renderAll());

		logContainer.addEventListener('scroll', () => {
			const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 50;
			autoScroll = atBottom;
			scrollBtn.style.display = atBottom ? 'none' : 'block';
		});

		function scrollToBottom() {
			logContainer.scrollTop = logContainer.scrollHeight;
			autoScroll = true; scrollBtn.style.display = 'none';
		}

		function badgeClass(dir) {
			const m = {
				'HTTP→OUT':'http-out', 'HTTP←IN':'http-in', 'HTTP✗ERR':'http-err',
				'ext→webview':'ext-wv', 'webview→ext':'wv-ext',
				'ext→api':'ext-api', 'api→ext':'api-ext'
			};
			return m[dir] || '';
		}

		function markerClass(entry) {
			if (!entry || !entry.marker) return '';
			return ' ' + entry.marker;
		}

		function matchesFilter(entry) {
			if (!activeFilters.has(entry.direction)) return false;
			const q = searchInput.value.toLowerCase();
			if (!q) return true;
			return entry.type.toLowerCase().includes(q) ||
			       entry.summary.toLowerCase().includes(q) ||
			       entry.direction.toLowerCase().includes(q);
		}

		function formatTime(iso) {
			try {
				const d = new Date(iso);
				return d.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})
					+ '.' + String(d.getMilliseconds()).padStart(3,'0');
			} catch { return ''; }
		}

		function truncateJson(data, maxLen) {
			try {
				const s = JSON.stringify(data, null, 2);
				if (s.length > maxLen) return s.slice(0, maxLen) + '\\n... (truncated, total ' + s.length + ' chars)';
				return s;
			} catch { return String(data); }
		}

		function escapeHtml(str) {
			if (typeof str !== 'string') str = String(str);
			return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
		}

		function createEntryEl(entry) {
			const row = document.createElement('div');
			row.className = 'log-entry' + markerClass(entry);
			row.setAttribute('data-id', entry.id);
			const badgeClassName = entry.marker === 'subagent' ? 'subagent' : entry.marker === 'refine' ? 'refine' : badgeClass(entry.direction);
			row.innerHTML =
				'<button class="copy-btn" title="Copy JSON">Copy</button>' +
				'<span class="seq">#' + entry.id + '</span>' +
				'<span class="time">' + formatTime(entry.timestamp) + '</span>' +
				'<span class="badge ' + badgeClassName + '">' + escapeHtml(entry.marker === 'subagent' ? 'SUBAGENT' : entry.marker === 'refine' ? 'REFINE' : entry.direction) + '</span>' +
				'<span class="msg-type">' + escapeHtml(entry.type) + '</span>' +
				'<span class="summary">' + escapeHtml(entry.summary) + '</span>';

			row.querySelector('.copy-btn').addEventListener('click', (e) => {
				e.stopPropagation();
				const text = JSON.stringify(entry.data, null, 2);
				navigator.clipboard.writeText(text).then(() => {
					const btn = e.target;
					btn.textContent = 'Copied!';
					setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
				});
			});

			const detail = document.createElement('div');
			detail.className = 'detail-pane';

			row.addEventListener('click', () => {
				if (expandedId === entry.id) {
					detail.classList.remove('visible'); row.classList.remove('expanded'); expandedId = null;
				} else {
					if (expandedId !== null) {
						const p = document.querySelector('.detail-pane.visible');
						const r = document.querySelector('.log-entry.expanded');
						if (p) p.classList.remove('visible');
						if (r) r.classList.remove('expanded');
					}
					detail.innerHTML = '<pre>' + escapeHtml(truncateJson(entry.data, 80000)) + '</pre>';
					detail.classList.add('visible'); row.classList.add('expanded'); expandedId = entry.id;
				}
			});

			const frag = document.createDocumentFragment();
			frag.appendChild(row);
			frag.appendChild(detail);
			return frag;
		}

		function renderAll() {
			logContainer.innerHTML = ''; expandedId = null;
			const frag = document.createDocumentFragment();
			for (const e of entries) { if (matchesFilter(e)) frag.appendChild(createEntryEl(e)); }
			logContainer.appendChild(frag);
			updateCount();
			if (autoScroll) scrollToBottom();
		}
		function addEntryToDOM(entry) {
			if (!matchesFilter(entry)) return;
			logContainer.appendChild(createEntryEl(entry));
			updateCount();
			if (autoScroll) scrollToBottom();
		}
		function updateCount() {
			const visible = logContainer.querySelectorAll('.log-entry').length;
			countStatus.textContent = visible + ' / ' + entries.length + ' entries';
		}

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.type === 'addEntry') { entries.push(msg.entry); addEntryToDOM(msg.entry); }
			else if (msg.type === 'allEntries') { entries = msg.entries || []; renderAll(); }
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`
	}
}
