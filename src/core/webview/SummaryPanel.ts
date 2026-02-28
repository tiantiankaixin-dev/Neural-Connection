import * as vscode from "vscode"
import { getNonce } from "./getNonce"
import { saveSummaryEntry, loadAllSummaryEntries, loadGlobalSummary } from "../task-persistence/memory-persistence"

export interface SummaryEntry {
	id: string
	timestamp: number
	text: string
	isGlobal: boolean
	isRolling?: boolean
	isThinking?: boolean
	isTaskSummary?: boolean // Generated at task end via segmented compression
	segmentIndex?: number // Which segment this is (1-based), undefined for final combined
	totalSegments?: number // Total number of segments
	modelId?: string
	sourceMessages?: any[] // Original messages that were summarized
	originalLength?: number // Original thinking length before compression
	keyPoints?: string // Key findings from tool results (extracted from thinking_summary)
}

/**
 * A panel that displays context summaries generated during a task.
 * Opens in the editor area (right side) similar to ContextInspectorPanel.
 * Updated in real-time when new summaries are created by the condense system.
 */
export class SummaryPanel {
	private static instance: SummaryPanel | undefined
	private panel: vscode.WebviewPanel | undefined
	private disposables: vscode.Disposable[] = []
	private entries: SummaryEntry[] = []
	private isReady = false
	private activeGlobalStoragePath: string | undefined
	private activeTaskId: string | undefined

	private constructor() {}

	public static getInstance(): SummaryPanel {
		if (!SummaryPanel.instance) {
			SummaryPanel.instance = new SummaryPanel()
		}
		return SummaryPanel.instance
	}

