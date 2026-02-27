import { vscode } from "@/utils/vscode"
import { Button, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useCallback } from "react"

export const ExportMemoryButton = ({ itemId }: { itemId: string }) => {
	const { t } = useAppTranslation()

	const handleExportClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "exportConversationMemory", text: itemId })
		},
		[itemId],
	)

	return (
		<StandardTooltip content={t("history:exportMemory")}>
			<Button
				data-testid="export-memory"
				variant="ghost"
				size="icon"
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				onClick={handleExportClick}>
				<span className="codicon codicon-archive scale-80" />
			</Button>
		</StandardTooltip>
	)
}
