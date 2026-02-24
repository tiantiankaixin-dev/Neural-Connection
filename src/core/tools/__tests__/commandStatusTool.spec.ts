import { CommandStatusTool } from "../CommandStatusTool"

describe("CommandStatusTool", () => {
	let tool: CommandStatusTool

	beforeEach(() => {
		tool = new CommandStatusTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("command_status")
		})
	})

	describe("formatResult", () => {
		it("should format running status correctly", () => {
			const result = tool.formatResult({
				status: "running",
				terminal_id: 1,
				output: "test output",
				output_truncated: false,
			})

			expect(result).toContain("RUNNING")
			expect(result).toContain("Terminal ID:** 1")
			expect(result).toContain("test output")
		})

		it("should format done status correctly", () => {
			const result = tool.formatResult({
				status: "done",
				terminal_id: 2,
				output: "completed output",
				output_truncated: false,
			})

			expect(result).toContain("DONE")
			expect(result).toContain("Terminal ID:** 2")
			expect(result).toContain("completed output")
		})

		it("should format not_found status correctly", () => {
			const result = tool.formatResult({
				status: "not_found",
				terminal_id: 99,
				error: "Terminal not found",
			})

			expect(result).toContain("NOT_FOUND")
			expect(result).toContain("Terminal ID:** 99")
			expect(result).toContain("Error")
		})

		it("should indicate truncated output", () => {
			const result = tool.formatResult({
				status: "running",
				terminal_id: 1,
				output: "partial output",
				output_truncated: true,
			})

			expect(result).toContain("truncated")
		})

		it("should handle empty output", () => {
			const result = tool.formatResult({
				status: "done",
				terminal_id: 1,
				output: "",
				output_truncated: false,
			})

			expect(result).toContain("(no output)")
		})
	})
})
