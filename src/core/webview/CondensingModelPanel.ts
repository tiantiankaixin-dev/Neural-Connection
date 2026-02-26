import * as vscode from "vscode"
import { getNonce } from "./getNonce"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { ContextProxy } from "../config/ContextProxy"

/**
 * Bare-shell panel for selecting the condensing model.
 * Two options only: Default (no override) or Custom Model (manual model ID input).
 */
export class CondensingModelPanel {
	private static instance: CondensingModelPanel | undefined
	private panel: vscode.WebviewPanel | undefined
	private disposables: vscode.Disposable[] = []

	private constructor(
		private readonly providerSettingsManager: ProviderSettingsManager,
		private readonly contextProxy: ContextProxy,
	) {}

	public static show(providerSettingsManager: ProviderSettingsManager, contextProxy: ContextProxy): void {
		if (CondensingModelPanel.instance?.panel) {
			CondensingModelPanel.instance.panel.reveal(vscode.ViewColumn.One)
			CondensingModelPanel.instance.refresh()
			return
		}

		const inst = new CondensingModelPanel(providerSettingsManager, contextProxy)
		CondensingModelPanel.instance = inst

		inst.panel = vscode.window.createWebviewPanel(
			"roo.condensingModel",
			"Condensing Model",
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: false },
		)

		inst.panel.webview.onDidReceiveMessage(
			async (message: any) => {
				switch (message.type) {
					case "ready":
						await inst.refresh()
						break
					case "fetchModels":
					case "fetchModelsRegression": {
						const baseUrl = message.baseUrl as string
						const resultType =
							message.type === "fetchModelsRegression"
								? "fetchModelsRegressionResult"
								: "fetchModelsResult"
						try {
							const controller = new AbortController()
							const timeout = setTimeout(() => controller.abort(), 8000)
							const response = await fetch(`${baseUrl}/models`, { signal: controller.signal })
							clearTimeout(timeout)
							if (!response.ok) throw new Error(`HTTP ${response.status}`)
							const json = await response.json()
							let ids: string[] = []
							if (Array.isArray(json?.data)) {
								ids = json.data.map((m: any) => m.id || m.name || String(m)).filter(Boolean)
							} else if (Array.isArray(json?.models)) {
								ids = json.models.map((m: any) => m.name || m.model || String(m)).filter(Boolean)
							}
							inst.panel?.webview.postMessage({ type: resultType, models: ids, error: null })
						} catch (error) {
							inst.panel?.webview.postMessage({
								type: resultType,
								models: [],
								error: error instanceof Error ? error.message : String(error),
							})
						}
						break
					}
					case "select": {
						const baseUrl: string | undefined = message.baseUrl || undefined
						const modelId: string | undefined = message.modelId || undefined
						const regBaseUrl: string | undefined = message.regBaseUrl || undefined
						const regModelId: string | undefined = message.regModelId || undefined
						await inst.contextProxy.updateGlobalState("condensingBaseUrl", baseUrl)
						await inst.contextProxy.updateGlobalState("condensingModelId", modelId)
						await inst.contextProxy.updateGlobalState("condensingProvider", undefined)
						await inst.contextProxy.updateGlobalState("condensingApiConfigId", undefined)
						await inst.contextProxy.updateGlobalState("regressionBaseUrl", regBaseUrl)
						await inst.contextProxy.updateGlobalState("regressionModelId", regModelId)
						await inst.refresh()
						const label = baseUrl ? `${baseUrl} / ${modelId || "?"}` : "Default"
						const regLabel = regBaseUrl ? `${regBaseUrl} / ${regModelId || "?"}` : "Not set"
						vscode.window.showInformationMessage(`Summary: ${label} | Regression: ${regLabel}`)
						break
					}
					case "close":
						inst.panel?.dispose()
						break
				}
			},
			undefined,
			inst.disposables,
		)

