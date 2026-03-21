import { useTranslation } from "react-i18next"

import { ProgressIndicator } from "../ProgressIndicator"

interface InProgressRowProps {
	eventType: "condense_context" | "sliding_window_truncation"
}

/**
 * Displays an in-progress indicator for context management operations.
 * condense_context: subtle grey flickering small text "context summary"
 * sliding_window_truncation: spinner with bold text (original style)
 */
export function InProgressRow({ eventType }: InProgressRowProps) {
	const { t } = useTranslation()

	if (eventType === "condense_context") {
		return (
			<div
				style={{
					fontSize: "11px",
					color: "var(--vscode-descriptionForeground)",
					padding: "2px 0",
					animation: "contextSummaryPulse 1.5s ease-in-out infinite",
				}}>
				<style>{`
					@keyframes contextSummaryPulse {
						0%, 100% { opacity: 0.4; }
						50% { opacity: 1; }
					}
				`}</style>
				context summary…
			</div>
		)
	}

	return (
		<div className="flex items-center gap-2">
			<ProgressIndicator />
			<span className="font-bold text-vscode-foreground">
				{t("chat:contextManagement.truncation.inProgress")}
			</span>
		</div>
	)
}
