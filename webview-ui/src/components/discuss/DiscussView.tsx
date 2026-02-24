import { useState } from "react"
import { Download, Brain, Terminal, Loader2, Search, Tag } from "lucide-react"

import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

// ── 模型分类 ──────────────────────────────────────────────────────
type ModelCategory = "code" | "general" | "reasoning" | "small" | "large"

const CATEGORY_LABELS: Record<ModelCategory, string> = {
	code: "代码专用",
	general: "通用",
	reasoning: "推理增强",
	small: "轻量（<8GB 显存）",
	large: "高质量（>8GB 显存）",
}

interface RecommendedModel {
	id: string
	size: string
	vram: string
	description: string
	speed: "快" | "中" | "慢"
	quality: "高" | "中" | "低"
	category: ModelCategory
	stars?: number // 1-3 推荐度
}

const RECOMMENDED_MODELS: RecommendedModel[] = [
	// ── 代码专用 ──
	{
		id: "qwen2.5-coder:1.5b",
		size: "1.0 GB",
		vram: "~2 GB",
		description: "超轻量代码模型，CPU 也能跑",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "qwen2.5-coder:3b",
		size: "2.0 GB",
		vram: "~4 GB",
		description: "轻量代码模型，集显友好",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "qwen2.5-coder:7b",
		size: "4.7 GB",
		vram: "~6 GB",
		description: "速度快，适合参数纠错和简单架构分析",
		speed: "快",
		quality: "中",
		category: "code",
		stars: 3,
	},
	{
		id: "qwen2.5-coder:14b",
		size: "9.0 GB",
		vram: "~12 GB",
		description: "准确度更高，推荐有独显的用户",
		speed: "中",
		quality: "高",
		category: "code",
		stars: 3,
	},
	{
		id: "qwen2.5-coder:32b",
		size: "18 GB",
		vram: "~24 GB",
		description: "顶级代码能力，需要高端显卡",
		speed: "慢",
		quality: "高",
		category: "code",
	},
	{
		id: "codellama:7b",
		size: "3.8 GB",
		vram: "~6 GB",
		description: "Meta 出品，轻量级代码模型",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "codellama:13b",
		size: "7.4 GB",
		vram: "~10 GB",
		description: "Meta 出品，中等代码模型",
		speed: "中",
		quality: "中",
		category: "code",
	},
	{
		id: "codellama:34b",
		size: "19 GB",
		vram: "~24 GB",
		description: "Meta 出品，大型代码模型",
		speed: "慢",
		quality: "高",
		category: "code",
	},
	{
		id: "starcoder2:3b",
		size: "1.7 GB",
		vram: "~4 GB",
		description: "BigCode 出品，轻量代码补全",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "starcoder2:7b",
		size: "4.0 GB",
		vram: "~6 GB",
		description: "BigCode 出品，擅长代码补全和理解",
		speed: "快",
		quality: "中",
		category: "code",
	},
	{
		id: "starcoder2:15b",
		size: "9.0 GB",
		vram: "~12 GB",
		description: "BigCode 出品，高质量代码生成",
		speed: "中",
		quality: "高",
		category: "code",
	},
	{
		id: "deepseek-coder:6.7b",
		size: "3.8 GB",
		vram: "~6 GB",
		description: "DeepSeek 代码模型，性价比高",
		speed: "快",
		quality: "中",
		category: "code",
	},
	{
		id: "deepseek-coder:33b",
		size: "19 GB",
		vram: "~24 GB",
		description: "DeepSeek 大型代码模型",
		speed: "慢",
		quality: "高",
		category: "code",
	},
	{
		id: "deepseek-coder-v2:16b",
		size: "8.9 GB",
		vram: "~12 GB",
		description: "代码理解能力强，支持多种编程语言",
		speed: "中",
		quality: "高",
		category: "code",
		stars: 2,
	},
	{
		id: "codegemma:7b",
		size: "5.0 GB",
		vram: "~6 GB",
		description: "Google 出品，基于 Gemma 的代码模型",
		speed: "快",
		quality: "中",
		category: "code",
	},
	{
		id: "codegemma:2b",
		size: "1.4 GB",
		vram: "~3 GB",
		description: "Google 超轻量代码模型",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "stable-code:3b",
		size: "1.6 GB",
		vram: "~4 GB",
		description: "Stability AI 代码模型，快速补全",
		speed: "快",
		quality: "低",
		category: "code",
	},
	{
		id: "yi-coder:9b",
		size: "5.0 GB",
		vram: "~8 GB",
		description: "零一万物代码模型，中英双语",
		speed: "快",
		quality: "中",
		category: "code",
	},
	// ── 通用 ──
	{
		id: "llama3.1:8b",
		size: "4.7 GB",
		vram: "~6 GB",
		description: "Meta LLaMA 3.1，通用对话能力强",
		speed: "快",
		quality: "中",
		category: "general",
		stars: 2,
	},
	{
		id: "llama3.1:70b",
		size: "40 GB",
		vram: "~48 GB",
		description: "Meta 旗舰大模型，极高质量",
		speed: "慢",
		quality: "高",
		category: "general",
	},
	{
		id: "llama3.2:3b",
		size: "2.0 GB",
		vram: "~4 GB",
		description: "Meta 最新轻量模型",
		speed: "快",
		quality: "低",
		category: "general",
	},
	{
		id: "llama3.2:1b",
		size: "0.7 GB",
		vram: "~2 GB",
		description: "Meta 超轻量模型，极速",
		speed: "快",
		quality: "低",
		category: "general",
	},
	{
		id: "gemma2:2b",
		size: "1.6 GB",
		vram: "~3 GB",
		description: "Google Gemma 2 轻量版",
		speed: "快",
		quality: "低",
		category: "general",
	},
	{
		id: "gemma2:9b",
		size: "5.4 GB",
		vram: "~8 GB",
		description: "Google Gemma 2 中等版",
		speed: "快",
		quality: "中",
		category: "general",
	},
	{
		id: "gemma2:27b",
		size: "16 GB",
		vram: "~20 GB",
		description: "Google Gemma 2 大型版，质量优秀",
		speed: "中",
		quality: "高",
		category: "general",
	},
	{
		id: "mistral:7b",
		size: "4.1 GB",
		vram: "~6 GB",
		description: "Mistral AI 旗舰 7B，性能均衡",
		speed: "快",
		quality: "中",
		category: "general",
	},
	{
		id: "mixtral:8x7b",
		size: "26 GB",
		vram: "~32 GB",
		description: "Mistral MoE 架构，高性能",
		speed: "中",
		quality: "高",
		category: "general",
	},
	{
		id: "phi3:mini",
		size: "2.3 GB",
		vram: "~4 GB",
		description: "微软 Phi-3 Mini，小巧但聪明",
		speed: "快",
		quality: "中",
		category: "general",
	},
	{
		id: "phi3:medium",
		size: "7.9 GB",
		vram: "~10 GB",
		description: "微软 Phi-3 Medium",
		speed: "中",
		quality: "中",
		category: "general",
	},
	{
		id: "qwen2.5:7b",
		size: "4.7 GB",
		vram: "~6 GB",
		description: "阿里通义千问 2.5，中英双语优秀",
		speed: "快",
		quality: "中",
		category: "general",
		stars: 2,
	},
	{
		id: "qwen2.5:14b",
		size: "9.0 GB",
		vram: "~12 GB",
		description: "通义千问 2.5 中大型",
		speed: "中",
		quality: "高",
		category: "general",
	},
	{
		id: "qwen2.5:32b",
		size: "18 GB",
		vram: "~24 GB",
		description: "通义千问 2.5 大型",
		speed: "慢",
		quality: "高",
		category: "general",
	},
	{
		id: "qwen2.5:72b",
		size: "41 GB",
		vram: "~48 GB",
		description: "通义千问 2.5 旗舰",
		speed: "慢",
		quality: "高",
		category: "general",
	},
	{
		id: "yi:6b",
		size: "3.5 GB",
		vram: "~6 GB",
		description: "零一万物，中文能力强",
		speed: "快",
		quality: "中",
		category: "general",
	},
	{
		id: "yi:34b",
		size: "19 GB",
		vram: "~24 GB",
		description: "零一万物大型模型",
		speed: "慢",
		quality: "高",
		category: "general",
	},
	{
		id: "internlm2:7b",
		size: "4.5 GB",
		vram: "~6 GB",
		description: "上海AI Lab 书生浦语 2，中文理解佳",
		speed: "快",
		quality: "中",
		category: "general",
	},
	{
		id: "internlm2:20b",
		size: "12 GB",
		vram: "~16 GB",
		description: "书生浦语 2 大型版",
		speed: "中",
		quality: "高",
		category: "general",
	},
	{
		id: "command-r:35b",
		size: "20 GB",
		vram: "~24 GB",
		description: "Cohere 出品，擅长 RAG 和工具调用",
		speed: "中",
		quality: "高",
		category: "general",
	},
	// ── 推理增强 ──
	{
		id: "qwq:32b",
		size: "18 GB",
		vram: "~24 GB",
		description: "阿里 QwQ 推理模型，思维链能力强",
		speed: "慢",
		quality: "高",
		category: "reasoning",
		stars: 2,
	},
	{
		id: "deepseek-r1:8b",
		size: "4.9 GB",
		vram: "~8 GB",
		description: "DeepSeek R1 蒸馏版，推理增强",
		speed: "快",
		quality: "中",
		category: "reasoning",
		stars: 3,
	},
	{
		id: "deepseek-r1:14b",
		size: "9.0 GB",
		vram: "~12 GB",
		description: "DeepSeek R1 中型推理模型",
		speed: "中",
		quality: "高",
		category: "reasoning",
	},
	{
		id: "deepseek-r1:32b",
		size: "18 GB",
		vram: "~24 GB",
		description: "DeepSeek R1 大型推理模型",
		speed: "慢",
		quality: "高",
		category: "reasoning",
	},
	{
		id: "deepseek-r1:70b",
		size: "40 GB",
		vram: "~48 GB",
		description: "DeepSeek R1 旗舰推理模型",
		speed: "慢",
		quality: "高",
		category: "reasoning",
	},
]

