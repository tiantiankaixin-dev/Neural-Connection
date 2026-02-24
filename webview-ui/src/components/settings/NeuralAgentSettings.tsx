import React, { useCallback, useEffect, useState } from "react"
import { useEvent } from "react-use"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Brain, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, RefreshCw, Download } from "lucide-react"

import type { ExtensionMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { inputEventTransform } from "./transforms"

import type { SetCachedStateField } from "./types"
import type { ExtensionStateContextType } from "@src/context/ExtensionStateContext"

type DetectedModel = {
	id: string
	sourceUrl: string
	platform: string
}

type NeuralAgentSettingsProps = {
	neuralAgentOllamaUrl?: string
	neuralAgentModelId?: string
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

export const NeuralAgentSettings = ({
	neuralAgentOllamaUrl,
	neuralAgentModelId,
	setCachedStateField,
}: NeuralAgentSettingsProps) => {
	const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([])
	const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "checking">("disconnected")
	const [modelsExpanded, setModelsExpanded] = useState(true)
	const [fetchingModels, setFetchingModels] = useState(false)

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		if (message.type === "neuralAgentStatus" && message.payload) {
			const payload = message.payload as { localAiStatus: string }
			setConnectionStatus(payload.localAiStatus as "connected" | "disconnected" | "checking")
		}

		if (message.type === "neuralAgentModels" && message.payload) {
			const payload = message.payload as { models: DetectedModel[] }
			setDetectedModels(payload.models ?? [])
			setFetchingModels(false)
		}
	}, [])

	useEvent("message", onMessage)

	const fetchModels = useCallback(() => {
		setFetchingModels(true)
		vscode.postMessage({ type: "neuralAgentFetchModels" })
	}, [])

	useEffect(() => {
		vscode.postMessage({ type: "neuralAgentGetStatus" })
		fetchModels()
	}, [fetchModels])

	const handleSelectModel = useCallback(
		(model: DetectedModel) => {
			setCachedStateField("neuralAgentModelId", model.id)
			if (model.sourceUrl) {
				setCachedStateField("neuralAgentOllamaUrl", model.sourceUrl)
			}
		},
		[setCachedStateField],
	)

	const handleShowModelDetail = useCallback((model: DetectedModel) => {
		vscode.postMessage({
			type: "neuralAgentShowModelDetail",
			values: {
				id: model.id,
				size: "-",
				vram: "-",
				description: model.platform,
				speed: "-",
				quality: "-",
				category: "general",
			},
		})
	}, [])

	const statusIcon =
		connectionStatus === "connected" ? (
			<CheckCircle className="w-4 h-4 text-green-500" />
		) : connectionStatus === "checking" ? (
			<Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />
		) : (
			<XCircle className="w-4 h-4 text-red-400" />
		)

	const statusText =
		connectionStatus === "connected" ? "已连接" : connectionStatus === "checking" ? "连接中..." : "未连接"

	const platforms = [
		{
			name: "Ollama",
			icon: "🦙",
			port: 11434,
			description: "最流行的本地模型运行平台",
			installCmd: {
				windows: "winget install Ollama.Ollama",
				macos: "brew install ollama",
				linux: "curl -fsSL https://ollama.com/install.sh | sh",
			},
		},
		{
			name: "LM Studio",
			icon: "🖥️",
			port: 1234,
			description: "图形界面，支持 GGUF 模型",
			installCmd: {
				windows: "winget install LMStudio.LMStudio",
				macos: "brew install --cask lm-studio",
				linux: 'echo "请从 https://lmstudio.ai 下载 Linux 版本"',
			},
		},
		{
			name: "Jan",
			icon: "🤖",
			port: 1337,
			description: "开源桌面 AI 助手",
			installCmd: {
				windows: "winget install Jan.Jan",
				macos: "brew install --cask jan",
				linux: 'echo "请从 https://jan.ai 下载 Linux 版本"',
			},
		},
		{
			name: "LocalAI",
			icon: "🐳",
			port: 8080,
			description: "Docker 部署，OpenAI 兼容 API",
			installCmd: {
				windows: "docker run -p 8080:8080 localai/localai",
				macos: "docker run -p 8080:8080 localai/localai",
				linux: "docker run -p 8080:8080 localai/localai",
			},
		},
		{
			name: "GPT4All",
			icon: "🔒",
			port: 4891,
			description: "完全离线，注重隐私",
			installCmd: {
				windows: "winget install Nomic.GPT4All",
				macos: "brew install --cask gpt4all",
				linux: 'echo "请从 https://gpt4all.io 下载 Linux 版本"',
			},
		},
	]

	return (
		<div>
			<SectionHeader description="管理本地 AI 模型，探测多平台服务，下载和配置模型">
				<div className="flex items-center gap-2">
					<Brain className="w-5 h-5" />
					Neural Agent（本地模型管理）
				</div>
			</SectionHeader>

			<Section>
				{/* 连接状态 */}
				<div className="flex items-center gap-2 px-3 py-2 rounded-md bg-vscode-editor-background border border-vscode-panel-border">
					{statusIcon}
					<span className="text-sm">本地 AI 服务：{statusText}</span>
				</div>

				{/* 服务地址 */}
				<div>
					<VSCodeTextField
						value={neuralAgentOllamaUrl || ""}
						type="url"
						onInput={(e: any) => {
							const value = inputEventTransform(e)
							setCachedStateField("neuralAgentOllamaUrl", value)
						}}
						placeholder="http://localhost:11434"
						className="w-full">
						<label className="block font-medium mb-1">本地 AI 服务地址</label>
					</VSCodeTextField>
					<div className="text-xs text-vscode-descriptionForeground mt-1">
						选择下方模型时会根据其所在平台自动填写地址，也可手动输入
					</div>
				</div>

				{/* ── 可用模型（可折叠） ───────────────────────── */}
				<div className="border border-vscode-panel-border rounded-md overflow-hidden">
					<button
						onClick={() => setModelsExpanded(!modelsExpanded)}
						className="w-full flex items-center justify-between px-3 py-2 bg-vscode-editor-background hover:bg-vscode-list-hoverBackground cursor-pointer border-0 text-vscode-foreground">
						<span className="font-medium text-sm flex items-center gap-2">
							可用模型
							<span className="text-xs px-1.5 py-0.5 rounded-full bg-vscode-badge-background text-vscode-badge-foreground">
								{fetchingModels ? "..." : detectedModels.length}
							</span>
						</span>
						<div className="flex items-center gap-1.5">
							<button
								onClick={(e) => {
									e.stopPropagation()
									fetchModels()
								}}
								className="p-1 bg-transparent border-0 text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer rounded"
								title="刷新模型列表">
								<RefreshCw className={`w-3.5 h-3.5 ${fetchingModels ? "animate-spin" : ""}`} />
							</button>
							{modelsExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
						</div>
					</button>
					{modelsExpanded && (
						<div className="border-t border-vscode-panel-border">
							{detectedModels.length > 0 ? (
								<div className="max-h-[280px] overflow-y-auto">
									{detectedModels.map((model) => (
										<div
											key={`${model.id}-${model.sourceUrl}`}
											onClick={() => handleSelectModel(model)}
											className={`flex items-center justify-between px-3 py-2 cursor-pointer border-b border-vscode-panel-border last:border-b-0 transition-colors ${
												neuralAgentModelId === model.id
													? "bg-vscode-list-activeSelectionBackground"
													: "hover:bg-vscode-list-hoverBackground"
											}`}>
											<div className="flex items-center gap-2 min-w-0">
												<span className="text-sm truncate">{model.id}</span>
												<span className="text-[10px] px-1.5 py-0.5 rounded bg-vscode-textCodeBlock-background text-vscode-descriptionForeground flex-shrink-0">
													{model.platform}
												</span>
											</div>
											<div className="flex items-center gap-1.5 flex-shrink-0">
												<button
													onClick={(e) => {
														e.stopPropagation()
														handleShowModelDetail(model)
													}}
													className="p-1 bg-transparent border-0 text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer rounded"
													title="查看详情 / 下载">
													<Download className="w-3.5 h-3.5" />
												</button>
												{neuralAgentModelId === model.id && (
													<CheckCircle className="w-4 h-4 text-green-500" />
												)}
											</div>
										</div>
									))}
								</div>
							) : (
								<div className="px-3 py-4 text-center">
									<span className="text-sm text-vscode-descriptionForeground">无</span>
									<div className="text-xs text-vscode-descriptionForeground mt-1">
										未检测到模型。将自动探测本地常用端口（11434, 1234, 1337, 8080, 4891）上的 Ollama
										API 和 OpenAI 兼容 API。
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* 手动输入模型 ID */}
				<VSCodeTextField
					value={neuralAgentModelId || ""}
					onInput={(e: any) => {
						const value = inputEventTransform(e)
						setCachedStateField("neuralAgentModelId", value)
					}}
					placeholder="例如：qwen2.5-coder:7b"
					className="w-full">
					<label className="block font-medium mb-1">模型 ID（可手动输入）</label>
				</VSCodeTextField>

				{/* ── 平台安装 / 模型下载 ───────────────────────── */}
				<div>
					<label className="block font-medium mb-2">模型下载平台</label>
					<div className="text-xs text-vscode-descriptionForeground mb-3">
						点击安装按钮在终端中执行安装命令，安装完成后点击「刷新」探测模型。
					</div>
					<div className="grid gap-2">
						{platforms.map((p) => (
							<div
								key={p.name}
								className="flex items-center justify-between px-3 py-2.5 rounded-md border border-vscode-panel-border bg-vscode-editor-background">
								<div className="flex items-center gap-2 min-w-0">
									<span className="text-base flex-shrink-0">{p.icon}</span>
									<div className="min-w-0">
										<div className="text-sm font-medium">{p.name}</div>
										<div className="text-[10px] text-vscode-descriptionForeground">
											端口 {p.port} · {p.description}
										</div>
									</div>
								</div>
								<button
									onClick={() => {
										vscode.postMessage({
											type: "neuralAgentInstallPlatform",
											platformName: p.name,
											installCmd: p.installCmd,
										})
									}}
									className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground border-0 cursor-pointer flex-shrink-0">
									<Download className="w-3 h-3" />
									安装
								</button>
							</div>
						))}
					</div>
				</div>
			</Section>
		</div>
	)
}
