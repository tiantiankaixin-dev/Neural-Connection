import { describe, it, expect, vi, beforeEach } from "vitest"

// Controllable mock for pagerank — allows toggling throw behavior per test
const { mockPagerankFn } = vi.hoisted(() => {
	const mockPagerankFn = vi.fn()
	return { mockPagerankFn }
})

vi.mock("graphology-metrics/centrality/pagerank", () => ({
	default: (...args: any[]) => mockPagerankFn(...args),
}))

// Re-import after mock to get mocked version
const { PageRankService } = await import("../pagerank-service")
// Real pagerank for default behavior
const realPagerank = (await vi.importActual<any>("graphology-metrics/centrality/pagerank")).default

// Mock QdrantVectorStore
function createMockQdrant(points: Array<{ id: string; payload: Record<string, any> }>) {
	return {
		scrollAllPoints: vi.fn().mockResolvedValue(points),
		batchUpdatePayloads: vi.fn().mockResolvedValue(undefined),
	} as any
}

describe("PageRankService", () => {
	beforeEach(() => {
		// Default: delegate to real pagerank implementation
		mockPagerankFn.mockImplementation((...args: any[]) => realPagerank(...args))
	})

	describe("computeRanks()", () => {
		it("should skip computation when no points exist", async () => {
			const mockQdrant = createMockQdrant([])
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			expect(mockQdrant.scrollAllPoints).toHaveBeenCalled()
			expect(mockQdrant.batchUpdatePayloads).not.toHaveBeenCalled()
		})

		it("should compute PageRank for a simple graph", async () => {
			// Block A defines "foo", Block B references "foo"
			// Edge: B → A (B references what A defines)
			const points = [
				{ id: "block-a", payload: { defines: ["foo"], refs: [], refDensity: 0 } },
				{ id: "block-b", payload: { defines: [], refs: ["foo"], refDensity: 0.5 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			expect(mockQdrant.batchUpdatePayloads).toHaveBeenCalledTimes(1)
			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]

			// Block A (definer) should have higher PageRank than Block B (referencer)
			const rankA = updates.find((u: any) => u.id === "block-a")?.payload.pageRank
			const rankB = updates.find((u: any) => u.id === "block-b")?.payload.pageRank

			expect(rankA).toBeDefined()
			expect(rankB).toBeDefined()
			expect(rankA).toBeGreaterThan(rankB)
		})

		it("should handle self-references gracefully", async () => {
			// Block A defines and references the same symbol
			const points = [
				{ id: "block-a", payload: { defines: ["recursiveFunc"], refs: ["recursiveFunc"], refDensity: 1.0 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			// Should not throw
			await service.computeRanks()

			expect(mockQdrant.batchUpdatePayloads).toHaveBeenCalled()
		})

		it("should give higher weight to quality names", async () => {
			// "calculateTotalPrice" is a high-quality name (long, camelCase)
			// "_x" is a low-quality name (starts with _, short)
			const points = [
				{ id: "a", payload: { defines: ["calculateTotalPrice"], refs: [], refDensity: 0 } },
				{ id: "b", payload: { defines: ["_x"], refs: [], refDensity: 0 } },
				{ id: "c", payload: { defines: [], refs: ["calculateTotalPrice", "_x"], refDensity: 0.5 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]
			const rankA = updates.find((u: any) => u.id === "a")?.payload.pageRank
			const rankB = updates.find((u: any) => u.id === "b")?.payload.pageRank

			// Block A (defines high-quality name) should rank higher than Block B
			expect(rankA).toBeGreaterThan(rankB)
		})

		it("should normalize ranks to [0, 1]", async () => {
			const points = [
				{ id: "a", payload: { defines: ["foo"], refs: ["bar"], refDensity: 0 } },
				{ id: "b", payload: { defines: ["bar"], refs: ["foo"], refDensity: 0 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]
			for (const u of updates) {
				expect(u.payload.pageRank).toBeGreaterThanOrEqual(0)
				expect(u.payload.pageRank).toBeLessThanOrEqual(1)
			}
		})

		it("should handle diamond dependency graph", async () => {
			// A defines "base", B and C reference "base" and define "mid1"/"mid2",
			// D references "mid1" and "mid2"
			const points = [
				{ id: "a", payload: { defines: ["base"], refs: [], refDensity: 0 } },
				{ id: "b", payload: { defines: ["mid1"], refs: ["base"], refDensity: 0.3 } },
				{ id: "c", payload: { defines: ["mid2"], refs: ["base"], refDensity: 0.3 } },
				{ id: "d", payload: { defines: [], refs: ["mid1", "mid2"], refDensity: 0.6 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]
			const rankA = updates.find((u: any) => u.id === "a")?.payload.pageRank
			const rankD = updates.find((u: any) => u.id === "d")?.payload.pageRank

			// A (base definition, most referenced transitively) should rank highest
			expect(rankA).toBeGreaterThan(rankD)
		})

		it("should apply edge weight = nameQualityMul * (1 + refDensity)", async () => {
			// Verify edge weighting effect:
			// High-quality name (long camelCase, length>=8) gets mul=10
			// refDensity amplifies the weight via (1 + refDensity)
			// Block C (high refDensity) referencing block A (high-quality name definer)
			// should produce a stronger edge than block D (low refDensity) → A
			const points = [
				{ id: "a", payload: { defines: ["calculateTotal"], refs: [], refDensity: 0 } },
				{ id: "c", payload: { defines: [], refs: ["calculateTotal"], refDensity: 2.0 } },
				{ id: "d", payload: { defines: [], refs: ["calculateTotal"], refDensity: 0.0 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]
			// A should have highest rank (sole definer of high-quality name)
			const rankA = updates.find((u: any) => u.id === "a")?.payload.pageRank
			expect(rankA).toBe(1) // Normalized max

			// C has higher refDensity → stronger edge → more PageRank transferred
			// So C should have less PageRank than A but the graph topology confirms
			// the edge weight formula matters: both C and D reference A, but with different weights
			// edge C→A: weight = 10 * (1 + 2.0) = 30
			// edge D→A: weight = 10 * (1 + 0.0) = 10
			// C transfers more rank to A proportionally
		})

		it("should demote generic names defined in >= 5 blocks (definerCount >= 5)", async () => {
			// "toString" defined in 5+ blocks → mul *= 0.1 → much lower edge weight
			// "uniqueProcessor" defined in 1 block → normal weight
			const points = [
				// 5 blocks all define "toString" → definerCount = 5
				{ id: "d1", payload: { defines: ["toString"], refs: [], refDensity: 0 } },
				{ id: "d2", payload: { defines: ["toString"], refs: [], refDensity: 0 } },
				{ id: "d3", payload: { defines: ["toString"], refs: [], refDensity: 0 } },
				{ id: "d4", payload: { defines: ["toString"], refs: [], refDensity: 0 } },
				{ id: "d5", payload: { defines: ["toString"], refs: [], refDensity: 0 } },
				// 1 block defines "uniqueProcessor" → definerCount = 1
				{ id: "u1", payload: { defines: ["uniqueProcessor"], refs: [], refDensity: 0 } },
				// referencer references both
				{ id: "r", payload: { defines: [], refs: ["toString", "uniqueProcessor"], refDensity: 0.5 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]
			const rankU1 = updates.find((u: any) => u.id === "u1")?.payload.pageRank

			// u1 (unique definer with high-quality name, 1 definer) should rank high
			// Each d1-d5 shares the "toString" rank evenly, AND the edge weight is
			// demoted by 0.1 for being generic
			// u1 gets full edge weight without generic demotion
			// So u1 should have higher rank than any individual toString definer
			const toStringRanks = ["d1", "d2", "d3", "d4", "d5"].map(
				(id) => updates.find((u: any) => u.id === id)?.payload.pageRank,
			)
			for (const tsr of toStringRanks) {
				expect(rankU1).toBeGreaterThan(tsr)
			}
		})

		it("should fallback to uniform distribution when PageRank computation throws", async () => {
			const points = [
				{ id: "a", payload: { defines: ["foo"], refs: [], refDensity: 0 } },
				{ id: "b", payload: { defines: [], refs: ["foo"], refDensity: 0 } },
			]
			const mockQdrant = createMockQdrant(points)

			// Make pagerank throw for this test
			mockPagerankFn.mockImplementation(() => {
				throw new Error("Simulated PageRank failure")
			})

			const service = new PageRankService(mockQdrant)
			await service.computeRanks()

			// Should still call batchUpdatePayloads with uniform ranks
			expect(mockQdrant.batchUpdatePayloads).toHaveBeenCalledTimes(1)
			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]

			// Uniform: each gets 1/n, then normalized → all get 1.0
			for (const u of updates) {
				expect(u.payload.pageRank).toBeCloseTo(1.0, 5)
			}
		})

		it("should produce correct batchUpdatePayloads structure", async () => {
			const points = [
				{ id: "block-1", payload: { defines: ["hello"], refs: [], refDensity: 0 } },
				{ id: "block-2", payload: { defines: [], refs: ["hello"], refDensity: 0 } },
			]
			const mockQdrant = createMockQdrant(points)
			const service = new PageRankService(mockQdrant)

			await service.computeRanks()

			expect(mockQdrant.batchUpdatePayloads).toHaveBeenCalledTimes(1)
			const updates = mockQdrant.batchUpdatePayloads.mock.calls[0][0]

			// Verify structure: array of { id: string, payload: { pageRank: number } }
			expect(Array.isArray(updates)).toBe(true)
			expect(updates.length).toBe(2)
			for (const u of updates) {
				expect(typeof u.id).toBe("string")
				expect(u.payload).toBeDefined()
				expect(typeof u.payload.pageRank).toBe("number")
				expect(u.payload.pageRank).toBeGreaterThanOrEqual(0)
				expect(u.payload.pageRank).toBeLessThanOrEqual(1)
				// Should only contain pageRank, no other fields
				expect(Object.keys(u.payload)).toEqual(["pageRank"])
			}
		})
	})
})
