/**
 * Graph Expander Service
 *
 * After vector search returns initial hits, this service expands the result set
 * by traversing the code graph (defines/refs/className/classExtends relationships)
 * and ranks all results using a combined scoring formula incorporating:
 *   - Vector similarity (semantic relevance)
 *   - Relation strength (calls > sameClass > extends)
 *   - PageRank (global importance)
 *   - Reference density (hub/orchestrator code)
 */
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { VectorStoreSearchResult, Payload } from "./interfaces"

// ─── Relation type weights ───

const RELATION_WEIGHTS = {
	calls: 1.0, // refs → defines (direct call/usage)
	calledBy: 0.9, // defines → refs (who calls me)
	sameClass: 0.7, // same className
	extends: 0.5, // classExtends relationship
}

// ─── Default scoring weights ───

export interface GraphExpansionWeights {
	vectorSim: number
	relation: number
	pageRank: number
	refDensity: number
}

export const DEFAULT_WEIGHTS: GraphExpansionWeights = {
	vectorSim: 0.4,
	relation: 0.25,
	pageRank: 0.25,
	refDensity: 0.1,
}

// Direct hit scoring weights (vector similarity dominant, PageRank/refDensity as boosters)
export interface DirectHitWeights {
	vectorSim: number
	pageRank: number
	refDensity: number
}

export const DEFAULT_DIRECT_WEIGHTS: DirectHitWeights = {
	vectorSim: 0.7,
	pageRank: 0.2,
	refDensity: 0.1,
}

export interface GraphExpansionConfig {
	enabled: boolean
	maxDepth: number
	maxResults: number
	maxRelatedPerFile: number
	weights: GraphExpansionWeights
	directWeights: DirectHitWeights
}

export const DEFAULT_CONFIG: GraphExpansionConfig = {
	enabled: true,
	maxDepth: 1,
	maxResults: 15,
	maxRelatedPerFile: 2,
	weights: DEFAULT_WEIGHTS,
	directWeights: DEFAULT_DIRECT_WEIGHTS,
}

// ─── Expanded result type ───

export interface ExpandedSearchResult {
	id: string
	payload: Payload
	score: number
	isDirectHit: boolean
	relationType?: string
}

// ─── GraphExpander ───

export class GraphExpander {
	private config: GraphExpansionConfig

