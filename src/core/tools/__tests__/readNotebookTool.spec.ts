import { ReadNotebookTool } from "../ReadNotebookTool"

describe("ReadNotebookTool", () => {
	let tool: ReadNotebookTool

	beforeEach(() => {
		tool = new ReadNotebookTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("read_notebook")
		})
	})

	describe("normalizeSource", () => {
		it("should handle string source", () => {
			expect(tool.normalizeSource("hello world")).toBe("hello world")
		})

		it("should join array source", () => {
			expect(tool.normalizeSource(["line1\n", "line2\n", "line3"])).toBe("line1\nline2\nline3")
		})

		it("should handle empty array", () => {
			expect(tool.normalizeSource([])).toBe("")
		})
	})

	describe("formatNotebook", () => {
		it("should format empty notebook", () => {
			const notebook = { cells: [], nbformat: 4, nbformat_minor: 5 }
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("Jupyter Notebook: test.ipynb")
			expect(result).toContain("Cells:** 0")
			expect(result).toContain("No cells")
		})

		it("should format code cell", () => {
			const notebook = {
				cells: [
					{
						cell_type: "code" as const,
						id: "cell-1",
						source: ["print('hello')"],
						execution_count: 1,
						outputs: [],
					},
				],
				nbformat: 4,
				nbformat_minor: 5,
			}
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("Cell 0 [code]")
			expect(result).toContain("id: cell-1")
			expect(result).toContain("Execution count:** 1")
			expect(result).toContain("print('hello')")
		})

		it("should format markdown cell", () => {
			const notebook = {
				cells: [
					{
						cell_type: "markdown" as const,
						source: ["# Header\n", "Some text"],
					},
				],
				nbformat: 4,
				nbformat_minor: 5,
			}
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("Cell 0 [markdown]")
			expect(result).toContain("# Header")
		})

		it("should format code cell with stream output", () => {
			const notebook = {
				cells: [
					{
						cell_type: "code" as const,
						source: ["print('test')"],
						outputs: [
							{
								output_type: "stream",
								text: ["test output\n"],
							},
						],
					},
				],
				nbformat: 4,
				nbformat_minor: 5,
			}
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("Outputs:")
			expect(result).toContain("stream")
			expect(result).toContain("test output")
		})

		it("should format code cell with error output", () => {
			const notebook = {
				cells: [
					{
						cell_type: "code" as const,
						source: ["1/0"],
						outputs: [
							{
								output_type: "error",
								ename: "ZeroDivisionError",
								evalue: "division by zero",
								traceback: ["Traceback line 1", "Traceback line 2"],
							},
						],
					},
				],
				nbformat: 4,
				nbformat_minor: 5,
			}
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("error: ZeroDivisionError")
			expect(result).toContain("division by zero")
		})

		it("should format multiple cells", () => {
			const notebook = {
				cells: [
					{ cell_type: "markdown" as const, source: ["# Title"] },
					{ cell_type: "code" as const, source: ["x = 1"] },
					{ cell_type: "code" as const, source: ["print(x)"] },
				],
				nbformat: 4,
				nbformat_minor: 5,
			}
			const result = tool.formatNotebook(notebook, "test.ipynb")

			expect(result).toContain("Cells:** 3")
			expect(result).toContain("Cell 0 [markdown]")
			expect(result).toContain("Cell 1 [code]")
			expect(result).toContain("Cell 2 [code]")
		})
	})
})
