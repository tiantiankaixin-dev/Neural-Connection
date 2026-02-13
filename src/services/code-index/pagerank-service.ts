/**
 * PageRank Service
 *
 * Builds an in-memory directed graph of code block references using graphology,
 * computes PageRank scores, and writes them back to Qdrant payloads.
 *
 * Inspired by aider's RepoMap: https://github.com/Aider-AI/aider/blob/main/aider/repomap.py
 *
 * Graph structure:
 *   Nodes = Qdrant points (code blocks)
 *   Edges = referencer → definer (weighted by nameQualityMul * sqrt(refCount))
 */
import DirectedGraph from "graphology"
import pagerank from "graphology-metrics/centrality/pagerank"
import { QdrantVectorStore } from "./vector-store/qdrant-client"

// ─── Name quality multiplier (borrowed from aider) ───

/**
 * Compute a quality multiplier for a symbol name.
 * Higher quality names get higher edge weights.
 */
function nameQualityMul(name: string, definerCount: number): number {
	let mul = 1.0

	// Long camelCase/snake_case names are more meaningful
	if (name.length >= 8 && (/[a-z][A-Z]/.test(name) || name.includes("_"))) {
		mul *= 10
	}

	// Names starting with _ are likely private/internal
	if (name.startsWith("_")) {
		mul *= 0.1
	}

	// Names defined in many blocks are generic (e.g. "toString", "constructor")
	if (definerCount >= 5) {
		mul *= 0.1
	}

	return mul
}

// ─── PageRankService ───

export class PageRankService {
	constructor(private readonly qdrantClient: QdrantVectorStore) {}

	/**
	 * Full PageRank computation: scroll all points → build graph → compute → write back.
	 * Should be called after indexing completes.
	 */
	async computeRanks(): Promise<void> {
		console.log("[PageRankService] Starting PageRank computation...")
		const startTime = Date.now()

		// 1. Scroll all points from Qdrant
		const points = await this.qdrantClient.scrollAllPoints()
		if (points.length === 0) {
			console.log("[PageRankService] No points found, skipping PageRank.")
			return
		}
		console.log(`[PageRankService] Loaded ${points.length} points from Qdrant`)

		// 2. Build symbol → definers/referencers maps
		const symbolToDefiners = new Map<string, Set<string>>() // symbol → Set<pointId>
		const symbolToReferencers = new Map<string, Set<string>>() // symbol → Set<pointId>
		const pointRefDensity = new Map<string, number>() // pointId → refDensity

		for (const point of points) {
			const defines: string[] = (point.payload.defines as string[]) || []
			const refs: string[] = (point.payload.refs as string[]) || []
			const refDensity: number = (point.payload.refDensity as number) || 0

			pointRefDensity.set(point.id, refDensity)

			for (const sym of defines) {
				if (!symbolToDefiners.has(sym)) {
					symbolToDefiners.set(sym, new Set())
				}
				symbolToDefiners.get(sym)!.add(point.id)
			}

			for (const sym of refs) {
				if (!symbolToReferencers.has(sym)) {
					symbolToReferencers.set(sym, new Set())
				}
				symbolToReferencers.get(sym)!.add(point.id)
			}
		}

		// 3. Build directed graph
		const graph = new DirectedGraph()

		// Add all points as nodes
		for (const point of points) {
			graph.addNode(point.id)
		}

		// Add edges: referencer → definer
		for (const [symbol, referencers] of symbolToReferencers) {
			const definers = symbolToDefiners.get(symbol)
			if (!definers) continue

			const definerCount = definers.size
			const qualityMul = nameQualityMul(symbol, definerCount)

			for (const referencerId of referencers) {
				const refDensity = pointRefDensity.get(referencerId) || 0

				for (const definerId of definers) {
					// Skip self-references
					if (referencerId === definerId) continue

					const edgeKey = `${referencerId}->${definerId}`
					const weight = qualityMul * (1 + refDensity)

					if (graph.hasEdge(edgeKey)) {
						// Accumulate weight for multiple shared symbols
						const existing = graph.getEdgeAttribute(edgeKey, "weight") || 0
						graph.setEdgeAttribute(edgeKey, "weight", existing + weight)
					} else {
						try {
							graph.addEdgeWithKey(edgeKey, referencerId, definerId, { weight })
						} catch {
							// Edge might already exist via different key (parallel edges)
						}
					}
				}
			}
		}

		console.log(
			`[PageRankService] Graph built: ${graph.order} nodes, ${graph.size} edges`,
		)

		// 4. Compute PageRank
		let ranks: Record<string, number>
		try {
			ranks = pagerank(graph, {
				getEdgeWeight: "weight",
				maxIterations: 100,
				tolerance: 1e-6,
			})
		} catch (error) {
			console.warn("[PageRankService] PageRank computation failed, using uniform ranks:", error)
			ranks = {}
			for (const point of points) {
				ranks[point.id] = 1.0 / points.length
			}
		}

		// 5. Normalize ranks to [0, 1] range
		const maxRank = Math.max(...Object.values(ranks), 1e-10)
		const normalizedRanks: Record<string, number> = {}
		for (const [id, rank] of Object.entries(ranks)) {
			normalizedRanks[id] = rank / maxRank
		}

		// 6. Write PageRank scores back to Qdrant
		const updates = Object.entries(normalizedRanks).map(([id, pr]) => ({
			id,
			payload: { pageRank: pr },
		}))

		await this.qdrantClient.batchUpdatePayloads(updates)

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
		console.log(
			`[PageRankService] PageRank completed in ${elapsed}s. Top score: ${maxRank.toFixed(6)}`,
		)
	}
}
