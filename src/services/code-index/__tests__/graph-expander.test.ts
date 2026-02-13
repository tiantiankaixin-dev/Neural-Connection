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
			const hits = [
				makeHit("1", 0.9, { filePath: "a.ts", codeChunk: "code", startLine: 1, endLine: 5 }),
			]

			const results = await disabledExpander.expand(hits)

			expect(results.length).toBe(1)
			expect(results[0].isDirectHit).toBe(true)
			expect(results[0].score).toBe(0.9)
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

			expect(results.length).toBeLessThanOrEqual(3)
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
	 * Scoring formula under test (from computeScore):
	 *
	 *   vectorSim = parentVectorScore * 0.8
	 *   relationWeight = RELATION_WEIGHTS[relationType]   // calls=1.0, calledBy=0.9, sameClass=0.7, extends=0.5
	 *   pr = payload.pageRank || 0
	 *   rd = min(payload.refDensity || 0, 2) / 2
	 *
	 *   score = w.vectorSim(0.4) * vectorSim
	 *         + w.relation(0.25) * relationWeight
	 *         + w.pageRank(0.25) * pr
	 *         + w.refDensity(0.1) * rd
	 */
	describe("scoring — exact formula verification", () => {
		// Helper: compute expected score manually using the same formula
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
			const w = { vectorSim: 0.4, relation: 0.25, pageRank: 0.25, refDensity: 0.1 }
			const vectorSim = parentVectorScore * 0.8
			const relationWeight = RELATION_WEIGHTS_MAP[relationType]
			const pr = pageRank
			const rd = Math.min(refDensity, 2) / 2
			return w.vectorSim * vectorSim + w.relation * relationWeight + w.pageRank * pr + w.refDensity * rd
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
			// Verify: 0.4*(0.9*0.8) + 0.25*1.0 + 0.25*0.6 + 0.1*(0.4/2)
			//       = 0.4*0.72     + 0.25      + 0.15      + 0.1*0.2
			//       = 0.288        + 0.25      + 0.15      + 0.02
			//       = 0.708
			expect(target.score).toBeCloseTo(0.708, 10)
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
			// 0.4*(0.85*0.8) + 0.25*0.9 + 0.25*0.3 + 0.1*(1.0/2)
			// = 0.272         + 0.225    + 0.075    + 0.05
			// = 0.622
			expect(caller.score).toBeCloseTo(0.622, 10)
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
			// 0.4*(0.7*0.8) + 0.25*0.7 + 0.25*0 + 0.1*0
			// = 0.224        + 0.175    + 0      + 0
			// = 0.399
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
			// 0.4*(0.8*0.8) + 0.25*0.5 + 0.25*1.0 + 0.1*(0.8/2)
			// = 0.256        + 0.125    + 0.25     + 0.04
			// = 0.671
			expect(parentBlock.score).toBeCloseTo(0.671, 10)
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

			mockQdrant.findBlocksByDefines.mockResolvedValue([
				{ id: "rel", score: 0, payload: relatedPayload },
			])

			const r1 = await expander.expand(hits1)
			const score1 = r1.find((r) => r.id === "rel")!.score

			const expander2 = new GraphExpander(mockQdrant)
			const r2 = await expander2.expand(hits2)
			const score2 = r2.find((r) => r.id === "rel")!.score

			// Difference should be exactly: 0.4 * 0.8 * (1.0 - 0.5) = 0.16
			expect(score1 - score2).toBeCloseTo(0.4 * 0.8 * 0.5, 10)
		})

		it("should use custom weights when configured", async () => {
			const customExpander = new GraphExpander(mockQdrant, {
				weights: { vectorSim: 0.0, relation: 0.0, pageRank: 1.0, refDensity: 0.0 },
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
			// With all weights zero except pageRank=1.0: score = 1.0 * 0.75 = 0.75
			expect(block.score).toBeCloseTo(0.75, 10)
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
			// 0.4*(0.9*0.8) + 0.25*1.0 + 0 + 0 = 0.288 + 0.25 = 0.538
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
					payload: { filePath: "b.ts", codeChunk: "rel", startLine: 1, endLine: 5, pageRank: 0.5, refDensity: 0 },
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
					payload: { filePath: `f${i}.ts`, codeChunk: `c${i}`, startLine: 1, endLine: 5, pageRank: 0, refDensity: 0 },
				})),
			)

			expander.updateConfig({ maxResults: 3 })
			const results = await expander.expand(hits)
			expect(results.length).toBeLessThanOrEqual(3)
		})

		it("should update weights via updateConfig()", async () => {
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
					payload: { filePath: "b.ts", codeChunk: "t", startLine: 1, endLine: 5, pageRank: 0.8, refDensity: 0 },
				},
			])

			// Score with default weights
			const r1 = await expander.expand(hits)
			const score1 = r1.find((r) => r.id === "target")!.score

			// Change to pageRank-only weighting
			expander.updateConfig({ weights: { vectorSim: 0, relation: 0, pageRank: 1.0, refDensity: 0 } })
			const r2 = await expander.expand(hits)
			const score2 = r2.find((r) => r.id === "target")!.score

			expect(score2).toBeCloseTo(0.8, 10) // 1.0 * 0.8
			expect(score2).not.toBeCloseTo(score1, 2) // Different from default
		})
	})

	describe("findBlocksByDefines/Refs limit parameter", () => {
		it("should pass limit=10 for refs→definers expansion", async () => {
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

			expect(mockQdrant.findBlocksByDefines).toHaveBeenCalledWith(["someSymbol"], 10)
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
})