// ── 运行平台 ──────────────────────────────────────────────────────
interface Platform {
	name: string
	description: string
	defaultPort: number
	icon: string
	installCmd: {
		windows: string
		macos: string
		linux: string
	}
}

const PLATFORMS: Platform[] = [
	{
		name: "Ollama",
		description: "最流行的本地模型工具，一行命令运行模型",
		defaultPort: 11434,
		icon: "🦙",
		installCmd: {
			windows: "winget install Ollama.Ollama",
			macos: "brew install ollama",
			linux: "curl -fsSL https://ollama.com/install.sh | sh",
		},
	},
	{
		name: "LM Studio",
		description: "图形界面桌面应用，适合新手",
		defaultPort: 1234,
		icon: "🖥️",
		installCmd: {
			windows: "winget install ElementLabs.LMStudio",
			macos: "brew install --cask lm-studio",
			linux: "echo '请访问 https://lmstudio.ai 下载 Linux 版本'",
		},
	},
	{
		name: "Jan",
		description: "开源桌面应用，内置模型市场",
		defaultPort: 1337,
		icon: "🤖",
		installCmd: {
			windows: "winget install Jan.Jan",
			macos: "brew install --cask jan",
			linux: "echo '请访问 https://jan.ai 下载 Linux 版本'",
		},
	},
	{
		name: "LocalAI",
		description: "Docker 部署，兼容 OpenAI API",
		defaultPort: 8080,
		icon: "🐳",
		installCmd: {
			windows: "docker run -p 8080:8080 localai/localai:latest",
			macos: "docker run -p 8080:8080 localai/localai:latest",
			linux: "docker run -p 8080:8080 localai/localai:latest",
		},
	},
	{
		name: "GPT4All",
		description: "注重隐私的桌面应用",
		defaultPort: 4891,
		icon: "🔒",
		installCmd: {
			windows: "winget install NomicAI.GPT4All",
			macos: "brew install --cask gpt4all",
			linux: "echo '请访问 https://gpt4all.io 下载 Linux 版本'",
		},
	},
]

