import { SearchWebTool } from "../SearchWebTool"

describe("SearchWebTool", () => {
	let tool: SearchWebTool

	beforeEach(() => {
		tool = new SearchWebTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("search_web")
		})
	})

	describe("extractActualUrl", () => {
		it("should extract URL from DuckDuckGo redirect", () => {
			const ddgUrl = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123"
			expect(tool.extractActualUrl(ddgUrl)).toBe("https://example.com/page")
		})

		it("should return http URLs as-is", () => {
			expect(tool.extractActualUrl("http://example.com")).toBe("http://example.com")
		})

		it("should return https URLs as-is", () => {
			expect(tool.extractActualUrl("https://example.com/path")).toBe("https://example.com/path")
		})

		it("should handle protocol-relative URLs", () => {
			expect(tool.extractActualUrl("//example.com")).toBe("https://example.com")
		})
	})

	describe("formatResult", () => {
		it("should format success result with results correctly", () => {
			const result = tool.formatResult({
				status: "success",
				query: "test query",
				results: [
					{
						title: "Test Result",
						url: "https://example.com",
						snippet: "This is a test snippet",
					},
				],
			})

			expect(result).toContain("Search Results")
			expect(result).toContain("test query")
			expect(result).toContain("Test Result")
			expect(result).toContain("https://example.com")
			expect(result).toContain("This is a test snippet")
		})

		it("should format success result with domain filter", () => {
			const result = tool.formatResult({
				status: "success",
				query: "test query",
				domain: "example.com",
				results: [],
			})

			expect(result).toContain("Domain Filter:** example.com")
		})

		it("should format error result correctly", () => {
			const result = tool.formatResult({
				status: "error",
				query: "test query",
				error: "Network error",
			})

			expect(result).toContain("Search Failed")
			expect(result).toContain("test query")
			expect(result).toContain("Network error")
		})

		it("should handle no results", () => {
			const result = tool.formatResult({
				status: "success",
				query: "obscure query",
				results: [],
			})

			expect(result).toContain("No results found")
		})

		it("should format multiple results correctly", () => {
			const result = tool.formatResult({
				status: "success",
				query: "test",
				results: [
					{ title: "Result 1", url: "https://a.com", snippet: "Snippet 1" },
					{ title: "Result 2", url: "https://b.com", snippet: "Snippet 2" },
					{ title: "Result 3", url: "https://c.com", snippet: "Snippet 3" },
				],
			})

			expect(result).toContain("Results:** 3")
			expect(result).toContain("### 1. Result 1")
			expect(result).toContain("### 2. Result 2")
			expect(result).toContain("### 3. Result 3")
		})
	})
})
