/**
 * Extract file paths from a todo item's content string.
 * Looks for patterns like "src/path/file.ts" or "packages/core/src/index.ts".
 * These are the files that the todo item "owns" for file ownership enforcement.
 */
export function extractFilePathsFromTodoContent(content: string): string[] {
	const paths: string[] = []
	// Match common file path patterns: sequences of word chars, dots, slashes, hyphens
	// that look like relative file paths (contain at least one / and a . extension)
	const pathRegex = /[\w./-]+\.\w{1,10}/g
	let match: RegExpExecArray | null
	while ((match = pathRegex.exec(content)) !== null) {
		const candidate = match[0]
		// Must contain at least one slash to be a relative path
		if (candidate.includes("/")) {
			paths.push(candidate)
		}
	}
	return paths
}

/**
 * Check if a file path is owned by the task (i.e., is in the ownedFiles list).
 * Returns true if the task has no file ownership restrictions (ownedFiles is undefined/empty),
 * or if the file path matches one of the owned files.
 */
export function isFileOwnedByTask(filePath: string, ownedFiles: string[] | undefined): boolean {
	if (!ownedFiles || ownedFiles.length === 0) {
		return true // No restrictions
	}

	// Normalize both paths for comparison
	const normalizedTarget = filePath.replace(/\\/g, "/").toLowerCase()
	return ownedFiles.some((owned) => {
		const normalizedOwned = owned.replace(/\\/g, "/").toLowerCase()
		// Allow if the target path ends with the owned path, or vice versa
		return normalizedTarget.endsWith(normalizedOwned) || normalizedOwned.endsWith(normalizedTarget)
	})
}
