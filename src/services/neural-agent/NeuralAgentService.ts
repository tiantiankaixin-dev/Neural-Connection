import type { NeuralAgentStatus, LocalAiConnectionStatus } from "./types"

/**
 * NeuralAgentService — Neural Agent 主服务（单例）
 *
 * 精简版职责：
 * 1. 管理开关状态（enabled / disabled）
 * 2. 检测本地AI（Ollama）连接状态
 * 3. 向 webview 推送状态更新
 */
export class NeuralAgentService {
	private static _instance: NeuralAgentService | null = null

	// 状态
	private _enabled = false
	private _localAiStatus: LocalAiConnectionStatus = "disconnected"
	private _ollamaBaseUrl = "http://localhost:11434"
	private _ollamaModelId: string | null = null

	// 状态变更回调
	private _onStatusChange: ((status: NeuralAgentStatus) => void) | null = null

	private constructor() {}

	static getInstance(): NeuralAgentService {
		if (!NeuralAgentService._instance) {
			NeuralAgentService._instance = new NeuralAgentService()
		}
		return NeuralAgentService._instance
	}

	// ============================================================
	// 开关管理
	// ============================================================

	get enabled(): boolean {
		return this._enabled
	}

	toggle(enabled: boolean): void {
		this._enabled = enabled

		if (enabled) {
			this.checkLocalAiConnection()
		}

		this.notifyStatusChange()
	}

	// ============================================================
	// Ollama 连接管理
	// ============================================================

	/**
	 * 从设置面板更新 Ollama 连接参数
	 * 任何非 undefined 的参数都会被更新
	 */
	setOllamaConfig(ollamaBaseUrl?: string, ollamaModelId?: string): void {
		if (ollamaBaseUrl !== undefined) {
			this._ollamaBaseUrl = ollamaBaseUrl || "http://localhost:11434"
		}
		if (ollamaModelId !== undefined) {
			this._ollamaModelId = ollamaModelId || null
		}
		// Re-check connection with new URL
		if (this._enabled) {
			this.checkLocalAiConnection()
		}
	}

	get localAiStatus(): LocalAiConnectionStatus {
		return this._localAiStatus
	}

	get ollamaBaseUrl(): string {
		return this._ollamaBaseUrl
	}

	get ollamaModelId(): string | null {
		return this._ollamaModelId
	}

	/**
	 * 检测 Ollama 服务是否可用
	 * 调用 GET /api/tags 端点检查连接
	 */
	async checkLocalAiConnection(): Promise<boolean> {
		this._localAiStatus = "checking"
		this.notifyStatusChange()

		try {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 5000)

			const response = await fetch(`${this._ollamaBaseUrl}/api/tags`, {
				signal: controller.signal,
			})

			clearTimeout(timeout)

			if (response.ok) {
				this._localAiStatus = "connected"
				this.notifyStatusChange()
				return true
			}

			this._localAiStatus = "disconnected"
			this.notifyStatusChange()
			return false
		} catch {
			this._localAiStatus = "disconnected"
			this.notifyStatusChange()
			return false
		}
	}

	// ============================================================
	// 状态推送
	// ============================================================

	onStatusChange(callback: (status: NeuralAgentStatus) => void): void {
		this._onStatusChange = callback
	}

	getStatus(): NeuralAgentStatus {
		return {
			enabled: this._enabled,
			localAiStatus: this._localAiStatus,
			localAiModel: this._ollamaModelId,
		}
	}

	private notifyStatusChange(): void {
		if (this._onStatusChange) {
			this._onStatusChange(this.getStatus())
		}
	}
}