const ALL_CATEGORIES: ModelCategory[] = ["code", "general", "reasoning"]

// ── 组件 ──────────────────────────────────────────────────────────
interface DiscussViewProps {
	onDone: () => void
}

const DiscussView = ({ onDone }: DiscussViewProps) => {
	const [activeCategory, setActiveCategory] = useState<ModelCategory | "all">("all")
	const [searchQuery, setSearchQuery] = useState("")
	const [installingPlatform, setInstallingPlatform] = useState<string | null>(null)

	const filteredModels = RECOMMENDED_MODELS.filter((m) => {
		const matchCategory = activeCategory === "all" || m.category === activeCategory
		const matchSearch =
			!searchQuery ||
			m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
			m.description.includes(searchQuery)
		return matchCategory && matchSearch
	})

	const installPlatform = (platform: Platform) => {
		setInstallingPlatform(platform.name)
		vscode.postMessage({
			type: "neuralAgentInstallPlatform",
			platformName: platform.name,
			installCmd: platform.installCmd,
		})
		setTimeout(() => setInstallingPlatform(null), 3000)
	}

	const speedColor = (s: string) => (s === "快" ? "text-green-400" : s === "中" ? "text-yellow-400" : "text-red-400")
	const qualityColor = (q: string) =>
		q === "高" ? "text-green-400" : q === "中" ? "text-yellow-400" : "text-red-400"

	return (
		<div className="fixed top-0 left-0 right-0 bottom-0 flex flex-col overflow-hidden">
			{/* 顶栏 */}
			<div className="flex items-center gap-2 px-4 py-2 border-b border-vscode-panel-border flex-shrink-0">
				<button
					className="flex items-center gap-1 bg-transparent border-none text-vscode-foreground cursor-pointer hover:text-vscode-textLink-foreground"
					onClick={onDone}>
					<span className="codicon codicon-arrow-left" />
				</button>
				<Brain className="w-4 h-4" />
				<span className="font-medium">Neural Agent 资源中心</span>
			</div>

			{/* 内容区 */}
			<div className="flex-1 overflow-y-auto">
				{/* ═══════ 推荐模型 ═══════ */}
				<div className="px-4 pt-4 pb-2">
					<h3 className="text-sm font-medium m-0 mb-2">推荐模型（{filteredModels.length}）</h3>

					{/* 搜索栏 */}
					<div className="relative mb-2">
						<Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-vscode-descriptionForeground" />
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="搜索模型..."
							className="w-full pl-8 pr-3 py-1.5 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-md outline-none focus:border-vscode-focusBorder"
						/>
					</div>

					{/* 分类标签 */}
					<div className="flex gap-1.5 flex-wrap mb-3">
						<button
							onClick={() => setActiveCategory("all")}
							className={`px-2 py-1 text-xs rounded-md border-0 cursor-pointer transition-colors ${
								activeCategory === "all"
									? "bg-vscode-button-background text-vscode-button-foreground"
									: "bg-vscode-editor-background text-vscode-foreground hover:bg-vscode-list-hoverBackground"
							}`}>
							<Tag className="w-3 h-3 inline mr-1" />
							全部
						</button>
						{ALL_CATEGORIES.map((cat) => (
							<button
								key={cat}
								onClick={() => setActiveCategory(cat)}
								className={`px-2 py-1 text-xs rounded-md border-0 cursor-pointer transition-colors ${
									activeCategory === cat
										? "bg-vscode-button-background text-vscode-button-foreground"
										: "bg-vscode-editor-background text-vscode-foreground hover:bg-vscode-list-hoverBackground"
								}`}>
								{CATEGORY_LABELS[cat]}
							</button>
						))}
					</div>
				</div>

				{/* 模型列表（固定高度，可滑动） */}
				<div className="px-4 pb-4">
					<div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
						{filteredModels.map((model) => (
							<div
								key={model.id}
								onDoubleClick={() =>
									vscode.postMessage({
										type: "neuralAgentShowModelDetail",
										values: {
											id: model.id,
											size: model.size,
											vram: model.vram,
											description: model.description,
											speed: model.speed,
											quality: model.quality,
											category: model.category,
											stars: model.stars,
										},
									})
								}
								className="px-3 py-2 rounded-md border border-vscode-panel-border hover:bg-vscode-list-hoverBackground transition-colors cursor-pointer select-none">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2 min-w-0">
										<code className="text-xs px-1.5 py-0.5 rounded bg-vscode-textCodeBlock-background flex-shrink-0">
											{model.id}
										</code>
										{model.stars && (
											<span className="text-yellow-400 text-xs flex-shrink-0">
												{"★".repeat(model.stars)}
											</span>
										)}
									</div>
									<span className="text-xs text-vscode-descriptionForeground flex-shrink-0 ml-2">
										{model.size}
									</span>
								</div>
								<div className="text-xs text-vscode-descriptionForeground mt-1">
									{model.description}
								</div>
								<div className="flex gap-3 mt-1">
									<span className="text-xs">
										速度：<strong className={speedColor(model.speed)}>{model.speed}</strong>
									</span>
									<span className="text-xs">
										质量：<strong className={qualityColor(model.quality)}>{model.quality}</strong>
									</span>
									<span className="text-xs">显存：{model.vram}</span>
								</div>
							</div>
						))}
						{filteredModels.length === 0 && (
							<div className="text-center py-6 text-sm text-vscode-descriptionForeground">
								没有匹配的模型
							</div>
						)}
					</div>
				</div>

				{/* ═══════ 运行平台安装 ═══════ */}
				<div className="px-4 pb-4">
					<h3 className="text-sm font-medium m-0 mb-2 flex items-center gap-1.5">
						<Download className="w-4 h-4" />
						一键安装运行平台
					</h3>
					<div className="text-xs text-vscode-descriptionForeground mb-3">
						点击「安装」将在终端中执行安装命令。安装完成后，在设置中填入对应的服务地址即可使用。
					</div>
					<div className="space-y-2">
						{PLATFORMS.map((platform) => (
							<div
								key={platform.name}
								className="px-3 py-2.5 rounded-md border border-vscode-panel-border hover:bg-vscode-list-hoverBackground transition-colors">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<span className="text-base">{platform.icon}</span>
										<span className="font-medium text-sm">{platform.name}</span>
										<span className="text-xs text-vscode-descriptionForeground">
											端口 {platform.defaultPort}
										</span>
									</div>
									<Button
										variant="ghost"
										className="h-7 px-3 text-xs flex items-center gap-1.5"
										disabled={installingPlatform === platform.name}
										onClick={() => installPlatform(platform)}>
										{installingPlatform === platform.name ? (
											<>
												<Loader2 className="w-3 h-3 animate-spin" />
												安装中...
											</>
										) : (
											<>
												<Terminal className="w-3 h-3" />
												安装
											</>
										)}
									</Button>
								</div>
								<div className="text-xs text-vscode-descriptionForeground mt-1">
									{platform.description}
								</div>
								<div className="text-xs text-vscode-descriptionForeground mt-1 opacity-60 font-mono">
									{platform.installCmd.windows}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	)
}

export default DiscussView
