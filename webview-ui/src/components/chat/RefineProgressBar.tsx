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
	const progressMax = safeTotal > 0 ? safeTotal : 1
	const className = [
		"refine-progress",
		compact ? "refine-progress--compact" : "",
		tone === "purple" ? "refine-progress--purple" : "refine-progress--blue",
	]
		.filter(Boolean)
		.join(" ")

	return (
		<div className={className}>
			<div className="refine-progress__header">
				<span>{label}</span>
				<span className="refine-progress__count">
					{safeCurrent}/{safeTotal}
				</span>
			</div>
			<progress
				className="refine-progress__bar"
				value={safeCurrent}
				max={progressMax}
				aria-label={`${label} ${safeCurrent}/${safeTotal}`}
			/>
			{detail && <div className="refine-progress__detail">{detail}</div>}
		</div>
	)
}