	public show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Two)
			return
		}

		this.panel = vscode.window.createWebviewPanel("roo.summaryPanel", "Summary Inspector", vscode.ViewColumn.Two, {
			enableScripts: true,
			retainContextWhenHidden: true,
		})

		this.panel.webview.html = this.getHtml()

		this.panel.webview.onDidReceiveMessage(
			(message: any) => {
				if (message.type === "ready") {
					this.isReady = true
					this.sendAllEntries()
				} else if (message.type === "clear") {
					this.entries = []
					this.sendAllEntries()
				} else if (message.type === "test") {
					const crypto = require("crypto")
					// Test: Thinking entry WITH key points (split rendering)
					this.addSummary({
						id: crypto.randomUUID(),
						timestamp: Date.now(),
						text: "User wants architecture overview. I've gathered core systems info via codebase_search. Next: search for remaining systems (SaveSystem, UI) to complete the picture.",
						isGlobal: false,
						isThinking: true,
						modelId: "test-model",
						originalLength: 2000,
						keyPoints:
							"codebase_search found: PlayerController handles movement+jump in Update(), GameManager is singleton managing game state, AudioManager uses event-driven pattern via GameEvents.",
					})
					// Test: Regular summary (no key points)
					this.addSummary({
						id: crypto.randomUUID(),
						timestamp: Date.now(),
						text: "This is a test summary entry.\n\nThe project uses a layered architecture with Core, Managers, Player, UI, and World modules.",
						isGlobal: false,
						modelId: "test-model",
					})
					// Test: Global summary
					this.addSummary({
						id: crypto.randomUUID(),
						timestamp: Date.now(),
						text: "## Global Task Summary\nThe conversation covered project architecture analysis and code exploration across 5 modules.",
						isGlobal: true,
						modelId: "test-model",
					})
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

	/**
	 * Set the active task context so addSummary can persist to the correct DB location.
	 * Must be called when a task starts or is resumed.
	 */
	public setActiveTask(globalStoragePath: string, taskId: string): void {
		this.activeGlobalStoragePath = globalStoragePath
		this.activeTaskId = taskId
		console.log("[SummaryPanel] setActiveTask:", taskId)
	}

	/**
	 * Clear the active task context (e.g. when task ends).
	 */
	public clearActiveTask(): void {
		this.activeGlobalStoragePath = undefined
		this.activeTaskId = undefined
	}

	/** Called by the condense system when a new summary is generated.
	 *  DB-centric: saves to disk first, then reloads from disk to display.
	 *  @param entry The summary entry to add.
	 *  @param overrideStorage Optional explicit storage location (used by clearTask fire-and-forget
	 *         which runs after the task is removed from stack). */
	public addSummary(entry: SummaryEntry, overrideStorage?: { globalStoragePath: string; taskId: string }): void {
		const storagePath = overrideStorage?.globalStoragePath ?? this.activeGlobalStoragePath
		const taskId = overrideStorage?.taskId ?? this.activeTaskId

		console.log(
			"[SummaryPanel] addSummary called — id:",
			entry.id,
			"isGlobal:",
			entry.isGlobal,
			"text length:",
			entry.text.length,
			"targetTask:",
			taskId ?? "none",
		)

		// DB-first: persist to disk, then reload from disk
		if (storagePath && taskId) {
			saveSummaryEntry(storagePath, taskId, entry)
				.then(async () => {
					// Only reload UI if this is still the active task
					if (this.activeTaskId === taskId) {
						await this.reloadFromDisk()
					}
				})
				.catch((err) => {
					console.error("[SummaryPanel] Failed to persist entry to disk:", err)
					// Fallback: show in memory if disk save fails
					this.entries.push(entry)
					this.notifyPanel(entry)
				})
		} else {
			console.warn("[SummaryPanel] No storage location available — entry stored in memory only")
			this.entries.push(entry)
			this.notifyPanel(entry)
		}
	}

	/** Reload all entries from disk and refresh the panel */
	private async reloadFromDisk(): Promise<void> {
		if (!this.activeGlobalStoragePath || !this.activeTaskId) return

		try {
			const summaries = await loadAllSummaryEntries(this.activeGlobalStoragePath, this.activeTaskId)
			const globalSummary = await loadGlobalSummary(this.activeGlobalStoragePath, this.activeTaskId)

			this.entries = [...summaries]
			if (globalSummary && !this.entries.some((e) => e.isGlobal && e.id === `global_${this.activeTaskId}`)) {
				this.entries.push({
					id: `global_${this.activeTaskId}`,
					timestamp: globalSummary.timestamp ?? Date.now(),
					text: globalSummary.text,
					isGlobal: true,
				})
			}
		} catch (err) {
			console.warn("[SummaryPanel] reloadFromDisk failed:", err)
		}

		// Auto-open the panel when entries exist
		if (this.entries.length > 0 && !this.panel) {
			this.show()
		}

		if (this.isReady && this.panel) {
			this.sendAllEntries()
		}
	}

	/** Push a single entry to the webview (used as fallback when disk is unavailable) */
	private notifyPanel(entry: SummaryEntry): void {
		if (!this.panel) {
			this.show()
		}
		if (this.isReady && this.panel) {
			this.panel.webview.postMessage({ type: "addEntry", entry })
		}
	}

	/** Update an existing entry by ID (e.g. when thinking compression completes) */
	public updateSummary(id: string, updates: Partial<SummaryEntry>): void {
		const idx = this.entries.findIndex((e) => e.id === id)
		if (idx === -1) return
		this.entries[idx] = { ...this.entries[idx], ...updates }
		if (this.isReady && this.panel) {
			this.panel.webview.postMessage({ type: "updateEntry", id, updates })
		}
	}

	/** Get all summary entries for regression/drill-down */
	public getEntries(): SummaryEntry[] {
		return [...this.entries]
	}

	/** Reset all entries (e.g. when a new task starts) */
	public reset(): void {
		this.entries = []
		if (this.isReady && this.panel) {
			this.panel.webview.postMessage({ type: "reset" })
		}
	}

	/**
	 * Load all persisted summaries and global summary from disk for a given task.
	 * Replaces the current in-memory entries with the loaded data.
	 */
	public async loadFromDisk(globalStoragePath: string, taskId: string): Promise<void> {
		this.entries = []

		try {
			// Load individual summaries
			const summaries = await loadAllSummaryEntries(globalStoragePath, taskId)
			for (const entry of summaries) {
				this.entries.push(entry)
			}

			// Load global summary
			const globalSummary = await loadGlobalSummary(globalStoragePath, taskId)
			if (globalSummary) {
				this.entries.push({
					id: `global_${taskId}`,
					timestamp: globalSummary.timestamp ?? Date.now(),
					text: globalSummary.text,
					isGlobal: true,
				})
			}
		} catch (error) {
			console.warn("[SummaryPanel] Failed to load summaries from disk:", error)
		}

		// Update the panel if it's open
		if (this.isReady && this.panel) {
			this.sendAllEntries()
		}
	}

	private sendAllEntries(): void {
		if (!this.isReady || !this.panel) return
		this.panel.webview.postMessage({ type: "allEntries", entries: this.entries })
	}

	private getHtml(): string {
		const nonce = getNonce()
		return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Summary Inspector</title>
<style nonce="${nonce}">
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-editor-foreground, #cccccc);
	--border: var(--vscode-panel-border, #444);
	--hover: var(--vscode-list-hoverBackground, #2a2d2e);
	--accent: var(--vscode-textLink-foreground, #3794ff);
	--badge-bg: var(--vscode-badge-background, #4d4d4d);
	--badge-fg: var(--vscode-badge-foreground, #fff);
	--btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
	--btn2-fg: var(--vscode-button-secondaryForeground, #ccc);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
	font-size: 13px; color: var(--fg); background: var(--bg);
	height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
.toolbar {
	padding: 10px 16px; border-bottom: 1px solid var(--border);
	display: flex; align-items: center; gap: 10px;
}
.toolbar h2 { font-size: 14px; font-weight: 600; flex: 1; }
.toolbar .badge {
	background: var(--badge-bg); color: var(--badge-fg);
	font-size: 11px; padding: 1px 6px; border-radius: 8px;
}
.toolbar button {
	padding: 4px 10px; font-size: 11px; border: none; border-radius: 3px;
	background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
}
.toolbar button:hover { opacity: 0.85; }
.entries { flex: 1; overflow-y: auto; padding: 8px 0; }
.entry {
	padding: 10px 16px; border-bottom: 1px solid var(--border);
	cursor: pointer;
}
.entry:hover { background: var(--hover); }
.entry-header {
	display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.entry-header .tag {
	font-size: 10px; font-weight: 600; padding: 1px 6px;
	border-radius: 3px; text-transform: uppercase;
}
.tag-summary { background: #2d5a3d; color: #7dcea0; }
.tag-global { background: #5a4b2d; color: #f0c040; }
.tag-rolling { background: #4a3a5a; color: #c7a3f0; }
.tag-thinking { background: #2d4a5a; color: #7dd3fc; }
.tag-keypoints { background: #5a4a2d; color: #fbbf24; }
.keypoints-block {
	border-left: 3px solid #fbbf24; padding: 6px 10px; margin-bottom: 6px;
	background: rgba(251, 191, 36, 0.06); border-radius: 0 4px 4px 0;
	font-size: 12px; line-height: 1.6; white-space: pre-wrap; opacity: 0.9;
}
.thinking-block {
	border-left: 3px solid #7dd3fc; padding: 6px 10px;
	background: rgba(125, 211, 252, 0.06); border-radius: 0 4px 4px 0;
	font-size: 12px; line-height: 1.6; white-space: pre-wrap; opacity: 0.85;
}
.tag-task-summary { background: #2d5a4a; color: #4ade80; }
.tag-task-segment { background: #3a4a2d; color: #a3e635; }
.compression-info {
	font-size: 10px; opacity: 0.6; font-family: var(--vscode-editor-font-family, monospace);
}
.entry-header .time { font-size: 11px; opacity: 0.5; }
.entry-header .model-label {
	font-size: 10px; opacity: 0.4; font-family: var(--vscode-editor-font-family, monospace);
	background: var(--badge-bg); padding: 1px 5px; border-radius: 3px;
}
.entry-actions {
	display: flex; gap: 6px; margin-top: 6px;
}
.entry-actions button {
	padding: 2px 8px; font-size: 10px; border: none; border-radius: 3px;
	background: var(--btn2-bg); color: var(--btn2-fg); cursor: pointer;
	opacity: 0; transition: opacity 0.15s;
}
.entry:hover .entry-actions button { opacity: 1; }
.entry-actions button:hover { opacity: 0.85; background: var(--accent); color: #fff; }
.entry-actions button.copied { background: #2d5a3d; color: #7dcea0; opacity: 1; }
.entry-body {
	font-size: 12px; line-height: 1.6; white-space: pre-wrap;
	max-height: 120px; overflow: hidden; opacity: 0.85;
}
.entry.expanded .entry-body { max-height: none; }
.empty-msg {
	padding: 40px 20px; text-align: center; opacity: 0.4;
	font-size: 13px; line-height: 1.6;
}
/* Modal styles */
.source-modal {
	position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000;
}
.modal-overlay {
	position: absolute; top: 0; left: 0; right: 0; bottom: 0;
	background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center;
	padding: 20px;
}
.modal-content {
	background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
	max-width: 800px; max-height: 80vh; width: 100%; display: flex; flex-direction: column;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-header {
	padding: 16px 20px; border-bottom: 1px solid var(--border);
	display: flex; align-items: center; justify-content: space-between;
}
.modal-header h3 { font-size: 14px; font-weight: 600; margin: 0; }
.modal-close {
	background: none; border: none; color: var(--fg); font-size: 18px;
	cursor: pointer; padding: 0; width: 24px; height: 24px;
	display: flex; align-items: center; justify-content: center; border-radius: 4px;
}
.modal-close:hover { background: var(--hover); }
.modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.source-messages { display: flex; flex-direction: column; gap: 12px; }
.source-message {
	border: 1px solid var(--border); border-radius: 6px; padding: 12px;
	background: rgba(255, 255, 255, 0.02);
}
.msg-header {
	display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
	font-size: 11px;
}
.msg-role {
	padding: 2px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase;
}
.msg-role[class*="user"] { background: #2d4a5a; color: #7dd3fc; }
.msg-role[class*="assistant"] { background: #4a2d5a; color: #c7a3f0; }
.msg-time, .msg-id { opacity: 0.5; }
.msg-content {
	font-size: 12px; line-height: 1.5; white-space: pre-wrap;
	max-height: 200px; overflow-y: auto;
}
.tool-use { color: var(--accent); font-weight: 500; }
.tool-result { color: #7dcea0; font-weight: 500; }
.unknown-block { color: #f0c040; font-weight: 500; }
</style>
</head>
<body>
<div class="toolbar">
	<h2>Summary Inspector</h2>
	<span class="badge" id="countBadge">0</span>
	<button id="testBtn">Test</button>
	<button id="clearBtn">Clear</button>
</div>
<div class="entries" id="entriesEl"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const entriesEl = document.getElementById('entriesEl');
const countBadge = document.getElementById('countBadge');
const clearBtn = document.getElementById('clearBtn');
const testBtn = document.getElementById('testBtn');

let entries = [];

function formatTime(ts) {
	const d = new Date(ts);
	return d.toLocaleTimeString();
}

function renderEntry(entry) {
	const el = document.createElement('div');
	el.className = 'entry';
	let tagClass, tagLabel;
	if (entry.isTaskSummary && entry.segmentIndex) {
		tagClass = 'tag-task-segment';
		tagLabel = 'Segment ' + entry.segmentIndex + '/' + (entry.totalSegments || '?');
	} else if (entry.isTaskSummary) {
		tagClass = 'tag-task-summary';
		tagLabel = 'Task Summary';
	} else if (entry.isGlobal) {
		tagClass = 'tag-global';
		tagLabel = 'Global Q';
	} else if (entry.isThinking) {
		tagClass = 'tag-thinking';
		tagLabel = 'Thinking';
	} else if (entry.isRolling) {
		tagClass = 'tag-rolling';
		tagLabel = 'Rolling';
	} else {
		tagClass = 'tag-summary';
		tagLabel = 'Individual';
	}
	const modelHtml = entry.modelId ? '<span class="model-label">' + escapeHtml(entry.modelId) + '</span>' : '';
	let compressionHtml = '';
	if (entry.isThinking && entry.originalLength) {
		const ratio = Math.round((1 - entry.text.length / entry.originalLength) * 100);
		compressionHtml = '<span class="compression-info">' + entry.originalLength + ' → ' + entry.text.length + ' chars (' + ratio + '% reduced)</span>';
	}
	el.innerHTML =
		'<div class="entry-header">' +
			'<span class="tag ' + tagClass + '">' + tagLabel + '</span>' +
			modelHtml +
			compressionHtml +
			'<span class="time">' + formatTime(entry.timestamp) + '</span>' +
			'<span class="time" style="opacity:0.3">#' + entry.id.slice(0,8) + '</span>' +
		'</div>' +
		'<div class="entry-body"></div>' +
		'<div class="entry-actions">' +
			'<button class="copy-btn">Copy</button>' +
			(entry.sourceMessages && entry.sourceMessages.length > 0 ? '<button class="source-btn">View Source</button>' : '') +
		'</div>';
	const bodyEl = el.querySelector('.entry-body');
	if (entry.isThinking && entry.keyPoints) {
		bodyEl.innerHTML =
			'<div class="keypoints-block"><span class="tag tag-keypoints" style="margin-bottom:4px;display:inline-block">Key Points</span><br>' + escapeHtml(entry.keyPoints) + '</div>' +
			'<div class="thinking-block"><span class="tag tag-thinking" style="margin-bottom:4px;display:inline-block">Thinking</span><br>' + escapeHtml(entry.text) + '</div>';
	} else {
		bodyEl.textContent = entry.text;
	}
	bodyEl.addEventListener('click', () => el.classList.toggle('expanded'));
	const copyBtn = el.querySelector('.copy-btn');
	copyBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		navigator.clipboard.writeText(entry.text).then(() => {
			copyBtn.textContent = 'Copied!';
			copyBtn.classList.add('copied');
			setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1500);
		});
	});
	
	// Add event handler for View Source button
	const sourceBtn = el.querySelector('.source-btn');
	if (sourceBtn && entry.sourceMessages) {
		sourceBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			showSourceModal(entry);
		});
	}
	
	return el;
}

function showSourceModal(entry) {
	const modal = document.createElement('div');
	modal.className = 'source-modal';
	modal.innerHTML = \`
		<div class="modal-overlay">
			<div class="modal-content">
				<div class="modal-header">
					<h3>Source Messages for \${entry.isRolling ? 'Rolling' : entry.isGlobal ? 'Global' : 'Individual'} Summary</h3>
					<button class="modal-close">×</button>
				</div>
				<div class="modal-body">
					<div class="source-messages">
						\${entry.sourceMessages.map((msg, idx) => \`
							<div class="source-message">
								<div class="msg-header">
									<span class="msg-role">\${msg.role}</span>
									<span class="msg-time">\${msg.ts ? formatTime(msg.ts) : 'Unknown time'}</span>
									<span class="msg-id">#\${(msg.id || 'unknown').toString().slice(0,8)}</span>
								</div>
								<div class="msg-content">\${formatMessageContent(msg.content)}</div>
							</div>
						\`).join('')}
					</div>
				</div>
			</div>
		</div>
	\`;
	
	document.body.appendChild(modal);
	
	// Close modal handlers
	const closeBtn = modal.querySelector('.modal-close');
	const overlay = modal.querySelector('.modal-overlay');
	
	closeBtn.addEventListener('click', () => document.body.removeChild(modal));
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) document.body.removeChild(modal);
	});
	
	// ESC key handler
	const escHandler = (e) => {
		if (e.key === 'Escape') {
			document.body.removeChild(modal);
			document.removeEventListener('keydown', escHandler);
		}
	};
	document.addEventListener('keydown', escHandler);
}

function formatMessageContent(content) {
	if (typeof content === 'string') {
		return escapeHtml(content);
	}
	if (Array.isArray(content)) {
		return content.map(block => {
			if (block.type === 'text') {
				return escapeHtml(block.text);
			} else if (block.type === 'tool_use') {
				return \`<span class="tool-use">[Tool: \${block.name}]</span>\`;
			} else if (block.type === 'tool_result') {
				return \`<span class="tool-result">[Tool Result]</span>\`;
			} else {
				return \`<span class="unknown-block">[Unknown block type: \${block.type}]</span>\`;
			}
		}).join('<br>');
	}
	return '[Unknown content format]';
}

function escapeHtml(str) {
	return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderAll() {
	entriesEl.innerHTML = '';
	countBadge.textContent = entries.length;
	if (entries.length === 0) {
		entriesEl.innerHTML = '<div class="empty-msg">No summaries yet.<br>Summaries will appear here when context condensing runs.</div>';
		return;
	}
	// Show newest first
	for (let i = entries.length - 1; i >= 0; i--) {
		entriesEl.appendChild(renderEntry(entries[i]));
	}
}

testBtn.addEventListener('click', () => {
	vscode.postMessage({ type: 'test' });
});

clearBtn.addEventListener('click', () => {
	entries = [];
	renderAll();
	vscode.postMessage({ type: 'clear' });
});

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'allEntries') {
		entries = msg.entries || [];
		renderAll();
	} else if (msg.type === 'addEntry') {
		entries.push(msg.entry);
		countBadge.textContent = entries.length;
		const el = renderEntry(msg.entry);
		// Insert at top (newest first)
		if (entriesEl.firstChild && !entriesEl.querySelector('.empty-msg')) {
			entriesEl.insertBefore(el, entriesEl.firstChild);
		} else {
			entriesEl.innerHTML = '';
			entriesEl.appendChild(el);
		}
	} else if (msg.type === 'reset') {
		entries = [];
		renderAll();
	}
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`
	}
}
