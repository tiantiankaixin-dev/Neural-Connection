import { describe, it, expect } from "vitest"
import {
	splitIdentifier,
	tokenizeBlock,
	buildSparseVector,
	generateSparseEmbedding,
	generateQuerySparseEmbedding,
} from "../shared/sparse-embedding"

describe("sparse-embedding", () => {
	describe("splitIdentifier", () => {
		it("should split PascalCase identifiers", () => {
			expect(splitIdentifier("GameManager")).toEqual(["game", "manager"])
		})

		it("should split camelCase identifiers", () => {
			expect(splitIdentifier("handlePlayerDeath")).toEqual(["handle", "player", "death"])
		})

		it("should split snake_case identifiers", () => {
			expect(splitIdentifier("MAX_STACK_SIZE")).toEqual(["max", "stack", "size"])
		})

		it("should split mixed PascalCase with consecutive uppercase", () => {
			expect(splitIdentifier("OnSingletonAwake")).toEqual(["on", "singleton", "awake"])
		})

		it("should handle short/empty input", () => {
			expect(splitIdentifier("")).toEqual([])
			expect(splitIdentifier("A")).toEqual([])
			expect(splitIdentifier("ab")).toEqual(["ab"])
		})

		it("should filter out single-char tokens", () => {
			// "I" alone is < 2 chars, should be filtered
			expect(splitIdentifier("IManager")).toEqual(["manager"])
		})
	})

	describe("tokenizeBlock", () => {
		it("should weight defines higher than refs", () => {
			const weights = tokenizeBlock({
				filePath: "test.ts",
				content: "",
				defines: ["GameManager"],
				refs: ["GameManager"],
			})
			// "gamemanager" from defines gets weight 2.0
			// "gamemanager" from refs adds weight 1.0 → total 3.0
			const gmWeight = weights.get("gamemanager")
			expect(gmWeight).toBeDefined()
			expect(gmWeight!).toBeGreaterThan(2.0) // 2.0 (define) + 1.0 (ref) = 3.0
		})

		it("should include file path segments", () => {
			const weights = tokenizeBlock({
				filePath: "Scripts/Managers/GameManager.cs",
				content: "",
			})
			expect(weights.has("scripts")).toBe(true)
			expect(weights.has("managers")).toBe(true)
			expect(weights.has("gamemanager")).toBe(true)
		})

		it("should include className and classExtends", () => {
			const weights = tokenizeBlock({
				filePath: "test.ts",
				content: "",
				className: "AudioManager",
				classExtends: "Singleton",
			})
			expect(weights.has("audiomanager")).toBe(true)
			expect(weights.has("singleton")).toBe(true)
		})

		it("should extract identifiers from code content", () => {
			const weights = tokenizeBlock({
				filePath: "test.ts",
				content: "public void ChangeState(GameState newState) { }",
			})
			expect(weights.has("changestate")).toBe(true)
			expect(weights.has("gamestate")).toBe(true)
		})
	})

	describe("buildSparseVector", () => {
		it("should return empty vectors for empty weights", () => {
			const sv = buildSparseVector(new Map())
			expect(sv.indices).toEqual([])
			expect(sv.values).toEqual([])
		})

		it("should produce sorted indices", () => {
			const weights = new Map<string, number>([
				["foo", 1.0],
				["bar", 2.0],
				["baz", 0.5],
			])
			const sv = buildSparseVector(weights)
			expect(sv.indices.length).toBe(3)
			// Indices should be sorted ascending
			for (let i = 1; i < sv.indices.length; i++) {
				expect(sv.indices[i]).toBeGreaterThanOrEqual(sv.indices[i - 1])
			}
		})

		it("should have positive values", () => {
			const weights = new Map<string, number>([
				["hello", 1.0],
				["world", 2.0],
			])
			const sv = buildSparseVector(weights)
			for (const v of sv.values) {
				expect(v).toBeGreaterThan(0)
			}
		})
	})

	describe("generateSparseEmbedding", () => {
		it("should produce a non-empty sparse vector for a typical code block", () => {
			const sv = generateSparseEmbedding({
				filePath: "Scripts/Managers/GameManager.cs",
				content: "public class GameManager : Singleton<GameManager> { }",
				defines: ["GameManager"],
				refs: ["Singleton"],
				className: "GameManager",
				classExtends: "Singleton",
			})
			expect(sv.indices.length).toBeGreaterThan(0)
			expect(sv.indices.length).toBe(sv.values.length)
		})

		it("should be deterministic (same input → same output)", () => {
			const input = {
				filePath: "a.ts",
				content: "const x = 1",
				defines: ["foo"],
				refs: ["bar"],
			}
			const sv1 = generateSparseEmbedding(input)
			const sv2 = generateSparseEmbedding(input)
			expect(sv1.indices).toEqual(sv2.indices)
			expect(sv1.values).toEqual(sv2.values)
		})
	})

	describe("generateQuerySparseEmbedding", () => {
		it("should produce tokens from a natural language query", () => {
			const sv = generateQuerySparseEmbedding("GameManager singleton pattern")
			expect(sv.indices.length).toBeGreaterThan(0)
		})

		it("should produce tokens from identifier-heavy queries", () => {
			const sv = generateQuerySparseEmbedding("AudioManager PlayMusic")
			expect(sv.indices.length).toBeGreaterThan(0)
		})

		it("should produce empty vector for empty query", () => {
			const sv = generateQuerySparseEmbedding("")
			expect(sv.indices.length).toBe(0)
		})

		it("should be deterministic", () => {
			const q = "project architecture overview"
			const sv1 = generateQuerySparseEmbedding(q)
			const sv2 = generateQuerySparseEmbedding(q)
			expect(sv1.indices).toEqual(sv2.indices)
			expect(sv1.values).toEqual(sv2.values)
		})
	})
})