		inst.panel.onDidDispose(
			() => {
				inst.panel = undefined
				while (inst.disposables.length) {
					inst.disposables.pop()?.dispose()
				}
				CondensingModelPanel.instance = undefined
			},
			null,
			inst.disposables,
		)

		inst.panel.webview.html = inst.getHtml()
	}

	private async refresh(): Promise<void> {
		if (!this.panel) return
		const currentBaseUrl = this.contextProxy.getGlobalState("condensingBaseUrl")
		const currentModelId = this.contextProxy.getGlobalState("condensingModelId")
		const regBaseUrl = this.contextProxy.getGlobalState("regressionBaseUrl")
		const regModelId = this.contextProxy.getGlobalState("regressionModelId")
		this.panel.webview.postMessage({
			type: "state",
			currentBaseUrl: currentBaseUrl ?? null,
			currentModelId: currentModelId ?? null,
			regBaseUrl: regBaseUrl ?? null,
			regModelId: regModelId ?? null,
		})
	}

	private getHtml(): string {
		const nonce = getNonce()
		return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Condensing Model</title>
<style nonce="${nonce}">
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-editor-foreground, #cccccc);
	--border: var(--vscode-panel-border, #444);
	--hover: var(--vscode-list-hoverBackground, #2a2d2e);
	--active: var(--vscode-list-activeSelectionBackground, #094771);
	--active-fg: var(--vscode-list-activeSelectionForeground, #fff);
	--accent: var(--vscode-textLink-foreground, #3794ff);
	--btn-bg: var(--vscode-button-background, #0e639c);
	--btn-fg: var(--vscode-button-foreground, #fff);
	--btn2-bg: var(--vscode-button-secondaryBackground, #3a3d41);
	--btn2-fg: var(--vscode-button-secondaryForeground, #ccc);
	--input-bg: var(--vscode-input-background, #3c3c3c);
	--input-border: var(--vscode-input-border, #555);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
	font-size: 13px; color: var(--fg); background: var(--bg);
	height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
.header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); }
.header h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
.header p { font-size: 12px; opacity: 0.7; line-height: 1.5; }
.current-bar {
	padding: 10px 24px; border-bottom: 1px solid var(--border);
	display: flex; align-items: center; gap: 10px; font-size: 12px;
}
.current-bar .lbl { opacity: 0.6; }
.current-bar .val { font-weight: 600; color: var(--accent); }
.list { flex: 1; overflow-y: auto; padding: 16px 24px; }

.option-item {
	display: flex; align-items: center; gap: 12px;
	padding: 12px 14px; border-radius: 6px; cursor: pointer;
	border: 1px solid transparent; margin-bottom: 10px;
}
.option-item:hover { background: var(--hover); border-color: var(--border); }
.option-item.selected { background: var(--active); color: var(--active-fg); border-color: var(--accent); }
.radio {
	width: 14px; height: 14px; border-radius: 50%;
	border: 2px solid var(--border); flex-shrink: 0;
	display: flex; align-items: center; justify-content: center;
}
.selected .radio { border-color: var(--accent); }
.selected .radio::after {
	content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
}

.custom-section {
	border: 1px solid var(--border); border-radius: 6px; overflow: visible;
}
.custom-header {
	display: flex; align-items: center; gap: 10px;
	padding: 12px 14px; cursor: pointer; user-select: none; font-weight: 600;
}
.custom-header:hover { background: var(--hover); }
.custom-header .arrow { font-size: 10px; flex-shrink: 0; transition: transform 0.15s; }
.custom-header .arrow.open { transform: rotate(90deg); }
.custom-body { display: none; border-top: 1px solid var(--border); padding: 14px 16px; overflow: visible; }
.custom-body.open { display: block; }
.custom-body label { font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px; }
.custom-body input {
	width: 100%; padding: 6px 10px; font-size: 13px;
	background: var(--input-bg); color: var(--fg);
	border: 1px solid var(--input-border); border-radius: 4px; outline: none;
}
.custom-body .hint { font-size: 11px; opacity: 0.5; margin-top: 8px; line-height: 1.5; }

/* URL dropdown */
.url-wrapper { position: relative; }
.url-dropdown {
	position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
	background: var(--input-bg); border: 1px solid var(--input-border);
	border-top: none; border-radius: 0 0 4px 4px;
	max-height: 240px; overflow-y: auto;
}
.url-dropdown .url-item {
	padding: 6px 10px; cursor: pointer; font-size: 12px;
	display: flex; flex-direction: column; gap: 1px;
}
.url-dropdown .url-item:hover { background: var(--hover); }
.url-dropdown .url-item .url-name { font-weight: 600; }
.url-dropdown .url-item .url-val { opacity: 0.6; font-size: 11px; }

/* Model dropdown */
.model-wrapper { position: relative; }
.model-dropdown {
	position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
	background: var(--input-bg); border: 1px solid var(--input-border);
	border-top: none; border-radius: 0 0 4px 4px;
	max-height: 240px; overflow-y: auto;
}
.model-dropdown .model-dd-item {
	padding: 5px 10px; cursor: pointer; font-size: 12px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.model-dropdown .model-dd-item:hover { background: var(--hover); }
.model-dropdown .model-dd-msg {
	padding: 8px 10px; font-size: 11px; opacity: 0.6;
}

.footer {
	padding: 12px 24px; border-top: 1px solid var(--border);
	display: flex; justify-content: flex-end; gap: 8px;
}
.footer button {
	padding: 6px 16px; border: none; border-radius: 4px;
	font-size: 13px; cursor: pointer;
}
.footer .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
.footer .btn-primary:hover { opacity: 0.9; }
.footer .btn-primary:disabled { opacity: 0.4; cursor: default; }
.footer .btn-secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
.footer .btn-secondary:hover { opacity: 0.9; }
</style>
</head>
<body>
<div class="header">
	<h1>Condensing Model</h1>
	<p>Choose which model to use for context condensing (summarization).</p>
</div>
<div class="current-bar">
	<span class="lbl">Current:</span>
	<span class="val" id="curVal">Loading...</span>
</div>
<div class="list" id="listEl"></div>
<div class="footer">
	<button class="btn-secondary" id="closeBtn">Close</button>
	<button class="btn-primary" id="saveBtn" disabled>Save</button>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('listEl');
const curVal = document.getElementById('curVal');
const saveBtn = document.getElementById('saveBtn');
const closeBtn = document.getElementById('closeBtn');

let savedBaseUrl = null;
let savedModelId = null;
let pendingBaseUrl = null;
let pendingModelId = null;
let customOpen = false;
let baseUrlInput = '';
let modelIdInput = '';
let urlDropdownOpen = false;
let modelDropdownOpen = false;
let fetchedModels = [];      // string[] from host
let fetchedForUrl = null;    // which baseUrl we fetched for
let modelsFetching = false;
let modelsError = null;
let renderModelDropdownGlobal = function() {}; // set by render()

// Regression model state
let regSavedBaseUrl = null;
let regSavedModelId = null;
let regPendingBaseUrl = null;
let regPendingModelId = null;
let regCustomOpen = false;
let regBaseUrlInput = '';
let regModelIdInput = '';
let regUrlDropdownOpen = false;
let regModelDropdownOpen = false;
let regFetchedModels = [];
let regFetchedForUrl = null;
let regModelsFetching = false;
let regModelsError = null;
let regRenderModelDropdownGlobal = function() {};

const PRESET_URLS = [
	{ name: 'Ollama',    url: 'http://localhost:11434/v1' },
	{ name: 'LM Studio', url: 'http://localhost:1234/v1' },
	{ name: 'LocalAI',   url: 'http://localhost:8080/v1' },
	{ name: 'Jan',       url: 'http://localhost:1337/v1' },
	{ name: 'GPT4All',   url: 'http://localhost:4891/v1' },
	{ name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
	{ name: 'DeepSeek',  url: 'https://api.deepseek.com/v1' },
	{ name: 'Groq',      url: 'https://api.groq.com/openai/v1' },
	{ name: 'Together',  url: 'https://api.together.xyz/v1' },
	{ name: 'Mistral',   url: 'https://api.mistral.ai/v1' },
	{ name: 'OpenAI',    url: 'https://api.openai.com/v1' },
];

function render() {
	listEl.innerHTML = '';

	// Default option
	const isDefault = !pendingBaseUrl && !pendingModelId;
	const def = document.createElement('div');
	def.className = 'option-item' + (isDefault ? ' selected' : '');
	def.innerHTML = '<div class="radio"></div><div style="flex:1"><div style="font-weight:600">Default</div><div style="font-size:11px;opacity:0.6">No override — uses the same model as the active task</div></div>';
	def.addEventListener('click', () => { pendingBaseUrl = null; pendingModelId = null; baseUrlInput = ''; modelIdInput = ''; render(); updateSave(); });
	listEl.appendChild(def);

	// Custom Model section
	const sec = document.createElement('div');
	sec.className = 'custom-section';
	const hdr = document.createElement('div');
	hdr.className = 'custom-header';
	hdr.innerHTML = '<span class="arrow ' + (customOpen ? 'open' : '') + '">&#9654;</span><span>Models For Summary</span>';
	hdr.addEventListener('click', () => { customOpen = !customOpen; render(); });
	sec.appendChild(hdr);

	if (customOpen) {
		const body = document.createElement('div');
		body.className = 'custom-body open';

		// Base URL field with dropdown
		const lbl1 = document.createElement('label');
		lbl1.textContent = 'Base URL';
		body.appendChild(lbl1);
		const wrapper = document.createElement('div');
		wrapper.className = 'url-wrapper';
		const inp1 = document.createElement('input');
		inp1.type = 'text';
		inp1.placeholder = 'Click to select or type a URL...';
		inp1.value = baseUrlInput;
		inp1.addEventListener('focus', () => { urlDropdownOpen = true; renderDropdown(); });
		inp1.addEventListener('input', (e) => {
			baseUrlInput = e.target.value;
			pendingBaseUrl = baseUrlInput.trim() || null;
			urlDropdownOpen = true;
			renderDropdown();
			updateSave();
		});
		wrapper.appendChild(inp1);

		const dropdown = document.createElement('div');
		dropdown.className = 'url-dropdown';
		dropdown.style.display = 'none';
		wrapper.appendChild(dropdown);

		function renderDropdown() {
			const filter = (baseUrlInput || '').toLowerCase();
			const items = PRESET_URLS.filter(p => !filter || p.name.toLowerCase().includes(filter) || p.url.toLowerCase().includes(filter));
			if (!urlDropdownOpen || items.length === 0) { dropdown.style.display = 'none'; return; }
			dropdown.style.display = 'block';
			dropdown.innerHTML = '';
			items.forEach(p => {
				const item = document.createElement('div');
				item.className = 'url-item';
				item.innerHTML = '<span class="url-name">' + p.name + '</span><span class="url-val">' + p.url + '</span>';
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					baseUrlInput = p.url;
					pendingBaseUrl = p.url;
					inp1.value = p.url;
					urlDropdownOpen = false;
					dropdown.style.display = 'none';
					updateSave();
				});
				dropdown.appendChild(item);
			});
		}

		inp1.addEventListener('blur', () => { setTimeout(() => { urlDropdownOpen = false; dropdown.style.display = 'none'; }, 150); });
		body.appendChild(wrapper);

		// Model ID field with dropdown
		const lbl2 = document.createElement('label');
		lbl2.textContent = 'Model ID';
		lbl2.style.marginTop = '12px';
		body.appendChild(lbl2);
		const mWrapper = document.createElement('div');
		mWrapper.className = 'model-wrapper';
		const inp2 = document.createElement('input');
		inp2.type = 'text';
		inp2.placeholder = pendingBaseUrl ? 'Click to load models...' : 'Set Base URL first';
		inp2.value = modelIdInput;

		inp2.addEventListener('focus', () => {
			if (!pendingBaseUrl) return;
			modelDropdownOpen = true;
			if (fetchedForUrl !== pendingBaseUrl) {
				fetchedModels = [];
				modelsFetching = true;
				modelsError = null;
				fetchedForUrl = pendingBaseUrl;
				vscode.postMessage({ type: 'fetchModels', baseUrl: pendingBaseUrl });
			}
			renderModelDropdown();
		});
		inp2.addEventListener('input', (e) => {
			modelIdInput = e.target.value;
			pendingModelId = modelIdInput.trim() || null;
			modelDropdownOpen = true;
			renderModelDropdown();
			updateSave();
		});
		mWrapper.appendChild(inp2);

		const mDropdown = document.createElement('div');
		mDropdown.className = 'model-dropdown';
		mDropdown.style.display = 'none';
		mWrapper.appendChild(mDropdown);

		renderModelDropdownGlobal = renderModelDropdown;
		function renderModelDropdown() {
			if (!modelDropdownOpen) { mDropdown.style.display = 'none'; return; }
			mDropdown.style.display = 'block';
			mDropdown.innerHTML = '';
			if (modelsFetching) {
				mDropdown.innerHTML = '<div class="model-dd-msg">Loading models...</div>';
				return;
			}
			if (modelsError) {
				mDropdown.innerHTML = '<div class="model-dd-msg" style="color:var(--vscode-errorForeground,#f44)">Error: ' + modelsError + '</div>';
				return;
			}
			if (fetchedModels.length === 0) {
				mDropdown.innerHTML = '<div class="model-dd-msg">No models found</div>';
				return;
			}
			const filter = (modelIdInput || '').toLowerCase();
			const filtered = filter ? fetchedModels.filter(m => m.toLowerCase().includes(filter)) : fetchedModels;
			if (filtered.length === 0) {
				mDropdown.innerHTML = '<div class="model-dd-msg">No match</div>';
				return;
			}
			filtered.slice(0, 100).forEach(mid => {
				const item = document.createElement('div');
				item.className = 'model-dd-item';
				item.textContent = mid;
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					modelIdInput = mid;
					pendingModelId = mid;
					inp2.value = mid;
					modelDropdownOpen = false;
					mDropdown.style.display = 'none';
					updateSave();
				});
				mDropdown.appendChild(item);
			});
			if (filtered.length > 100) {
				mDropdown.innerHTML += '<div class="model-dd-msg">... ' + (filtered.length - 100) + ' more, type to filter</div>';
			}
		}

		inp2.addEventListener('blur', () => { setTimeout(() => { modelDropdownOpen = false; mDropdown.style.display = 'none'; }, 150); });
		body.appendChild(mWrapper);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = 'Enter the OpenAI-compatible API endpoint and model ID. Works with Ollama, LM Studio, LocalAI, Jan, OpenRouter, etc.';
		body.appendChild(hint);
		sec.appendChild(body);
	}

	listEl.appendChild(sec);

	// --- Models To Regress section ---
	const regSec = document.createElement('div');
	regSec.className = 'custom-section';
	regSec.style.marginTop = '10px';
	const regHdr = document.createElement('div');
	regHdr.className = 'custom-header';
	regHdr.innerHTML = '<span class="arrow ' + (regCustomOpen ? 'open' : '') + '">&#9654;</span><span>Models To Regress</span>';
	regHdr.addEventListener('click', () => { regCustomOpen = !regCustomOpen; render(); });
	regSec.appendChild(regHdr);

	if (regCustomOpen) {
		const regBody = document.createElement('div');
		regBody.className = 'custom-body open';

		const regLbl1 = document.createElement('label');
		regLbl1.textContent = 'Base URL';
		regBody.appendChild(regLbl1);
		const regWrapper = document.createElement('div');
		regWrapper.className = 'url-wrapper';
		const regInp1 = document.createElement('input');
		regInp1.type = 'text';
		regInp1.placeholder = 'Click to select or type a URL...';
		regInp1.value = regBaseUrlInput;
		regInp1.addEventListener('focus', () => { regUrlDropdownOpen = true; regRenderDropdown(); });
		regInp1.addEventListener('input', (e) => {
			regBaseUrlInput = e.target.value;
			regPendingBaseUrl = regBaseUrlInput.trim() || null;
			regUrlDropdownOpen = true;
			regRenderDropdown();
			updateSave();
		});
		regWrapper.appendChild(regInp1);

		const regDropdown = document.createElement('div');
		regDropdown.className = 'url-dropdown';
		regDropdown.style.display = 'none';
		regWrapper.appendChild(regDropdown);

		function regRenderDropdown() {
			const filter = (regBaseUrlInput || '').toLowerCase();
			const items = PRESET_URLS.filter(p => !filter || p.name.toLowerCase().includes(filter) || p.url.toLowerCase().includes(filter));
			if (!regUrlDropdownOpen || items.length === 0) { regDropdown.style.display = 'none'; return; }
			regDropdown.style.display = 'block';
			regDropdown.innerHTML = '';
			items.forEach(p => {
				const item = document.createElement('div');
				item.className = 'url-item';
				item.innerHTML = '<span class="url-name">' + p.name + '</span><span class="url-val">' + p.url + '</span>';
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					regBaseUrlInput = p.url;
					regPendingBaseUrl = p.url;
					regInp1.value = p.url;
					regUrlDropdownOpen = false;
					regDropdown.style.display = 'none';
					updateSave();
				});
				regDropdown.appendChild(item);
			});
		}

		regInp1.addEventListener('blur', () => { setTimeout(() => { regUrlDropdownOpen = false; regDropdown.style.display = 'none'; }, 150); });
		regBody.appendChild(regWrapper);

		const regLbl2 = document.createElement('label');
		regLbl2.textContent = 'Model ID';
		regLbl2.style.marginTop = '12px';
		regBody.appendChild(regLbl2);
		const regMWrapper = document.createElement('div');
		regMWrapper.className = 'model-wrapper';
		const regInp2 = document.createElement('input');
		regInp2.type = 'text';
		regInp2.placeholder = regPendingBaseUrl ? 'Click to load models...' : 'Set Base URL first';
		regInp2.value = regModelIdInput;

		regInp2.addEventListener('focus', () => {
			if (!regPendingBaseUrl) return;
			regModelDropdownOpen = true;
			if (regFetchedForUrl !== regPendingBaseUrl) {
				regFetchedModels = [];
				regModelsFetching = true;
				regModelsError = null;
				regFetchedForUrl = regPendingBaseUrl;
				vscode.postMessage({ type: 'fetchModelsRegression', baseUrl: regPendingBaseUrl });
			}
			regRenderModelDropdown();
		});
		regInp2.addEventListener('input', (e) => {
			regModelIdInput = e.target.value;
			regPendingModelId = regModelIdInput.trim() || null;
			regModelDropdownOpen = true;
			regRenderModelDropdown();
			updateSave();
		});
		regMWrapper.appendChild(regInp2);

		const regMDropdown = document.createElement('div');
		regMDropdown.className = 'model-dropdown';
		regMDropdown.style.display = 'none';
		regMWrapper.appendChild(regMDropdown);

		regRenderModelDropdownGlobal = regRenderModelDropdown;
		function regRenderModelDropdown() {
			if (!regModelDropdownOpen) { regMDropdown.style.display = 'none'; return; }
			regMDropdown.style.display = 'block';
			regMDropdown.innerHTML = '';
			if (regModelsFetching) {
				regMDropdown.innerHTML = '<div class="model-dd-msg">Loading models...</div>';
				return;
			}
			if (regModelsError) {
				regMDropdown.innerHTML = '<div class="model-dd-msg" style="color:var(--vscode-errorForeground,#f44)">Error: ' + regModelsError + '</div>';
				return;
			}
			if (regFetchedModels.length === 0) {
				regMDropdown.innerHTML = '<div class="model-dd-msg">No models found</div>';
				return;
			}
			const filter = (regModelIdInput || '').toLowerCase();
			const filtered = filter ? regFetchedModels.filter(m => m.toLowerCase().includes(filter)) : regFetchedModels;
			if (filtered.length === 0) {
				regMDropdown.innerHTML = '<div class="model-dd-msg">No match</div>';
				return;
			}
			filtered.slice(0, 100).forEach(mid => {
				const item = document.createElement('div');
				item.className = 'model-dd-item';
				item.textContent = mid;
				item.addEventListener('mousedown', (e) => {
					e.preventDefault();
					regModelIdInput = mid;
					regPendingModelId = mid;
					regInp2.value = mid;
					regModelDropdownOpen = false;
					regMDropdown.style.display = 'none';
					updateSave();
				});
				regMDropdown.appendChild(item);
			});
			if (filtered.length > 100) {
				regMDropdown.innerHTML += '<div class="model-dd-msg">... ' + (filtered.length - 100) + ' more, type to filter</div>';
			}
		}

		regInp2.addEventListener('blur', () => { setTimeout(() => { regModelDropdownOpen = false; regMDropdown.style.display = 'none'; }, 150); });
		regBody.appendChild(regMWrapper);

		const regHint = document.createElement('div');
		regHint.className = 'hint';
		regHint.textContent = 'Local model used for memory regression: drilling down from Global Q to Individual Summary to original messages when the AI needs to recall specific details.';
		regBody.appendChild(regHint);
		regSec.appendChild(regBody);
	}

	listEl.appendChild(regSec);

	curVal.textContent = savedBaseUrl ? savedBaseUrl + ' / ' + (savedModelId || '?') : 'Default (no override)';
}

function updateSave() {
	const changed = pendingBaseUrl !== savedBaseUrl || pendingModelId !== savedModelId
		|| regPendingBaseUrl !== regSavedBaseUrl || regPendingModelId !== regSavedModelId;
	saveBtn.disabled = !changed;
}

saveBtn.addEventListener('click', () => {
	if (saveBtn.disabled) return;
	vscode.postMessage({ type: 'select', baseUrl: pendingBaseUrl || '', modelId: pendingModelId || '', regBaseUrl: regPendingBaseUrl || '', regModelId: regPendingModelId || '' });
});

closeBtn.addEventListener('click', () => { vscode.postMessage({ type: 'close' }); });

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'state') {
		savedBaseUrl = msg.currentBaseUrl;
		savedModelId = msg.currentModelId;
		pendingBaseUrl = savedBaseUrl;
		pendingModelId = savedModelId;
		baseUrlInput = savedBaseUrl || '';
		modelIdInput = savedModelId || '';
		if (savedBaseUrl) customOpen = true;
		regSavedBaseUrl = msg.regBaseUrl;
		regSavedModelId = msg.regModelId;
		regPendingBaseUrl = regSavedBaseUrl;
		regPendingModelId = regSavedModelId;
		regBaseUrlInput = regSavedBaseUrl || '';
		regModelIdInput = regSavedModelId || '';
		if (regSavedBaseUrl) regCustomOpen = true;
		render(); updateSave();
	} else if (msg.type === 'fetchModelsResult') {
		modelsFetching = false;
		modelsError = msg.error || null;
		if (!msg.error) {
			fetchedModels = msg.models || [];
		}
		renderModelDropdownGlobal();
	} else if (msg.type === 'fetchModelsRegressionResult') {
		regModelsFetching = false;
		regModelsError = msg.error || null;
		if (!msg.error) {
			regFetchedModels = msg.models || [];
		}
		regRenderModelDropdownGlobal();
	}
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`
	}
}
