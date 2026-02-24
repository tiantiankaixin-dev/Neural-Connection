/**
 * Neural Agent 核心类型定义（精简版 — 仅模型管理 UI）
 */

// ============================================================
// Neural Agent 服务状态
// ============================================================

/** 本地AI连接状态 */
export type LocalAiConnectionStatus = "connected" | "disconnected" | "checking"

/**
 * Neural Agent 完整状态（推送给 webview）
 */
export interface NeuralAgentStatus {
	/** 开关是否开启 */
	enabled: boolean
	/** 本地AI连接状态 */
	localAiStatus: LocalAiConnectionStatus
	/** 本地AI模型名称（如 "qwen2.5-coder:7b"） */
	localAiModel: string | null
}
