import { ReadTerminalTool } from "../ReadTerminalTool"

describe("ReadTerminalTool", () => {
	let tool: ReadTerminalTool

	beforeEach(() => {
		tool = new ReadTerminalTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("read_terminal")
		})
	})

	describe("formatResult", () => {
		it("should format found terminal with output correctly", () => {
			const result = tool.formatResult({
				status: "found",
				terminal_id: 1,
				is_busy: false,
				last_command: "npm test",
				output: "test output here",
				output_truncated: false,
			})

			expect(result).toContain("Terminal Content")
			expect(result).toContain("Terminal ID:** 1")
			expect(result).toContain("Idle")
			expect(result).toContain("npm test")
			expect(result).toContain("test output here")
		})

		it("should format busy terminal correctly", () => {
			const result = tool.formatResult({
				status: "found",
				terminal_id: 2,
				is_busy: true,
				output: "running...",
				output_truncated: false,
			})

			expect(result).toContain("Running")
			expect(result).toContain("Terminal ID:** 2")
		})

		it("should format not_found status correctly", () => {
			const result = tool.formatResult({
				status: "not_found",
				terminal_id: 99,
				error: "Terminal not found",
			})

			expect(result).toContain("Not Found")
			expect(result).toContain("Terminal ID:** 99")
			expect(result).toContain("Error")
		})

		it("should indicate truncated output", () => {
			const result = tool.formatResult({
				status: "found",
				terminal_id: 1,
				is_busy: false,
				output: "partial output",
				output_truncated: true,
			})

			expect(result).toContain("truncated")
		})

		it("should handle empty output", () => {
			const result = tool.formatResult({
				status: "found",
				terminal_id: 1,
				is_busy: false,
				output: "",
				output_truncated: false,
			})

			expect(result).toContain("(no output)")
		})
	})
})
