/**
 * Condense Module (DISABLED)
 *
 * All context compression and summarization functionality has been removed.
 * This module is kept as a stub for backward compatibility with existing imports.
 */

import { ApiMessage } from "../task-persistence/apiMessages"

/**
 * Cleans up orphaned condenseParent and truncationParent references after a rewind/delete.
 * Kept for backward compatibility with message-manager rewind operations on existing histories.
 */
export function cleanupAfterTruncation(messages: ApiMessage[]): ApiMessage[] {
	const existingSummaryIds = new Set<string>()
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	return messages.map((msg) => {
		let needsUpdate = false
		if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
			needsUpdate = true
		}
		if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
			needsUpdate = true
		}
		if (needsUpdate) {
			const { condenseParent, truncationParent, ...rest } = msg
			const result: ApiMessage = rest as ApiMessage
			if (condenseParent && existingSummaryIds.has(condenseParent)) {
				result.condenseParent = condenseParent
			}
			if (truncationParent && existingTruncationIds.has(truncationParent)) {
				result.truncationParent = truncationParent
			}
			return result
		}
		return msg
	})
}
