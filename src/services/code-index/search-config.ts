/**
 * Search Tuning Configuration
 *
 * Centralizes all tunable search parameters that were previously hardcoded
 * across graph-expander.ts, search-service.ts, and CodebaseSearchTool.ts.
 *
 * Every parameter is independently adjustable. The AI model can override
 * any subset of these at search time to control precision vs. breadth.
 * Unspecified parameters fall back to RECOMMENDED_DEFAULTS.
 */

// ─── Tunable parameter interface ───

export interface SearchTuningConfig {
	// ── Vector search (search-service) ──

	/** Minimum cosine similarity score to include a result (0–1).
	 *  Lower → more results (broader); higher → fewer results (precise). */
	minScore?: number

	/** Maximum number of raw vector search results fetched from Qdrant. */
	maxVectorResults?: number

	// ── Graph expansion (graph-expander) ──

	/** Maximum graph traversal depth from each direct hit. */
	maxDepth?: number

	/** Maximum results per category (direct / related) after expansion. */
	maxExpandedResults?: number

	/** Per-file cap on direct hit blocks during expansion. */
	maxDirectPerFile?: number

	/** Per-file cap on related blocks during expansion. */
	maxRelatedPerFile?: number

	/** Relation vector similarity threshold (0–1).
	 *  Lower → more relation matches (broader). */
	relationVectorThreshold?: number

	/** Maximum relation vector candidates to fetch. */
	relationVectorLimit?: number

	/** Base score assigned to keyword-supplement hits (0–1). */
	keywordBaseScore?: number

	/** Maximum path-match boost added to direct hits (0–1). */
	pathBoostMax?: number

	/** Phase 2 PageRank multiplicative weight.
	 *  Higher → structurally important code ranks higher. */
	pageRankWeight?: number

	/** Phase 2 reference-density multiplicative weight. */
	refDensityWeight?: number

	// ── Post-merge dedup (CodebaseSearchTool) ──

	/** Global per-file cap on direct blocks after multi-query merge. */
	globalMaxDirectPerFile?: number

	/** Global per-file cap on related blocks after multi-query merge. */
	globalMaxRelatedPerFile?: number

	/** Line-range overlap ratio (0–1) above which blocks are deduplicated. */
	overlapThreshold?: number
}

// ─── Search mode type ───

export type SearchMode = "precise" | "broad"

// ─── Recommended defaults (current production values) ───

export const RECOMMENDED_DEFAULTS: Required<SearchTuningConfig> = {
	// Vector search
	minScore: 0.4,
	maxVectorResults: 50,

	// Graph expansion
	maxDepth: 1,
	maxExpandedResults: 15,
	maxDirectPerFile: 2,
	maxRelatedPerFile: 2,
	relationVectorThreshold: 0.32,
	relationVectorLimit: 30,
	keywordBaseScore: 0.65,
	pathBoostMax: 0.15,
	pageRankWeight: 0.5,
	refDensityWeight: 0,

	// Post-merge dedup
	globalMaxDirectPerFile: 2,
	globalMaxRelatedPerFile: 3,
	overlapThreshold: 0.5,
}

// ─── Mode presets (only fields that differ from RECOMMENDED_DEFAULTS) ───

export const PRECISE_PRESET: SearchTuningConfig = {
	minScore: 0.55, // 0.6 → 0.55：略微放宽相似度，获取更多相关代码块
	maxDirectPerFile: 6, // 4 → 6：进一步增加每文件代码块数
	maxExpandedResults: 20, // 12 → 20：大幅增加总结果数
	maxDepth: 2, // 新增：允许2层图遍历，获取依赖类
	maxRelatedPerFile: 2, // 新增：每文件返回2个关联代码块
	globalMaxDirectPerFile: 6, // 全局限制对齐
	globalMaxRelatedPerFile: 2, // 全局关联代码块限制
}

export const BROAD_PRESET: SearchTuningConfig = {
	minScore: 0.2,
	maxVectorResults: 100,
	maxExpandedResults: 30,
	maxDirectPerFile: 4,
	globalMaxDirectPerFile: 4,
}

/**
 * Resolve a search config by layering: RECOMMENDED_DEFAULTS → mode preset → overrides.
 * - mode selects a base preset ("precise" or "broad"); null/undefined = no preset.
 * - overrides apply on top of the preset for fine-grained control.
 */
export function resolveSearchConfig(
	mode?: SearchMode | null,
	overrides?: SearchTuningConfig,
): Required<SearchTuningConfig> {
	const preset = mode === "precise" ? PRECISE_PRESET : mode === "broad" ? BROAD_PRESET : {}
	return { ...RECOMMENDED_DEFAULTS, ...preset, ...overrides }
}
