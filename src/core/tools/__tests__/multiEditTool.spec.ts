import { MultiEditTool } from "../MultiEditTool"

describe("MultiEditTool", () => {
	let tool: MultiEditTool

	beforeEach(() => {
		tool = new MultiEditTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("multi_edit")
		})
	})

	describe("validateAndApplyEdits", () => {
		it("should validate valid edits", () => {
			const content = "hello world\nfoo bar\nbaz qux"
			const edits = [
				{ old_string: "hello", new_string: "HELLO" },
				{ old_string: "foo", new_string: "FOO" },
			]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(true)
		})

		it("should reject when old_string not found", () => {
			const content = "hello world"
			const edits = [{ old_string: "notfound", new_string: "replacement" }]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(false)
			expect(result.error).toContain("No match found")
			expect(result.editIndex).toBe(0)
		})

		it("should reject ambiguous match without replace_all", () => {
			const content = "hello hello world"
			const edits = [{ old_string: "hello", new_string: "hi" }]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(false)
			expect(result.error).toContain("2 matches")
		})

		it("should allow multiple matches with replace_all", () => {
			const content = "hello hello world"
			const edits = [{ old_string: "hello", new_string: "hi", replace_all: true }]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(true)
		})

		it("should handle sequential edits correctly", () => {
			const content = "aaa bbb ccc"
			const edits = [
				{ old_string: "aaa", new_string: "AAA" },
				{ old_string: "AAA bbb", new_string: "XXX" },
			]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(true)
		})

		it("should reject if earlier edit breaks later edit", () => {
			const content = "aaa bbb"
			const edits = [
				{ old_string: "aaa bbb", new_string: "XXX" },
				{ old_string: "bbb", new_string: "BBB" }, // This won't exist after first edit
			]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(false)
			expect(result.editIndex).toBe(1)
		})

		it("should normalize line endings", () => {
			const content = "hello\r\nworld"
			const edits = [{ old_string: "hello\nworld", new_string: "replaced" }]

			const result = tool.validateAndApplyEdits(content, edits)
			expect(result.valid).toBe(true)
		})
	})
})
