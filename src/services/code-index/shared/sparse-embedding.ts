/**
 * Sparse Embedding Generator for Hybrid Search
 *
 * Generates BM25-style sparse vectors from code blocks using feature hashing.
 * Each code block is tokenized into identifiers (class names, method names,
 * variable names, file path segments) and mapped to sparse vector indices
 * via a deterministic hash function.
 *
 * The sparse vectors complement dense semantic vectors by providing exact
 * keyword matching capability. Combined via Reciprocal Rank Fusion (RRF)
 * in Qdrant, this yields hybrid search that understands both meaning and
 * exact identifiers.
 */

export interface SparseVector {
	indices: number[]
	values: number[]
}

// Maximum sparse vector dimension (Qdrant uses u32 indices)
const MAX_DIM = 1 << 30

/**
 * Deterministic hash function mapping a token string to a sparse vector index.
 * Uses FNV-1a for good distribution and speed.
 */
function tokenHash(token: string): number {
	let hash = 0x811c9dc5 // FNV offset basis
	for (let i = 0; i < token.length; i++) {
		hash ^= token.charCodeAt(i)
		hash = (hash * 0x01000193) | 0 // FNV prime
	}
	return Math.abs(hash) % MAX_DIM
}

/**
 * Split an identifier into sub-tokens by camelCase / PascalCase / snake_case
 * boundaries. Returns lowercase tokens.
 *
 * Examples:
 *   "GameManager"    → ["game", "manager"]
 *   "handlePlayerDeath" → ["handle", "player", "death"]
 *   "MAX_STACK_SIZE" → ["max", "stack", "size"]
 *   "OnSingletonAwake" → ["on", "singleton", "awake"]
 */
export function splitIdentifier(name: string): string[] {
	if (!name || name.length === 0) return []

	// Replace underscores with spaces, then split on camelCase boundaries
	const withSpaces = name
		.replace(/_+/g, " ")
		// Insert space before uppercase letter preceded by lowercase
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		// Insert space before uppercase letter followed by lowercase when preceded by uppercase
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")

	return withSpaces
		.split(/\s+/)
		.map((t) => t.toLowerCase().trim())
		.filter((t) => t.length >= 2) // Skip single-char tokens
}

/**
 * Tokenize a code block into weighted terms for sparse embedding.
 * Returns a map of token → accumulated weight.
 *
 * Weighting strategy:
 *   - defines (class/method names this block declares): weight 2.0
 *   - refs (symbols this block references): weight 1.0
 *   - className / classExtends: weight 1.5
 *   - file path segments: weight 0.5
 *   - code content tokens (identifiers in raw code): weight 0.3
 */
export function tokenizeBlock(block: {
	filePath: string
	content: string
	defines?: string[]
	refs?: string[]
	className?: string | null
	classExtends?: string | null
}): Map<string, number> {
	const weights = new Map<string, number>()

	const addToken = (token: string, weight: number) => {
		if (token.length < 2) return
		const lc = token.toLowerCase()
		weights.set(lc, (weights.get(lc) || 0) + weight)
	}

	const addIdentifier = (name: string, weight: number) => {
		// Add full identifier
		addToken(name, weight)
		// Add sub-tokens
		for (const part of splitIdentifier(name)) {
			addToken(part, weight * 0.5)
		}
	}

	// 1. defines — highest weight (what this block declares)
	if (block.defines) {
		for (const def of block.defines) {
			addIdentifier(def, 2.0)
		}
	}

	// 2. refs — medium weight (what this block uses)
	if (block.refs) {
		for (const ref of block.refs) {
			addIdentifier(ref, 1.0)
		}
	}

	// 3. className / classExtends
	if (block.className) {
		addIdentifier(block.className, 1.5)
	}
	if (block.classExtends) {
		addIdentifier(block.classExtends, 1.5)
	}

	// 4. File path segments
	const pathParts = block.filePath.replace(/\\/g, "/").split("/").filter(Boolean)
	for (const part of pathParts) {
		// Strip extension from last segment
		const name = part.replace(/\.[^.]+$/, "")
		addToken(name, 0.5)
		for (const sub of splitIdentifier(name)) {
			addToken(sub, 0.25)
		}
	}

	// 5. Code content — extract identifiers from raw code
	const codeIdentifiers = block.content.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)
	if (codeIdentifiers) {
		const seen = new Set<string>()
		for (const ident of codeIdentifiers) {
			const lc = ident.toLowerCase()
			if (seen.has(lc)) continue
			seen.add(lc)
			addIdentifier(ident, 0.3)
		}
	}

	return weights
}

/**
 * Convert a token weight map into a Qdrant-compatible sparse vector
 * using feature hashing.
 */
export function buildSparseVector(weights: Map<string, number>): SparseVector {
	if (weights.size === 0) {
		return { indices: [], values: [] }
	}

	// Hash tokens to indices, accumulating weights for collisions
	const indexMap = new Map<number, number>()
	for (const [token, weight] of weights) {
		const idx = tokenHash(token)
		indexMap.set(idx, (indexMap.get(idx) || 0) + weight)
	}

	// Sort by index for Qdrant compatibility
	const entries = Array.from(indexMap.entries()).sort((a, b) => a[0] - b[0])

	return {
		indices: entries.map(([idx]) => idx),
		values: entries.map(([, val]) => val),
	}
}

/**
 * Generate a sparse embedding for a code block.
 * This is the main entry point used by scanner and file-watcher.
 */
export function generateSparseEmbedding(block: {
	filePath: string
	content: string
	defines?: string[]
	refs?: string[]
	className?: string | null
	classExtends?: string | null
}): SparseVector {
	const weights = tokenizeBlock(block)
	return buildSparseVector(weights)
}

/**
 * Generate a sparse embedding for a search query.
 * Uses uniform weighting since we don't have structural metadata for queries.
 */
export function generateQuerySparseEmbedding(query: string): SparseVector {
	const weights = new Map<string, number>()

	const addToken = (token: string, weight: number) => {
		if (token.length < 2) return
		const lc = token.toLowerCase()
		weights.set(lc, (weights.get(lc) || 0) + weight)
	}

	// Extract identifiers from query
	const identifiers = query.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)
	if (identifiers) {
		for (const ident of identifiers) {
			// Full identifier
			addToken(ident, 1.5)
			// Sub-tokens
			for (const part of splitIdentifier(ident)) {
				addToken(part, 0.75)
			}
		}
	}

	// Also add raw words (for natural language parts of query)
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length >= 2)
	for (const word of words) {
		addToken(word, 0.5)
	}

	return buildSparseVector(weights)
}
