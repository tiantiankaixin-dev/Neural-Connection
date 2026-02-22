import { describe, it, expect, vi, beforeEach } from "vitest"
import { GraphExpander, DEFAULT_CONFIG } from "../graph-expander"
import { VectorStoreSearchResult, Payload } from "../interfaces"

function createMockQdrant() {
	return {
		findBlocksByDefines: vi.fn().mockResolvedValue([]),
		findBlocksByRefs: vi.fn().mockResolvedValue([]),
		findBlocksByClassName: vi.fn().mockResolvedValue([]),
		findBlocksByClassExtends: vi.fn().mockResolvedValue([]),
	} as any
}

function makeHit(
	id: string,
	score: number,
	payload: Partial<Payload> & { filePath: string; codeChunk: string; startLine: number; endLine: number },
): VectorStoreSearchResult {
	return { id, score, payload: payload as Payload }
}

describe("GraphExpander", () => {
	let mockQdrant: ReturnType<typeof createMockQdrant>
	let expander: GraphExpander

	beforeEach(() => {
		mockQdrant = createMockQdrant()
		expander = new GraphExpander(mockQdrant)
	})

	describe("expand() - disabled", () => {
		it("should return direct hits as-is when disabled", async () => {
			const disabledExpander = new GraphExpander(mockQdrant, { enabled: false })
			const hits = [makeHit("1", 0.9, { filePath: "a.ts", codeChunk: "code", startLine: 1, endLine: 5 })]

			const results = await disabledExpander.expand(hits)

			expect(results.length).toBe(1)
			expect(results[0].isDirectHit).toBe(true)
			// Phase 1 only (disabled skips Phase 2 reranking): vectorScore + 0 pathBoost = 0.9
			expect(results[0].score).toBeCloseTo(0.9, 10)
		})

		it("should return empty for empty input", async () => {
			const results = await expander.expand([])
			expect(results).toEqual([])
		})
	})

	describe("expand() - with graph", () => {
		it("should mark direct hits correctly", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["foo"],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			const directHits = results.filter((r) => r.isDirectHit)
			expect(directHits.length).toBe(1)
			expect(directHits[0].id).toBe("1")
		})

		it("should expand refs to find definers", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["helperFunc"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "2",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "helper code",
						startLine: 10,
						endLine: 20,
						pageRank: 0.5,
						refDensity: 0.3,
					},
				},
			])

			const results = await expander.expand(hits)

			expect(results.length).toBe(2)
			const related = results.find((r) => r.id === "2")
			expect(related).toBeDefined()
			expect(related!.isDirectHit).toBe(false)
			expect(related!.relationType).toBe("calls")
		})

		it("should expand defines to find referencers", async () => {
			const hits = [
				makeHit("1", 0.85, {
					filePath: "a.ts",
					codeChunk: "function foo() {}",
					startLine: 1,
					endLine: 5,
					defines: ["foo"],
					refs: [],
				}),
			]

			mockQdrant.findBlocksByRefs.mockResolvedValue([
				{
					id: "3",
					score: 0,
					payload: {
						filePath: "c.ts",
						codeChunk: "foo()",
						startLine: 1,
						endLine: 3,
						pageRank: 0.2,
						refDensity: 0.1,
					},
				},
			])

			const results = await expander.expand(hits)

			const calledBy = results.find((r) => r.relationType === "calledBy")
			expect(calledBy).toBeDefined()
			expect(calledBy!.id).toBe("3")
		})

		it("should expand className to find same-class methods", async () => {
			const hits = [
				makeHit("1", 0.8, {
					filePath: "a.ts",
					codeChunk: "methodA() {}",
					startLine: 5,
					endLine: 10,
					defines: ["methodA"],
					refs: [],
					className: "MyService",
				}),
			]

			mockQdrant.findBlocksByClassName.mockResolvedValue([
				{
					id: "4",
					score: 0,
					payload: {
						filePath: "a.ts",
						codeChunk: "methodB() {}",
						startLine: 15,
						endLine: 20,
						className: "MyService",
						pageRank: 0.3,
						refDensity: 0.2,
					},
				},
			])

			const results = await expander.expand(hits)

			const sameClass = results.find((r) => r.relationType === "sameClass")
			expect(sameClass).toBeDefined()
			expect(sameClass!.id).toBe("4")
		})

		it("should deduplicate results", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["foo"],
					refs: ["bar"],
				}),
			]

			// Same block returned by two different expansions
			const sharedResult = {
				id: "2",
				score: 0,
				payload: {
					filePath: "b.ts",
					codeChunk: "shared",
					startLine: 1,
					endLine: 5,
					pageRank: 0.4,
					refDensity: 0.2,
				},
			}

			mockQdrant.findBlocksByDefines.mockResolvedValue([sharedResult])
			mockQdrant.findBlocksByRefs.mockResolvedValue([sharedResult])

			const results = await expander.expand(hits)

			const block2Results = results.filter((r) => r.id === "2")
			expect(block2Results.length).toBe(1) // Should appear only once
		})

		it("should respect maxResults limit", async () => {
			const smallExpander = new GraphExpander(mockQdrant, { maxResults: 3 })

			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["a", "b", "c", "d"],
				}),
			]

			// Return many related blocks
			mockQdrant.findBlocksByDefines.mockResolvedValue(
				Array.from({ length: 10 }, (_, i) => ({
					id: `related-${i}`,
					score: 0,
					payload: {
						filePath: `file${i}.ts`,
						codeChunk: `code ${i}`,
						startLine: 1,
						endLine: 5,
						pageRank: i * 0.1,
						refDensity: 0,
					},
				})),
			)

			const results = await smallExpander.expand(hits)

			// maxResults caps each category (direct/related) independently
			const directResults = results.filter((r) => r.isDirectHit)
			const relatedResults = results.filter((r) => !r.isDirectHit)
			expect(directResults.length).toBeLessThanOrEqual(3)
			expect(relatedResults.length).toBeLessThanOrEqual(3)
		})

		it("should skip hits with null payload", async () => {
			const hits: VectorStoreSearchResult[] = [
				{ id: "1", score: 0.9, payload: null },
				makeHit("2", 0.8, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			expect(results.length).toBe(1)
			expect(results[0].id).toBe("2")
		})
	})

	/**
	 * Two-phase scoring formula under test:
	 *
	 * Phase 1 (computeScore — pure semantic):
	 *   vectorSim = parentVectorScore * 0.8
	 *   relationWeight = RELATION_WEIGHTS[relationType]   // calls=1.0, calledBy=0.9, sameClass=0.7, extends=0.5
	 *   phase1 = w.vectorSim(0.4) * vectorSim + w.relation(0.25) * relationWeight
	 *
	 * Phase 2 (reranking — reference density boost):
	 *   pr = payload.pageRank || 0
	 *   rd = min(payload.refDensity || 0, 2) / 2
	 *   finalScore = phase1 * (1 + dw.pageRank(0.5) * pr + dw.refDensity(0) * rd)
	 */
	describe("scoring — exact formula verification", () => {
		// Helper: compute expected score manually using the two-phase formula
		function expectedScore(
			parentVectorScore: number,
			relationType: "calls" | "calledBy" | "sameClass" | "extends",
			pageRank: number,
			refDensity: number,
		): number {
			const RELATION_WEIGHTS_MAP: Record<string, number> = {
				calls: 1.0,
				calledBy: 0.9,
				sameClass: 0.7,
				extends: 0.5,
			}
			const w = { vectorSim: 0.4, relation: 0.25 }
			const dw = { pageRank: 0.5, refDensity: 0 }
			const vectorSim = parentVectorScore * 0.8
			const relationWeight = RELATION_WEIGHTS_MAP[relationType]
			const pr = pageRank
			const rd = Math.min(refDensity, 2) / 2
			// Phase 1: pure semantic
			const phase1 = w.vectorSim * vectorSim + w.relation * relationWeight
			// Phase 2: reranking
			return phase1 * (1 + dw.pageRank * pr + dw.refDensity * rd)
		}

		it("should compute exact score for 'calls' relation type", async () => {
			const parentScore = 0.9
			const hits = [
				makeHit("1", parentScore, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["helperFunc"],
				}),
			]

			const pr = 0.6
			const rd = 0.4
			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "target",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "helper",
						startLine: 1,
						endLine: 5,
						pageRank: pr,
						refDensity: rd,
					},
				},
			])

			const results = await expander.expand(hits)
			const target = results.find((r) => r.id === "target")!
			const expected = expectedScore(parentScore, "calls", pr, rd)
			expect(target.score).toBeCloseTo(expected, 10)
			// Phase 1: 0.4*(0.9*0.8) + 0.25*1.0 = 0.288 + 0.25 = 0.538
			// Phase 2: 0.538 * (1 + 0.5*0.6) = 0.538 * 1.3 = 0.6994
			expect(target.score).toBeCloseTo(0.6994, 10)
		})

		it("should compute exact score for 'calledBy' relation type", async () => {
			const parentScore = 0.85
			const hits = [
				makeHit("1", parentScore, {
					filePath: "a.ts",
					codeChunk: "function foo() {}",
					startLine: 1,
					endLine: 5,
					defines: ["foo"],
					refs: [],
				}),
			]

			const pr = 0.3
			const rd = 1.0
			mockQdrant.findBlocksByRefs.mockResolvedValue([
				{
					id: "caller",
					score: 0,
					payload: {
						filePath: "c.ts",
						codeChunk: "foo()",
						startLine: 1,
						endLine: 3,
						pageRank: pr,
						refDensity: rd,
					},
				},
			])

			const results = await expander.expand(hits)
			const caller = results.find((r) => r.id === "caller")!
			const expected = expectedScore(parentScore, "calledBy", pr, rd)
			expect(caller.score).toBeCloseTo(expected, 10)
			// Phase 1: 0.4*(0.85*0.8) + 0.25*0.9 = 0.272 + 0.225 = 0.497
			// Phase 2: 0.497 * (1 + 0.5*0.3) = 0.497 * 1.15 = 0.57155
			expect(caller.score).toBeCloseTo(0.57155, 10)
		})

		it("should compute exact score for 'sameClass' relation type", async () => {
			const parentScore = 0.7
			const hits = [
				makeHit("1", parentScore, {
					filePath: "a.ts",
					codeChunk: "methodA() {}",
					startLine: 5,
					endLine: 10,
					defines: ["methodA"],
					refs: [],
					className: "MyService",
				}),
			]

			const pr = 0.0
			const rd = 0.0
			mockQdrant.findBlocksByClassName.mockResolvedValue([
				{
					id: "sibling",
					score: 0,
					payload: {
						filePath: "a.ts",
						codeChunk: "methodB() {}",
						startLine: 15,
						endLine: 20,
						pageRank: pr,
						refDensity: rd,
					},
				},
			])

			const results = await expander.expand(hits)
			const sibling = results.find((r) => r.id === "sibling")!
			const expected = expectedScore(parentScore, "sameClass", pr, rd)
			expect(sibling.score).toBeCloseTo(expected, 10)
			// Phase 1: 0.4*(0.7*0.8) + 0.25*0.7 = 0.224 + 0.175 = 0.399
			// Phase 2: 0.399 * (1 + 0 + 0) = 0.399
			expect(sibling.score).toBeCloseTo(0.399, 10)
		})

		it("should compute exact score for 'extends' relation type", async () => {
			const parentScore = 0.8
			const hits = [
				makeHit("1", parentScore, {
					filePath: "a.ts",
					codeChunk: "class Child extends Parent {}",
					startLine: 1,
					endLine: 10,
					defines: ["Child"],
					refs: [],
					classExtends: "Parent",
				}),
			]

			const pr = 1.0
			const rd = 0.8
			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "parent-block",
					score: 0,
					payload: {
						filePath: "parent.ts",
						codeChunk: "class Parent {}",
						startLine: 1,
						endLine: 20,
						pageRank: pr,
						refDensity: rd,
					},
				},
			])

			const results = await expander.expand(hits)
			const parentBlock = results.find((r) => r.id === "parent-block")!
			// This block is found via classExtends → findBlocksByDefines,
			// but it's also found via refs expansion if "Parent" is in refs.
			// Since classExtends triggers findBlocksByDefines(["Parent"]),
			// the relationType depends on which path adds it first.
			// In the code, refs expansion (step 1) runs before classExtends (step 4).
			// Since refs is empty, this comes from the classExtends path → relationType = "extends"
			const expected = expectedScore(parentScore, "extends", pr, rd)
			expect(parentBlock.score).toBeCloseTo(expected, 10)
			// Phase 1: 0.4*(0.8*0.8) + 0.25*0.5 = 0.256 + 0.125 = 0.381
			// Phase 2: 0.381 * (1 + 0.5*1.0) = 0.381 * 1.5 = 0.5715
			expect(parentBlock.score).toBeCloseTo(0.5715, 10)
		})

		it("should cap refDensity at 2.0 before normalizing", async () => {
			const parentScore = 0.5
			const hits = [
				makeHit("1", parentScore, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			// refDensity = 5.0 should be capped to 2.0, then /2 = 1.0
			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "extreme-rd",
					score: 0,
					payload: {
						filePath: "x.ts",
						codeChunk: "dense",
						startLine: 1,
						endLine: 2,
						pageRank: 0,
						refDensity: 5.0,
					},
				},
			])

			const results = await expander.expand(hits)
			const block = results.find((r) => r.id === "extreme-rd")!
			// rd = min(5.0, 2) / 2 = 1.0 (capped)
			const expected = expectedScore(parentScore, "calls", 0, 2.0) // pass 2.0 to trigger cap in helper too
			expect(block.score).toBeCloseTo(expected, 10)

			// Now verify that refDensity=2.0 gives the same result (proves capping)
			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "capped-rd",
					score: 0,
					payload: {
						filePath: "y.ts",
						codeChunk: "capped",
						startLine: 1,
						endLine: 2,
						pageRank: 0,
						refDensity: 2.0,
					},
				},
			])

			const expander2 = new GraphExpander(mockQdrant)
			const results2 = await expander2.expand(hits)
			const block2 = results2.find((r) => r.id === "capped-rd")!
			expect(block.score).toBeCloseTo(block2.score, 10) // rd=5.0 and rd=2.0 produce identical scores
		})

		it("should apply 0.8 discount to parent vector score for related blocks", async () => {
			// Test that changing parentVectorScore by X changes related score by 0.4 * 0.8 * X
			const hits1 = [
				makeHit("1", 1.0, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["sym"],
				}),
			]
			const hits2 = [
				makeHit("1", 0.5, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["sym"],
				}),
			]

			const relatedPayload = {
				filePath: "b.ts",
				codeChunk: "target",
				startLine: 1,
				endLine: 5,
				pageRank: 0,
				refDensity: 0,
			}

			mockQdrant.findBlocksByDefines.mockResolvedValue([{ id: "rel", score: 0, payload: relatedPayload }])

			const r1 = await expander.expand(hits1)
			const score1 = r1.find((r) => r.id === "rel")!.score

			const expander2 = new GraphExpander(mockQdrant)
			const r2 = await expander2.expand(hits2)
			const score2 = r2.find((r) => r.id === "rel")!.score

			// Difference should be exactly: 0.4 * 0.8 * (1.0 - 0.5) = 0.16 (no PR/RD so Phase 2 is 1.0)
			expect(score1 - score2).toBeCloseTo(0.4 * 0.8 * 0.5, 10)
		})

		it("should use custom directWeights for Phase 2 reranking", async () => {
			const customExpander = new GraphExpander(mockQdrant, {
				directWeights: { vectorSim: 0.7, pageRank: 1.0, refDensity: 0.0 },
			})
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "pr-only",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "target",
						startLine: 1,
						endLine: 5,
						pageRank: 0.75,
						refDensity: 99, // should be ignored with weight 0
					},
				},
			])

			const results = await customExpander.expand(hits)
			const block = results.find((r) => r.id === "pr-only")!
			// Phase 1: 0.4*(0.9*0.8) + 0.25*1.0 = 0.538
			// Phase 2 (dw.pageRank=1.0): 0.538 * (1 + 1.0*0.75 + 0) = 0.538 * 1.75 = 0.9415
			expect(block.score).toBeCloseTo(0.9415, 10)
		})

		it("should treat missing pageRank/refDensity as 0", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "no-pr-rd",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "target",
						startLine: 1,
						endLine: 5,
						// no pageRank, no refDensity fields
					},
				},
			])

			const results = await expander.expand(hits)
			const block = results.find((r) => r.id === "no-pr-rd")!
			const expected = expectedScore(0.9, "calls", 0, 0)
			expect(block.score).toBeCloseTo(expected, 10)
			// Phase 1: 0.4*(0.9*0.8) + 0.25*1.0 = 0.538
			// Phase 2: 0.538 * (1 + 0 + 0) = 0.538
			expect(block.score).toBeCloseTo(0.538, 10)
		})
	})

	describe("updateConfig()", () => {
		it("should disable expansion after updateConfig({ enabled: false })", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "related",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "rel",
						startLine: 1,
						endLine: 5,
						pageRank: 0.5,
						refDensity: 0,
					},
				},
			])

			// First expand with enabled=true → should have related results
			const results1 = await expander.expand(hits)
			expect(results1.some((r) => r.id === "related")).toBe(true)

			// Now disable
			expander.updateConfig({ enabled: false })
			const results2 = await expander.expand(hits)
			expect(results2.every((r) => r.isDirectHit)).toBe(true)
			expect(results2.find((r) => r.id === "related")).toBeUndefined()
		})

		it("should update maxResults via updateConfig()", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue(
				Array.from({ length: 10 }, (_, i) => ({
					id: `r-${i}`,
					score: 0,
					payload: {
						filePath: `f${i}.ts`,
						codeChunk: `c${i}`,
						startLine: 1,
						endLine: 5,
						pageRank: 0,
						refDensity: 0,
					},
				})),
			)

			expander.updateConfig({ maxResults: 3 })
			const results = await expander.expand(hits)

			// maxResults caps each category (direct/related) independently
			const directResults = results.filter((r) => r.isDirectHit)
			const relatedResults = results.filter((r) => !r.isDirectHit)
			expect(directResults.length).toBeLessThanOrEqual(3)
			expect(relatedResults.length).toBeLessThanOrEqual(3)
		})

		it("should update directWeights via updateConfig()", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["x"],
				}),
			]

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{
					id: "target",
					score: 0,
					payload: {
						filePath: "b.ts",
						codeChunk: "t",
						startLine: 1,
						endLine: 5,
						pageRank: 0.8,
						refDensity: 0,
					},
				},
			])

			// Score with default directWeights (pageRank=0.5)
			const r1 = await expander.expand(hits)
			const score1 = r1.find((r) => r.id === "target")!.score

			// Change to high pageRank weight in directWeights
			expander.updateConfig({ directWeights: { vectorSim: 0.7, pageRank: 1.0, refDensity: 0 } })
			const r2 = await expander.expand(hits)
			const score2 = r2.find((r) => r.id === "target")!.score

			// Phase 1: 0.4*(0.9*0.8) + 0.25*1.0 = 0.538
			// Phase 2 (dw.pageRank=1.0): 0.538 * (1 + 1.0*0.8 + 0) = 0.538 * 1.8 = 0.9684
			expect(score2).toBeCloseTo(0.9684, 10)
			expect(score2).not.toBeCloseTo(score1, 2) // Different from default
		})
	})

	describe("maxRelatedPerFile deduplication", () => {
		it("should limit related blocks per file to maxRelatedPerFile (default 2)", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["Foo"],
					refs: [],
				}),
			]

			// 5 related blocks from same file "big.ts" + 1 from "other.ts"
			mockQdrant.findBlocksByRefs.mockResolvedValue([
				{
					id: "r1",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c1",
						startLine: 1,
						endLine: 5,
						pageRank: 0.5,
						refDensity: 0,
					},
				},
				{
					id: "r2",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c2",
						startLine: 6,
						endLine: 10,
						pageRank: 0.4,
						refDensity: 0,
					},
				},
				{
					id: "r3",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c3",
						startLine: 11,
						endLine: 15,
						pageRank: 0.3,
						refDensity: 0,
					},
				},
				{
					id: "r4",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c4",
						startLine: 16,
						endLine: 20,
						pageRank: 0.2,
						refDensity: 0,
					},
				},
				{
					id: "r5",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c5",
						startLine: 21,
						endLine: 25,
						pageRank: 0.1,
						refDensity: 0,
					},
				},
				{
					id: "r6",
					score: 0,
					payload: {
						filePath: "other.ts",
						codeChunk: "c6",
						startLine: 1,
						endLine: 5,
						pageRank: 0,
						refDensity: 0,
					},
				},
			])

			const results = await expander.expand(hits)
			const related = results.filter((r) => !r.isDirectHit)
			const bigTsBlocks = related.filter((r) => (r.payload.filePath as string) === "big.ts")
			const otherTsBlocks = related.filter((r) => (r.payload.filePath as string) === "other.ts")

			// Default maxRelatedPerFile=2: only 2 blocks from big.ts should survive
			expect(bigTsBlocks.length).toBe(2)
			// other.ts should keep its 1 block
			expect(otherTsBlocks.length).toBe(1)
		})

		it("should respect custom maxRelatedPerFile via updateConfig", async () => {
			expander.updateConfig({ maxRelatedPerFile: 1 })

			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["Foo"],
					refs: [],
				}),
			]

			mockQdrant.findBlocksByRefs.mockResolvedValue([
				{
					id: "r1",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c1",
						startLine: 1,
						endLine: 5,
						pageRank: 0.5,
						refDensity: 0,
					},
				},
				{
					id: "r2",
					score: 0,
					payload: {
						filePath: "big.ts",
						codeChunk: "c2",
						startLine: 6,
						endLine: 10,
						pageRank: 0.4,
						refDensity: 0,
					},
				},
				{
					id: "r3",
					score: 0,
					payload: {
						filePath: "other.ts",
						codeChunk: "c3",
						startLine: 1,
						endLine: 5,
						pageRank: 0,
						refDensity: 0,
					},
				},
			])

			const results = await expander.expand(hits)
			const related = results.filter((r) => !r.isDirectHit)
			const bigTsBlocks = related.filter((r) => (r.payload.filePath as string) === "big.ts")

			// maxRelatedPerFile=1: only 1 block from big.ts
			expect(bigTsBlocks.length).toBe(1)
		})
	})

	describe("findBlocksByDefines/Refs limit parameter", () => {
		it("should pass limit=30 for refs→definers expansion", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: ["someSymbol"],
				}),
			]

			await expander.expand(hits)

			expect(mockQdrant.findBlocksByDefines).toHaveBeenCalledWith(["someSymbol"], 30)
		})

		it("should pass limit=10 for defines→referencers expansion", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["myFunc"],
					refs: [],
				}),
			]

			await expander.expand(hits)

			expect(mockQdrant.findBlocksByRefs).toHaveBeenCalledWith(["myFunc"], 10)
		})

		it("should pass limit=10 for className expansion", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: [],
					className: "MyService",
				}),
			]

			await expander.expand(hits)

			expect(mockQdrant.findBlocksByClassName).toHaveBeenCalledWith("MyService", 10)
		})

		it("should pass limit=5 for classExtends expansion", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: [],
					classExtends: "BaseClass",
				}),
			]

			await expander.expand(hits)

			expect(mockQdrant.findBlocksByDefines).toHaveBeenCalledWith(["BaseClass"], 5)
		})
	})

	describe("extractIdentifiers()", () => {
		it("should extract PascalCase identifiers", () => {
			const result = GraphExpander.extractIdentifiers("GameManager and PlayerController")
			expect(result).toContain("GameManager")
			expect(result).toContain("PlayerController")
		})

		it("should extract capitalized words (4+ chars) as potential type names", () => {
			const result = GraphExpander.extractIdentifiers("Singleton pattern implementation")
			expect(result).toContain("Singleton")
		})

		it("should NOT extract very short capitalized words (1-2 lowercase chars)", () => {
			const result = GraphExpander.extractIdentifiers("If Do Go")
			expect(result).toHaveLength(0)
		})

		it("should extract camelCase identifiers", () => {
			const result = GraphExpander.extractIdentifiers("updateGameState and onPlayerDeath")
			expect(result).toContain("updateGameState")
			expect(result).toContain("onPlayerDeath")
		})

		it("should extract UPPER_CASE constants", () => {
			const result = GraphExpander.extractIdentifiers("MAX_HEALTH and PLAYER_SPEED")
			expect(result).toContain("MAX_HEALTH")
			expect(result).toContain("PLAYER_SPEED")
		})

		it("should extract snake_case identifiers", () => {
			const result = GraphExpander.extractIdentifiers("game_manager update_state")
			expect(result).toContain("game_manager")
			expect(result).toContain("update_state")
		})

		it("should extract mixed identifiers from a complex query", () => {
			const result = GraphExpander.extractIdentifiers("Singleton pattern with GameManager class")
			expect(result).toContain("Singleton")
			expect(result).toContain("GameManager")
		})
	})

	describe("keyword supplement — classExtends search", () => {
		let mockQdrant: ReturnType<typeof createMockQdrant>
		let expander: GraphExpander

		beforeEach(() => {
			mockQdrant = createMockQdrant()
			expander = new GraphExpander(mockQdrant)
		})

		it("should search classExtends for extracted identifiers", async () => {
			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: [],
				}),
			]

			await expander.expand(hits, "Singleton pattern")

			// Should search classExtends for "Singleton"
			expect(mockQdrant.findBlocksByClassExtends).toHaveBeenCalledWith("Singleton", 5)
		})

		it("should add classExtends results with discounted base score", async () => {
			const extendsBlock = {
				id: "ext-1",
				score: 0,
				payload: {
					filePath: "managers/GameManager.cs",
					codeChunk: "class GameManager : Singleton<GameManager>",
					startLine: 1,
					endLine: 10,
					className: "GameManager",
					classExtends: "Singleton",
					pageRank: 0.5,
					refDensity: 0.3,
				} as Payload,
			}

			mockQdrant.findBlocksByClassExtends.mockResolvedValue([extendsBlock])

			const hits = [
				makeHit("1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: [],
					refs: [],
				}),
			]

			const results = await expander.expand(hits, "Singleton pattern")

			// Find the classExtends keyword match
			const extResult = results.find((r) => r.id === "ext-1")
			expect(extResult).toBeDefined()
			expect(extResult!.relationType).toBe("keywordMatch")
			// Base score = 0.65 * 0.9 = 0.585, then Phase 2 reranking applies
			// Phase 2: 0.585 * (1 + 0.5*0.5) = 0.585 * 1.25 = 0.73125
			expect(extResult!.score).toBeCloseTo(0.585 * (1 + 0.5 * 0.5), 5)
		})
	})

	describe("hasSignificantOverlap", () => {
		it("should return false for empty accepted list", () => {
			expect(GraphExpander.hasSignificantOverlap(1, 10, [])).toBe(false)
		})

		it("should return false for non-overlapping ranges", () => {
			const accepted = [{ start: 1, end: 10 }]
			expect(GraphExpander.hasSignificantOverlap(20, 30, accepted)).toBe(false)
		})

		it("should return true for identical ranges", () => {
			const accepted = [{ start: 1, end: 10 }]
			expect(GraphExpander.hasSignificantOverlap(1, 10, accepted)).toBe(true)
		})

		it("should return true for >50% overlap", () => {
			// accepted: 1-10 (10 lines), candidate: 5-14 (10 lines), overlap: 5-10 (6 lines) = 60%
			const accepted = [{ start: 1, end: 10 }]
			expect(GraphExpander.hasSignificantOverlap(5, 14, accepted)).toBe(true)
		})

		it("should return false for <50% overlap", () => {
			// accepted: 1-10 (10 lines), candidate: 8-20 (13 lines), overlap: 8-10 (3 lines) = 3/10 = 30%
			const accepted = [{ start: 1, end: 10 }]
			expect(GraphExpander.hasSignificantOverlap(8, 20, accepted)).toBe(false)
		})

		it("should return true when subset of accepted range", () => {
			// accepted: 1-20, candidate: 5-10 — candidate is fully inside, 6/6 = 100%
			const accepted = [{ start: 1, end: 20 }]
			expect(GraphExpander.hasSignificantOverlap(5, 10, accepted)).toBe(true)
		})

		it("should check against multiple accepted ranges", () => {
			const accepted = [
				{ start: 1, end: 10 },
				{ start: 50, end: 60 },
			]
			// No overlap with first, but overlaps with second
			expect(GraphExpander.hasSignificantOverlap(55, 65, accepted)).toBe(true)
			// No overlap with either
			expect(GraphExpander.hasSignificantOverlap(25, 35, accepted)).toBe(false)
		})

		it("should respect custom threshold", () => {
			// accepted: 1-10, candidate: 7-16 — overlap: 7-10 (4 lines), minLen=10, ratio=0.4
			const accepted = [{ start: 1, end: 10 }]
			// Default threshold 0.5 → false
			expect(GraphExpander.hasSignificantOverlap(7, 16, accepted)).toBe(false)
			// Custom threshold 0.3 → true
			expect(GraphExpander.hasSignificantOverlap(7, 16, accepted, 0.3)).toBe(true)
		})
	})

	describe("expand() - line-range overlap dedup", () => {
		it("should dedup overlapping related blocks from the same file", async () => {
			const hits = [
				makeHit("direct-1", 0.9, {
					filePath: "a.ts",
					codeChunk: "code",
					startLine: 1,
					endLine: 5,
					defines: ["foo"],
					refs: [],
				}),
			]

			// Two related blocks from same file with overlapping line ranges
			mockQdrant.findBlocksByRefs.mockResolvedValue([
				{
					id: "rel-1",
					payload: {
						filePath: "b.ts",
						codeChunk: "block1",
						startLine: 10,
						endLine: 25,
						pageRank: 0.1,
						refDensity: 0,
					},
				},
				{
					id: "rel-2",
					payload: {
						filePath: "b.ts",
						codeChunk: "block2",
						startLine: 12,
						endLine: 27,
						pageRank: 0.1,
						refDensity: 0,
					},
				},
			])

			const results = await expander.expand(hits)

			// rel-2 overlaps >50% with rel-1 (lines 12-25 out of 12-27, 14/16 = 87%)
			// so only rel-1 (higher score due to sorted order) should survive
			const relatedFromB = results.filter((r) => !r.isDirectHit && r.payload.filePath === "b.ts")
			expect(relatedFromB.length).toBe(1)
			expect(relatedFromB[0].id).toBe("rel-1")
		})

		it("should dedup overlapping direct hit blocks from the same file", async () => {
			const hits = [
				makeHit("d1", 0.9, {
					filePath: "a.ts",
					codeChunk: "block1",
					startLine: 1,
					endLine: 20,
					defines: [],
					refs: [],
				}),
				makeHit("d2", 0.85, {
					filePath: "a.ts",
					codeChunk: "block2",
					startLine: 3,
					endLine: 22,
					defines: [],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			// d2 (3-22) overlaps heavily with d1 (1-20): overlap 3-20 = 18 lines, min len = 20, 90%
			const directsFromA = results.filter((r) => r.isDirectHit && r.payload.filePath === "a.ts")
			expect(directsFromA.length).toBe(1)
			expect(directsFromA[0].id).toBe("d1")
		})

		it("should keep non-overlapping blocks from the same file", async () => {
			const hits = [
				makeHit("d1", 0.9, {
					filePath: "a.ts",
					codeChunk: "block1",
					startLine: 1,
					endLine: 20,
					defines: [],
					refs: [],
				}),
				makeHit("d2", 0.85, {
					filePath: "a.ts",
					codeChunk: "block2",
					startLine: 50,
					endLine: 70,
					defines: [],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			const directsFromA = results.filter((r) => r.isDirectHit && r.payload.filePath === "a.ts")
			expect(directsFromA.length).toBe(2)
		})
	})

	describe("maxDirectPerFile", () => {
		it("should cap direct hit blocks per file at maxDirectPerFile=2", async () => {
			const hits = [
				makeHit("d1", 0.95, {
					filePath: "GameManager.ts",
					codeChunk: "block1",
					startLine: 1,
					endLine: 30,
					defines: ["GameManager"],
					refs: [],
				}),
				makeHit("d2", 0.9, {
					filePath: "GameManager.ts",
					codeChunk: "block2",
					startLine: 40,
					endLine: 70,
					defines: ["ChangeState"],
					refs: [],
				}),
				makeHit("d3", 0.85, {
					filePath: "GameManager.ts",
					codeChunk: "block3",
					startLine: 80,
					endLine: 110,
					defines: ["TogglePause"],
					refs: [],
				}),
				makeHit("d4", 0.8, {
					filePath: "Other.ts",
					codeChunk: "other",
					startLine: 1,
					endLine: 20,
					defines: ["Other"],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			const directsFromGM = results.filter((r) => r.isDirectHit && r.payload.filePath === "GameManager.ts")
			const directsFromOther = results.filter((r) => r.isDirectHit && r.payload.filePath === "Other.ts")
			// maxDirectPerFile=2 should cap GameManager at 2 blocks
			expect(directsFromGM.length).toBe(2)
			// Other.ts should still appear (not squeezed out)
			expect(directsFromOther.length).toBe(1)
		})

		it("should keep highest-scored blocks when per-file limit applies", async () => {
			const hits = [
				makeHit("d1", 0.95, {
					filePath: "a.ts",
					codeChunk: "best",
					startLine: 1,
					endLine: 20,
					defines: [],
					refs: [],
				}),
				makeHit("d2", 0.7, {
					filePath: "a.ts",
					codeChunk: "mid",
					startLine: 30,
					endLine: 50,
					defines: [],
					refs: [],
				}),
				makeHit("d3", 0.6, {
					filePath: "a.ts",
					codeChunk: "low",
					startLine: 60,
					endLine: 80,
					defines: [],
					refs: [],
				}),
			]

			const results = await expander.expand(hits)

			const directsFromA = results.filter((r) => r.isDirectHit && r.payload.filePath === "a.ts")
			expect(directsFromA.length).toBe(2)
			// Should keep the top 2 by score
			expect(directsFromA[0].payload.codeChunk).toBe("best")
			expect(directsFromA[1].payload.codeChunk).toBe("mid")
		})
	})
})