	constructor(
		private readonly qdrantClient: QdrantVectorStore,
		config?: Partial<GraphExpansionConfig>,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	/**
	 * Update configuration (e.g., from user settings).
	 */
	updateConfig(config: Partial<GraphExpansionConfig>): void {
		this.config = { ...this.config, ...config }
	}

	/**
	 * Expand vector search results by traversing the code graph.
	 * Optionally supplements with keyword-based payload filter search.
	 *
	 * @param directHits Initial vector search results
	 * @param query Original search query (for keyword supplementation)
	 * @param queryVector Query embedding vector (for relation vector search)
	 * @returns Combined and ranked results (direct hits + related code)
	 */
	async expand(
		directHits: VectorStoreSearchResult[],
		query?: string,
		queryVector?: number[],
	): Promise<ExpandedSearchResult[]> {
		if (!this.config.enabled || directHits.length === 0) {
			console.log(`[GraphExpander] Skipped: enabled=${this.config.enabled}, hits=${directHits.length}`)
			return directHits
				.filter((hit) => hit.payload != null)
				.map((hit) => ({
					id: String(hit.id),
					payload: hit.payload!,
					score: this.computeDirectHitScore(hit.score, hit.payload!, query),
					isDirectHit: true,
				}))
		}

		console.log(`[GraphExpander] Expanding ${directHits.length} direct hits...`)

		const seen = new Set<string>()
		const allResults: ExpandedSearchResult[] = []

		// Add direct hits first (re-scored with PageRank + refDensity)
		for (const hit of directHits) {
			if (!hit.payload) continue
			const id = String(hit.id)
			seen.add(id)
			allResults.push({
				id,
				payload: hit.payload,
				score: this.computeDirectHitScore(hit.score, hit.payload, query),
				isDirectHit: true,
			})
		}

		// Expand each direct hit
		let totalRelated = 0
		for (const hit of directHits) {
			if (!hit.payload) continue
			const p = hit.payload
			const defs = (p.defines as string[]) || []
			const refs = (p.refs as string[]) || []
			const cn = p.className as string | null
			const ce = p.classExtends as string | null
			console.log(
				`[GraphExpander]   Hit ${p.filePath}:${p.startLine}-${p.endLine} → defines=${defs.length}, refs=${refs.length}, className=${cn || "null"}, classExtends=${ce || "null"}, pageRank=${p.pageRank ?? "undefined"}`,
			)
			const related = await this.findRelatedBlocks(hit as VectorStoreSearchResult & { payload: Payload })

			totalRelated += related.length
			let added = 0
			for (const rel of related) {
				if (seen.has(rel.id)) continue
				seen.add(rel.id)
				added++

				const score = this.computeScore(rel, hit.score)
				allResults.push({
					id: rel.id,
					payload: rel.payload,
					score,
					isDirectHit: false,
					relationType: rel.relationType,
				})
			}
			if (related.length > 0) {
				console.log(
					`[GraphExpander]     → found ${related.length} related, added ${added} new (${related.length - added} deduped)`,
				)
			}
		}

		// ── Keyword supplement: extract identifiers from query, search by payload filter ──
		if (query) {
			const identifiers = GraphExpander.extractIdentifiers(query)
			if (identifiers.length > 0) {
				console.log(`[GraphExpander] Keyword supplement: identifiers=[${identifiers.join(", ")}]`)
				let keywordAdded = 0

				const KEYWORD_BASE_SCORE = 0.65

				// Search defines for identifiers
				const defHits = await this.qdrantClient.findBlocksByDefines(identifiers, 10)
				for (const hit of defHits) {
					const id = String(hit.id)
					if (seen.has(id) || !hit.payload) continue
					seen.add(id)
					keywordAdded++
					allResults.push({
						id,
						payload: hit.payload,
						score: this.computeDirectHitScore(KEYWORD_BASE_SCORE, hit.payload),
						isDirectHit: true,
						relationType: "keywordMatch",
					})
				}

				// Search className for identifiers
				for (const ident of identifiers) {
					const classHits = await this.qdrantClient.findBlocksByClassName(ident, 5)
					for (const hit of classHits) {
						const id = String(hit.id)
						if (seen.has(id) || !hit.payload) continue
						seen.add(id)
						keywordAdded++
						allResults.push({
							id,
							payload: hit.payload,
							score: this.computeDirectHitScore(KEYWORD_BASE_SCORE, hit.payload),
							isDirectHit: true,
							relationType: "keywordMatch",
						})
					}
				}

				// Search classExtends for identifiers (find classes that extend a matched class)
				for (const ident of identifiers) {
					const extendsHits = await this.qdrantClient.findBlocksByClassExtends(ident, 5)
					for (const hit of extendsHits) {
						const id = String(hit.id)
						if (seen.has(id) || !hit.payload) continue
						seen.add(id)
						keywordAdded++
						allResults.push({
							id,
							payload: hit.payload,
							score: this.computeDirectHitScore(KEYWORD_BASE_SCORE * 0.9, hit.payload),
							isDirectHit: true,
							relationType: "keywordMatch",
						})
					}
				}

				if (keywordAdded > 0) {
					console.log(`[GraphExpander] Keyword supplement added ${keywordAdded} new blocks`)
				}
			}
		}

		// ── Relation vector search: find blocks whose relationship context matches the query ──
		if (queryVector) {
			try {
				const relationHits = await this.qdrantClient.searchRelationVectors(
					queryVector,
					undefined, // no directory filter
					0.35, // lower threshold to catch more relation matches
					30, // fetch more candidates, will be deduplicated and capped
				)
				let relationAdded = 0
				for (const hit of relationHits) {
					const id = String(hit.id)
					if (seen.has(id) || !hit.payload) continue
					seen.add(id)
					relationAdded++

					allResults.push({
						id,
						payload: hit.payload,
						score: hit.score, // raw relation vector similarity
						isDirectHit: false,
						relationType: "relationVector",
					})
				}
				if (relationAdded > 0) {
					console.log(`[GraphExpander] Relation vector search added ${relationAdded} new blocks`)
				}
			} catch (error) {
				console.warn("[GraphExpander] Relation vector search failed (may be legacy collection):", error)
			}
		}

		console.log(
			`[GraphExpander] Expansion complete: ${directHits.length} direct + ${allResults.length - directHits.length} related = ${allResults.length} total`,
		)

		// Phase 2: Rerank all results by applying PageRank/refDensity as a
		// multiplicative boost. This ensures selection is purely semantic,
		// while structurally important code (highly referenced) ranks higher
		// among semantically similar results.
		const dw = this.config.directWeights
		for (const result of allResults) {
			const pr = (result.payload.pageRank as number) || 0
			const rd = Math.min((result.payload.refDensity as number) || 0, 2) / 2
			result.score = result.score * (1 + dw.pageRank * pr + dw.refDensity * rd)
		}

		// Separate direct hits and related, sort each by score, then combine
		const directs = allResults.filter((r) => r.isDirectHit).sort((a, b) => b.score - a.score)
		const relatedSorted = allResults.filter((r) => !r.isDirectHit).sort((a, b) => b.score - a.score)

		// Per-file dedup: limit related blocks per file to avoid one file
		// dominating Related results (e.g., InventoryManager calledBy ×5)
		const maxPerFile = this.config.maxRelatedPerFile
		const fileCount = new Map<string, number>()
		const related: ExpandedSearchResult[] = []
		for (const r of relatedSorted) {
			const fp = (r.payload.filePath as string) || ""
			const count = fileCount.get(fp) || 0
			if (count < maxPerFile) {
				related.push(r)
				fileCount.set(fp, count + 1)
			}
		}

		// Allocate slots: direct hits get maxResults, related get maxResults
		const maxR = this.config.maxResults
		return [...directs.slice(0, maxR), ...related.slice(0, maxR)]
	}

	/**
	 * Find related code blocks for a given hit by traversing its relations.
	 */
	private async findRelatedBlocks(
		hit: VectorStoreSearchResult & { payload: Payload },
	): Promise<Array<{ id: string; payload: Payload; relationType: string }>> {
		const results: Array<{ id: string; payload: Payload; relationType: string }> = []
		const payload = hit.payload

		// 1. refs → find definers (what does this block call/reference?)
		const refs = (payload.refs as string[]) || []
		if (refs.length > 0) {
			const definers = await this.qdrantClient.findBlocksByDefines(refs, 10)
			for (const d of definers) {
				if (!d.payload) continue
				results.push({ id: String(d.id), payload: d.payload, relationType: "calls" })
			}
		}

		// 2. defines → find referencers (who calls/references this block?)
		const defines = (payload.defines as string[]) || []
		if (defines.length > 0) {
			const referencers = await this.qdrantClient.findBlocksByRefs(defines, 10)
			for (const r of referencers) {
				if (!r.payload) continue
				results.push({ id: String(r.id), payload: r.payload, relationType: "calledBy" })
			}
		}

		// 3. className → same class methods
		const className = payload.className as string | null
		if (className) {
			const sameClass = await this.qdrantClient.findBlocksByClassName(className, 10)
			for (const s of sameClass) {
				if (!s.payload) continue
				results.push({ id: String(s.id), payload: s.payload, relationType: "sameClass" })
			}
		}

		// 4. classExtends → parent class blocks
		const classExtends = payload.classExtends as string | null
		if (classExtends) {
			const parentBlocks = await this.qdrantClient.findBlocksByDefines([classExtends], 5)
			for (const p of parentBlocks) {
				if (!p.payload) continue
				results.push({ id: String(p.id), payload: p.payload, relationType: "extends" })
			}
		}

		return results
	}

	/**
	 * Extract potential identifier names (class names, function names, symbols)
	 * from a natural language query. Used for keyword-based supplement search.
	 */
	static extractIdentifiers(query: string): string[] {
		const identifiers: Set<string> = new Set()

		// Match PascalCase identifiers (e.g., GameManager, PlayerController)
		const pascalCase = query.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)
		if (pascalCase) pascalCase.forEach((m) => identifiers.add(m))

		// Match camelCase identifiers (e.g., updateGameState, onPlayerDeath)
		const camelCase = query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)
		if (camelCase) camelCase.forEach((m) => identifiers.add(m))

