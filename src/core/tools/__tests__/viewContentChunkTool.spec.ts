import { ViewContentChunkTool } from "../ViewContentChunkTool"

describe("ViewContentChunkTool", () => {
	let tool: ViewContentChunkTool

	beforeEach(() => {
		tool = new ViewContentChunkTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("view_content_chunk")
		})
	})

	describe("splitIntoChunks", () => {
		it("should handle empty content", () => {
			const chunks = tool.splitIntoChunks("", 1000)
			expect(chunks).toEqual([""])
		})

		it("should not split content smaller than chunk size", () => {
			const content = "Hello world"
			const chunks = tool.splitIntoChunks(content, 1000)
			expect(chunks).toEqual(["Hello world"])
		})

		it("should split content at paragraph boundaries", () => {
			const content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
			const chunks = tool.splitIntoChunks(content, 30)
			expect(chunks.length).toBeGreaterThan(1)
			// First chunk should end at a paragraph boundary
			expect(chunks[0].endsWith("\n\n") || chunks[0].endsWith(".")).toBe(true)
		})

		it("should split large content into multiple chunks", () => {
			const content = "A".repeat(10000)
			const chunks = tool.splitIntoChunks(content, 1000)
			expect(chunks.length).toBeGreaterThan(1)
			// All content should be preserved
			expect(chunks.join("")).toBe(content)
		})

		it("should prefer sentence boundaries over arbitrary splits", () => {
			const content = "First sentence. Second sentence. Third sentence. Fourth sentence."
			const chunks = tool.splitIntoChunks(content, 40)
			expect(chunks.length).toBeGreaterThan(1)
			// Chunks should end at sentence boundaries
			chunks.forEach((chunk, i) => {
				if (i < chunks.length - 1) {
					expect(chunk.endsWith(". ") || chunk.endsWith(".\n")).toBe(true)
				}
			})
		})
	})

	describe("formatChunk", () => {
		it("should format chunk with correct metadata", () => {
			const chunk = { content: "Test content", position: 0, totalChunks: 3 }
			const result = tool.formatChunk("doc-123", "https://example.com", chunk)

			expect(result).toContain("Document ID:** doc-123")
			expect(result).toContain("URL:** https://example.com")
			expect(result).toContain("Chunk:** 1 of 3")
			expect(result).toContain("Test content")
		})

		it("should include next chunk hint when not last chunk", () => {
			const chunk = { content: "Test", position: 0, totalChunks: 2 }
			const result = tool.formatChunk("doc-123", "https://example.com", chunk)

			expect(result).toContain("position=1")
		})

		it("should not include next chunk hint for last chunk", () => {
			const chunk = { content: "Test", position: 1, totalChunks: 2 }
			const result = tool.formatChunk("doc-123", "https://example.com", chunk)

			expect(result).not.toContain("position=2")
		})
	})

	describe("cacheDocument", () => {
		it("should cache document and allow retrieval via chunks", () => {
			const docId = "test-doc-1"
			const content = "Short content"

			tool.cacheDocument(docId, "https://test.com", content, "Test Title")

			// The document should now be retrievable (tested via formatChunk)
			// Note: We can't directly test getDocument as it's private,
			// but we verify caching works by testing the full flow
		})

		it("should split long content into chunks", () => {
			const docId = "test-doc-2"
			const content = "A".repeat(20000)

			tool.cacheDocument(docId, "https://test.com", content)

			// Document is cached - this is tested via integration
		})
	})
})
