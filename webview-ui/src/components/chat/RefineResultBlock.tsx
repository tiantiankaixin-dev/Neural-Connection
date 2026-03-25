import React, { useState } from "react"
import { ChevronRight, ChevronDown, FileCode2, Wand2 } from "lucide-react"
import MarkdownBlock from "../common/MarkdownBlock"

interface PlanEntry {
	filePath: string
	content: string
}

interface RefineResultData {
	todoItemId: string
	todoContent: string
	plans: PlanEntry[]
}

interface RefineResultBlockProps {
	data: RefineResultData
}

const RefineResultBlock: React.FC<RefineResultBlockProps> = ({ data }) => {
	const [isExpanded, setIsExpanded] = useState(false)
	const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set())

	const toggleFile = (index: number) => {
		setExpandedFiles((prev) => {
			const next = new Set(prev)
			if (next.has(index)) {
				next.delete(index)
			} else {
				next.add(index)
			}
			return next
		})
	}

	return (
		<div
			style={{
				borderRadius: 6,
				border: "1px solid var(--vscode-editorGroup-border)",
				background: "var(--vscode-editor-background)",
				overflow: "hidden",
			}}>
			{/* Header - always visible */}
			<div
				onClick={() => setIsExpanded(!isExpanded)}
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "6px 10px",
					cursor: "pointer",
					userSelect: "none",
					fontSize: 13,
					color: "var(--vscode-foreground)",
				}}>
				{isExpanded ? (
					<ChevronDown className="size-3.5" style={{ flexShrink: 0 }} />
				) : (
					<ChevronRight className="size-3.5" style={{ flexShrink: 0 }} />
				)}
				<Wand2 className="size-3.5" style={{ flexShrink: 0, color: "var(--vscode-charts-blue)" }} />
				<span style={{ fontWeight: 500 }}>task_optimize</span>
				<span style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12 }}>
					{data.todoContent} · {data.plans.length} file(s)
				</span>
			</div>

			{/* Expanded content */}
			{isExpanded && (
				<div style={{ borderTop: "1px solid var(--vscode-editorGroup-border)" }}>
					{data.plans.map((plan, index) => (
						<div
							key={index}
							style={{
								borderBottom:
									index < data.plans.length - 1
										? "1px solid var(--vscode-editorGroup-border)"
										: undefined,
							}}>
							{/* File header */}
							<div
								onClick={() => toggleFile(index)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "5px 10px 5px 20px",
									cursor: "pointer",
									userSelect: "none",
									fontSize: 12,
									color: "var(--vscode-foreground)",
								}}>
								{expandedFiles.has(index) ? (
									<ChevronDown className="size-3" style={{ flexShrink: 0 }} />
								) : (
									<ChevronRight className="size-3" style={{ flexShrink: 0 }} />
								)}
								<FileCode2
									className="size-3"
									style={{ flexShrink: 0, color: "var(--vscode-descriptionForeground)" }}
								/>
								<span style={{ fontFamily: "var(--vscode-editor-font-family)", opacity: 0.9 }}>
									{plan.filePath}
								</span>
							</div>

							{/* File plan content */}
							{expandedFiles.has(index) && (
								<div
									style={{
										padding: "4px 14px 8px 36px",
										fontSize: 12,
										color: "var(--vscode-foreground)",
									}}>
									<MarkdownBlock markdown={plan.content} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

export default RefineResultBlock
