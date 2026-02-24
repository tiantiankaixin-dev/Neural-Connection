import { ReadUrlContentTool } from "../ReadUrlContentTool"

describe("ReadUrlContentTool", () => {
	let tool: ReadUrlContentTool

	beforeEach(() => {
		tool = new ReadUrlContentTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("read_url_content")
		})
	})

	describe("isValidUrl", () => {
		it("should accept valid http URLs", () => {
			expect(tool.isValidUrl("http://example.com")).toBe(true)
			expect(tool.isValidUrl("http://example.com/path")).toBe(true)
			expect(tool.isValidUrl("http://example.com:8080/path")).toBe(true)
		})

		it("should accept valid https URLs", () => {
			expect(tool.isValidUrl("https://example.com")).toBe(true)
			expect(tool.isValidUrl("https://docs.example.com/api")).toBe(true)
		})

		it("should reject invalid URLs", () => {
			expect(tool.isValidUrl("not a url")).toBe(false)
			expect(tool.isValidUrl("ftp://example.com")).toBe(false)
			expect(tool.isValidUrl("file:///path/to/file")).toBe(false)
			expect(tool.isValidUrl("")).toBe(false)
		})
	})

	describe("formatResult", () => {
		it("should format success result correctly", () => {
			const result = tool.formatResult({
				status: "success",
				url: "https://example.com",
				title: "Example Page",
				content: "Page content here",
				content_truncated: false,
			})

			expect(result).toContain("URL Content")
			expect(result).toContain("https://example.com")
			expect(result).toContain("Example Page")
			expect(result).toContain("Page content here")
		})

		it("should format error result correctly", () => {
			const result = tool.formatResult({
				status: "error",
				url: "https://example.com/notfound",
				error: "HTTP 404: Not Found",
			})

			expect(result).toContain("Failed to Read URL")
			expect(result).toContain("https://example.com/notfound")
			expect(result).toContain("HTTP 404: Not Found")
		})

		it("should indicate truncated content", () => {
			const result = tool.formatResult({
				status: "success",
				url: "https://example.com",
				content: "truncated content",
				content_truncated: true,
			})

			expect(result).toContain("truncated")
		})

		it("should handle missing title", () => {
			const result = tool.formatResult({
				status: "success",
				url: "https://example.com",
				content: "content without title",
				content_truncated: false,
			})

			expect(result).toContain("URL Content")
			expect(result).not.toContain("Title:")
		})

		it("should handle empty content", () => {
			const result = tool.formatResult({
				status: "success",
				url: "https://example.com",
				content: "",
				content_truncated: false,
			})

			expect(result).toContain("(no content)")
		})
	})
})
