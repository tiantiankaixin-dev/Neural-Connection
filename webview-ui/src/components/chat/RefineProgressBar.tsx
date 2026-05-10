import React from "react"

interface RefineProgressBarProps {
	label: string
	current: number
	total: number
	detail?: string
	tone?: "blue" | "purple"
	compact?: boolean
}

export function RefineProgressBar({
	label,
	current,
	total,
	detail,
	tone = "blue",
	compact = false,
}: RefineProgressBarProps) {
	const safeTotal = Math.max(0, Math.floor(total))
	const safeCurrent = safeTotal > 0 ? Math.min(Math.max(0, Math.floor(current)), safeTotal) : 0
	const percentage = safeTotal > 0 ? (safeCurrent / safeTotal) * 100 : 0
	const color = tone === "purple" ? "var(--vscode-charts-purple)" : "var(--vscode-charts-blue)"

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: compact ? 3 : 5, width: "100%" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					fontSize: compact ? 11 : 12,
					color: "var(--vscode-descriptionForeground)",
				}}>
				<span>{label}</span>
				<span style={{ fontFamily: "var(--vscode-editor-font-family)", color: "var(--vscode-foreground)" }}>
					{safeCurrent}/{safeTotal}
				</span>
			</div>
			<div
				style={{
					height: compact ? 5 : 7,
					borderRadius: 999,
					background: "var(--vscode-editorGroup-border)",
					overflow: "hidden",
				}}>
				<div
					style={{
						width: `${percentage}%`,
						height: "100%",
						borderRadius: 999,
						background: color,
						transition: "width 160ms ease-out",
					}}
				/>
			</div>
			{detail && (
				<div style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)", lineHeight: 1.35 }}>
					{detail}
				</div>
			)}
		</div>
	)
}
