import { useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"
import { FoldVertical } from "lucide-react"

import type { ContextCondense } from "@roo-code/types"

interface DetailTurn {
	turnNumber: number
	todoItemContent?: string
	reason?: string
	assistantMessage: string
	toolNames: string[]
}

interface CondenseDetail {
	content: string
	turns?: DetailTurn[]
	contextSummaryText?: string
}

function parseCondenseDetail(text?: string): CondenseDetail | undefined {
	if (!text) return undefined
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed.content === "string") {
			return parsed as CondenseDetail
		}
	} catch {
		// not JSON
	}
	return undefined
}

function ExpandableTurn({ turn }: { turn: DetailTurn }) {
	const [expanded, setExpanded] = useState(false)
	const label = turn.todoItemContent ? `Turn ${turn.turnNumber} [${turn.todoItemContent}]` : `Turn ${turn.turnNumber}`

	return (
		<div style={{ marginTop: 2 }}>
			<div
				style={{
					fontSize: "10px",
					color: "var(--vscode-descriptionForeground)",
					opacity: 0.85,
					cursor: "pointer",
					display: "flex",
					alignItems: "center",
					gap: "3px",
					userSelect: "none",
				}}
				onClick={(e) => {
					e.stopPropagation()
					setExpanded(!expanded)
				}}>
				<span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} style={{ fontSize: 9 }} />
				<span style={{ fontWeight: 500 }}>{label}</span>
				{turn.reason && <span style={{ opacity: 0.6, marginLeft: 4 }}>— {turn.reason}</span>}
			</div>
			{expanded && (
				<div
					style={{
						fontSize: "11px",
						color: "var(--vscode-descriptionForeground)",
						opacity: 0.7,
						marginTop: 3,
						marginLeft: 12,
						padding: "6px 8px",
						background: "var(--vscode-textBlockQuote-background)",
						borderRadius: 4,
						whiteSpace: "pre-wrap",
						lineHeight: 1.4,
						maxHeight: "60vh",
						overflowY: "auto",
					}}>
					{turn.assistantMessage || "(empty)"}
					{turn.toolNames.length > 0 && (
						<div style={{ marginTop: 4, opacity: 0.6, fontSize: "10px" }}>
							Tools: {turn.toolNames.join(", ")}
						</div>
					)}
				</div>
			)}
		</div>
	)
}

interface CondensationResultRowProps {
	data: ContextCondense
	detailText?: string
}

/**
 * Displays the result of a successful context condensation operation.
 * Shows token reduction, and expandable backpack turns + context summary.
 */
export function CondensationResultRow({ data, detailText }: CondensationResultRowProps) {
	const { t } = useTranslation()
	const [refsExpanded, setRefsExpanded] = useState(false)
	const [summaryExpanded, setSummaryExpanded] = useState(false)

	const { cost, prevContextTokens, newContextTokens } = data
	const detail = parseCondenseDetail(detailText)

	// Handle null/undefined token values to prevent crashes
	const prevTokens = prevContextTokens ?? 0
	const newTokens = newContextTokens ?? 0
	const displayCost = cost ?? 0

	const hasTurns = detail?.turns && detail.turns.length > 0
	const hasSummary = !!detail?.contextSummaryText?.trim()

	return (
		<div>
			<div
				style={{
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground)",
					padding: "2px 0",
					fontWeight: 500,
					display: "flex",
					alignItems: "center",
					gap: "4px",
				}}>
				<FoldVertical size={12} />
				<span>{detail?.content || t("chat:contextManagement.condensation.title")}</span>
				{(prevTokens > 0 || newTokens > 0) && (
					<span style={{ opacity: 0.7 }}>
						({prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
						{t("chat:contextManagement.tokens")})
					</span>
				)}
				{displayCost > 0 && <VSCodeBadge>${displayCost.toFixed(2)}</VSCodeBadge>}
			</div>
			{hasTurns && (
				<div style={{ marginLeft: 14, marginTop: 2 }}>
					<div
						style={{
							fontSize: "10px",
							color: "var(--vscode-descriptionForeground)",
							opacity: 0.8,
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							gap: "3px",
							userSelect: "none",
						}}
						onClick={(e) => {
							e.stopPropagation()
							setRefsExpanded(!refsExpanded)
						}}>
						<span
							className={`codicon codicon-chevron-${refsExpanded ? "down" : "right"}`}
							style={{ fontSize: 9 }}
						/>
						{`已引用 ${detail!.turns!.length} 条历史消息`}
					</div>
					{refsExpanded && (
						<div style={{ marginLeft: 4, marginTop: 2 }}>
							{detail!.turns!.map((turn, idx) => (
								<ExpandableTurn key={idx} turn={turn} />
							))}
						</div>
					)}
				</div>
			)}
			{hasSummary && (
				<div style={{ marginLeft: 14, marginTop: hasTurns ? 3 : 2 }}>
					<div
						style={{
							fontSize: "10px",
							color: "var(--vscode-descriptionForeground)",
							opacity: 0.8,
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							gap: "3px",
							userSelect: "none",
						}}
						onClick={(e) => {
							e.stopPropagation()
							setSummaryExpanded(!summaryExpanded)
						}}>
						<span
							className={`codicon codicon-chevron-${summaryExpanded ? "down" : "right"}`}
							style={{ fontSize: 9 }}
						/>
						{"上下文概要"}
					</div>
					{summaryExpanded && (
						<div
							style={{
								fontSize: "11px",
								color: "var(--vscode-descriptionForeground)",
								opacity: 0.7,
								marginTop: 3,
								marginLeft: 12,
								padding: "6px 8px",
								background: "var(--vscode-textBlockQuote-background)",
								borderRadius: 4,
								whiteSpace: "pre-wrap",
								lineHeight: 1.4,
								maxHeight: "60vh",
								overflowY: "auto",
							}}>
							{detail!.contextSummaryText}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
