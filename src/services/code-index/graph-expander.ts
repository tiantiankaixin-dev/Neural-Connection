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

export interface GraphExpansionConfig {
	enabled: boolean
	maxDepth: number
	maxResults: number
	weights: GraphExpansionWeights
}

export const DEFAULT_CONFIG: GraphExpansionConfig = {
	enabled: true,
	maxDepth: 1,
	maxResults: 20,
	weights: DEFAULT_WEIGHTS,
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
	 *
	 * @param directHits Initial vector search results
	 * @returns Combined and ranked results (direct hits + related code)
	 */
	async expand(directHits: VectorStoreSearchResult[]): Promise<ExpandedSearchResult[]> {
		if (!this.config.enabled || directHits.length === 0) {
			return directHits
				.filter((hit) => hit.payload != null)
				.map((hit) => ({
					id: String(hit.id),
					payload: hit.payload!,
					score: hit.score,
					isDirectHit: true,
				}))
		}

		const seen = new Set<string>()
		const allResults: ExpandedSearchResult[] = []

		// Add direct hits first
		for (const hit of directHits) {
			if (!hit.payload) continue
			const id = String(hit.id)
			seen.add(id)
			allResults.push({
				id,
				payload: hit.payload,
				score: hit.score,
				isDirectHit: true,
			})
		}

		// Expand each direct hit
		for (const hit of directHits) {
			if (!hit.payload) continue
			const related = await this.findRelatedBlocks(hit as VectorStoreSearchResult & { payload: Payload })

			for (const rel of related) {
				if (seen.has(rel.id)) continue
				seen.add(rel.id)

				const score = this.computeScore(rel, hit.score)
				allResults.push({
					id: rel.id,
					payload: rel.payload,
					score,
					isDirectHit: false,
					relationType: rel.relationType,
				})
			}
		}

		// Sort by score descending, direct hits first for same score
		allResults.sort((a, b) => {
			if (a.isDirectHit !== b.isDirectHit) {
				return a.isDirectHit ? -1 : 1
			}
			return b.score - a.score
		})

		// Truncate to maxResults
		return allResults.slice(0, this.config.maxResults)
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
	 * Compute the combined score for a related block.
	 *
	 * score = w1 * vectorSimilarity
	 *       + w2 * relationStrength
	 *       + w3 * normalize(pageRank)
	 *       + w4 * normalize(refDensity)
	 */
	private computeScore(
		related: { id: string; payload: Payload; relationType: string },
		parentVectorScore: number,
	): number {
		const w = this.config.weights

		// Relation strength based on type
		const relationWeight = RELATION_WEIGHTS[related.relationType as keyof typeof RELATION_WEIGHTS] || 0.5

		// PageRank (already normalized to [0, 1] by PageRankService)
		const pr = (related.payload.pageRank as number) || 0

		// Reference density (normalize: typical range 0-2, cap at 1)
		const rd = Math.min((related.payload.refDensity as number) || 0, 2) / 2

		// Use parent's vector score as a proxy for semantic relevance
		// (actual re-embedding would be expensive; the parent hit's score indicates
		//  the query is semantically close to this neighborhood)
		const vectorSim = parentVectorScore * 0.8 // Slight discount for indirect match

		return w.vectorSim * vectorSim + w.relation * relationWeight + w.pageRank * pr + w.refDensity * rd
	}
}
