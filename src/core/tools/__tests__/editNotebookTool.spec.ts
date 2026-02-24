import { EditNotebookTool } from "../EditNotebookTool"

describe("EditNotebookTool", () => {
	let tool: EditNotebookTool

	beforeEach(() => {
		tool = new EditNotebookTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("edit_notebook")
		})
	})

	describe("createCell", () => {
		it("should create a code cell with correct structure", () => {
			const cell = tool.createCell("print('hello')", "code")

			expect(cell.cell_type).toBe("code")
			expect(cell.id).toBeDefined()
			expect(cell.id!.length).toBe(8)
			expect(cell.outputs).toEqual([])
			expect(cell.execution_count).toBeNull()
			expect(cell.metadata).toEqual({})
		})

		it("should create a markdown cell with correct structure", () => {
			const cell = tool.createCell("# Header", "markdown")

			expect(cell.cell_type).toBe("markdown")
			expect(cell.id).toBeDefined()
			expect(cell.outputs).toBeUndefined()
			expect(cell.execution_count).toBeUndefined()
		})

		it("should split source into lines", () => {
			const cell = tool.createCell("line1\nline2\nline3", "code")

			expect(cell.source).toEqual(["line1\n", "line2\n", "line3"])
		})

		it("should handle single line source", () => {
			const cell = tool.createCell("single line", "code")

			expect(cell.source).toEqual(["single line"])
		})

		it("should handle empty source", () => {
			const cell = tool.createCell("", "code")

			expect(cell.source).toEqual([""])
		})

		it("should generate unique IDs", () => {
			const cell1 = tool.createCell("a", "code")
			const cell2 = tool.createCell("b", "code")

			expect(cell1.id).not.toBe(cell2.id)
		})
	})
})
