// FoldedFileContext tests - summarizeConversation integration tests removed.
// Unit tests for generateFoldedFileContext are kept.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { generateFoldedFileContext } from "../foldedFileContext"

vi.mock("../../../services/tree-sitter/languageParser", () => ({
	parseSourceCodeDefinitions: vi.fn().mockResolvedValue("function foo()\nclass Bar"),
}))

vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("file content"),
}))

describe("foldedFileContext", () => {
	describe("generateFoldedFileContext", () => {
		it("should return empty sections for empty file list", async () => {
			const result = await generateFoldedFileContext([], { cwd: "/test" })
			expect(result.sections).toEqual([])
			expect(result.filesProcessed).toBe(0)
		})
	})
})
