import * as path from "path"
import { VectorStoreSearchResult } from "./interfaces"
import { IEmbedder } from "./interfaces/embedder"
import { IVectorStore } from "./interfaces/vector-store"
import { CodeIndexConfigManager } from "./config-manager"
import { CodeIndexStateManager } from "./state-manager"
import { GraphExpander, ExpandedSearchResult } from "./graph-expander"
import { generateQuerySparseEmbedding } from "./shared/sparse-embedding"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/**
 * Service responsible for searching the code index.
 */
export class CodeIndexSearchService {
	private graphExpander?: GraphExpander

	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
	) {}

	/**
	 * Set the GraphExpander for code graph enriched search.
	 */
	setGraphExpander(expander: GraphExpander): void {
		this.graphExpander = expander
	}

	/**
	 * Searches the code index for relevant content.
	 * @param query The search query
	 * @param limit Maximum number of results to return
	 * @param directoryPrefix Optional directory path to filter results by
	 * @returns Array of search results
	 * @throws Error if the service is not properly configured or ready
	 */
	public async searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}

		const minScore = this.configManager.currentSearchMinScore
		const maxResults = this.configManager.currentSearchMaxResults

		const currentState = this.stateManager.getCurrentStatus().systemStatus
		if (currentState !== "Indexed" && currentState !== "Indexing") {
			// Allow search during Indexing too
			throw new Error(`Code index is not ready for search. Current state: ${currentState}`)
		}

		try {
			// Generate embedding for query
			const embeddingResponse = await this.embedder.createEmbeddings([query])
			const vector = embeddingResponse?.embeddings[0]
			if (!vector) {
				throw new Error("Failed to generate embedding for query.")
			}

			// Handle directory prefix
			let normalizedPrefix: string | undefined = undefined
			if (directoryPrefix) {
				normalizedPrefix = path.normalize(directoryPrefix)
			}

			// Perform hybrid search (dense + sparse) with fallback to dense-only.
			// Skip hybrid when sparse vector is empty (e.g., non-Latin queries like
			// Chinese/Japanese) — RRF with an empty sparse branch compresses scores.
			const sparseVector = generateQuerySparseEmbedding(query)
			let results: VectorStoreSearchResult[]
			if (sparseVector.indices.length === 0) {
				// No keyword tokens extracted → pure dense search
				results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
			} else {
				try {
					results = await this.vectorStore.hybridSearch(
						vector,
						sparseVector,
						normalizedPrefix,
						minScore,
						maxResults,
					)
				} catch {
					// Fallback to dense-only search if hybrid fails (e.g., legacy collection)
					results = await this.vectorStore.search(vector, normalizedPrefix, minScore, maxResults)
				}
			}

			// Expand with code graph if available (pass query + queryVector for relation vector search)
			if (this.graphExpander) {
				return await this.graphExpander.expand(results, query, vector)
			}

			return results
		} catch (error) {
			console.error("[CodeIndexSearchService] Error during search:", error)
			this.stateManager.setSystemState("Error", `Search failed: ${(error as Error).message}`)

			// Capture telemetry for the error
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: (error as Error).message,
				stack: (error as Error).stack,
				location: "searchIndex",
			})

			throw error // Re-throw the error after setting state
		}
	}
}