		// Match snake_case identifiers (e.g., game_manager, update_state)
		const snakeCase = query.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)
		if (snakeCase) snakeCase.forEach((m) => identifiers.add(m))

		// Match UPPER_CASE constants (e.g., MAX_HEALTH, PLAYER_SPEED)
		const upperCase = query.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)
		if (upperCase) upperCase.forEach((m) => identifiers.add(m))

		// Match capitalized words that may be class/type names (e.g., Singleton, Manager)
		// Must be 4+ chars to skip noise like "The", "For"
		const capitalizedWords = query.match(/\b[A-Z][a-z]{3,}\b/g)
		if (capitalizedWords) capitalizedWords.forEach((m) => identifiers.add(m))

		return Array.from(identifiers)
	}

	/**
	 * Compute the score for a direct hit.
	 * Vector similarity is dominant; PageRank and refDensity act as boosters
	 * to promote structurally important code when semantic scores are close.
	 */
	private computeDirectHitScore(vectorScore: number, payload: Payload, query?: string): number {
		const dw = this.config.directWeights
		const pr = (payload.pageRank as number) || 0
		const rd = Math.min((payload.refDensity as number) || 0, 2) / 2

		// Query-path relevance boost: reward results whose file path or className
		// contains words from the query (e.g., query "PlayerController" boosts
		// files in Scripts/Player/ with className PlayerController)
		let pathBoost = 0
		if (query) {
			const queryLower = query.toLowerCase()
			// Split query into meaningful words (3+ chars to skip noise like "the", "and")
			const queryWords = queryLower.split(/\s+/).filter((w) => w.length >= 3)
			// Split file path into segments
			const pathSegments = ((payload.filePath as string) || "")
				.toLowerCase()
				.split(/[\\/._\-]/)
				.filter((s) => s.length >= 2)
			// Split className into words (e.g., "PlayerController" → ["player", "controller"])
			const classWords = ((payload.className as string) || "")
				.split(/(?=[A-Z])/)
				.map((w) => w.toLowerCase())
				.filter((w) => w.length >= 2)
			const allTargetWords = [...pathSegments, ...classWords]

			let matches = 0
			for (const qw of queryWords) {
				if (allTargetWords.some((tw) => tw.includes(qw) || qw.includes(tw))) {
					matches++
				}
			}
			// Up to 0.15 boost, scaled by match ratio
			if (queryWords.length > 0) {
				pathBoost = Math.min(matches / queryWords.length, 1) * 0.15
			}
		}

		// Phase 1: Pure semantic relevance (vector similarity + path match)
		// PageRank/refDensity are applied later in the reranking phase
		return vectorScore + pathBoost
	}

	/**
	 * Compute the combined score for a related block.
	 *
	 * Phase 1: score = w1 * vectorSimilarity + w2 * relationStrength
	 * (PageRank/refDensity applied uniformly in Phase 2 reranking)
	 */
	private computeScore(
		related: { id: string; payload: Payload; relationType: string },
		parentVectorScore: number,
	): number {
		const w = this.config.weights

		// Relation strength based on type
		const relationWeight = RELATION_WEIGHTS[related.relationType as keyof typeof RELATION_WEIGHTS] || 0.5

		// Use parent's vector score as a proxy for semantic relevance
		// (actual re-embedding would be expensive; the parent hit's score indicates
		//  the query is semantically close to this neighborhood)
		const vectorSim = parentVectorScore * 0.8 // Slight discount for indirect match

		return w.vectorSim * vectorSim + w.relation * relationWeight
	}
}
