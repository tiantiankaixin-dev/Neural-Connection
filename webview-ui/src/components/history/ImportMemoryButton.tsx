import { vscode } from "@/utils/vscode"
import { Button, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useCallback } from "react"

export const ImportMemoryButton = ({ itemId }: { itemId: string }) => {
	const { t } = useAppTranslation()

	const handleImportClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			vscode.postMessage({ type: "importConversationMemory", text: itemId })
		},
		[itemId],
	)

	return (
		<StandardTooltip content={t("history:importMemory")}>
			<Button
				data-testid="import-memory"
				variant="ghost"
				size="icon"
				className="group-hover:opacity-100 opacity-50 transition-opacity"
				onClick={handleImportClick}>
				<span className="codicon codicon-cloud-download scale-80" />
			</Button>
		</StandardTooltip>
	)
}
