import { CreateMemoryTool } from "../CreateMemoryTool"

describe("CreateMemoryTool", () => {
	let tool: CreateMemoryTool

	beforeEach(() => {
		tool = new CreateMemoryTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("create_memory")
		})
	})

	describe("getMemoryFilePath", () => {
		it("should return correct path with .roo-memories.json filename", () => {
			const path = tool.getMemoryFilePath("/project/root")
			expect(path).toContain(".roo-memories.json")
			expect(path).toContain("project")
		})
	})

	describe("validateMemoryEntry", () => {
		it("should return no errors for valid entry", () => {
			const errors = tool.validateMemoryEntry({
				title: "Valid title",
				content: "Valid content",
				tags: ["valid_tag", "another_tag"],
			})
			expect(errors).toHaveLength(0)
		})

		it("should return error for empty title", () => {
			const errors = tool.validateMemoryEntry({
				title: "",
				content: "Content",
			})
			expect(errors).toContain("Title cannot be empty")
		})

		it("should return error for whitespace-only title", () => {
			const errors = tool.validateMemoryEntry({
				title: "   ",
				content: "Content",
			})
			expect(errors).toContain("Title cannot be empty")
		})

		it("should return error for missing content", () => {
			const errors = tool.validateMemoryEntry({
				title: "Title",
			})
			expect(errors).toContain("Content is required")
		})

		it("should return error for invalid tags", () => {
			const errors = tool.validateMemoryEntry({
				title: "Title",
				content: "Content",
				tags: ["ValidTag", "123invalid", "valid_tag"],
			})
			expect(errors.some((e) => e.includes("snake_case"))).toBe(true)
		})

		it("should accept valid snake_case tags", () => {
			const errors = tool.validateMemoryEntry({
				title: "Title",
				content: "Content",
				tags: ["user_preference", "tech_stack", "project_structure"],
			})
			expect(errors).toHaveLength(0)
		})
	})

	describe("loadMemoryStore", () => {
		it("should return empty store for non-existent file", async () => {
			const store = await tool.loadMemoryStore("/non/existent/path.json")
			expect(store.version).toBe(1)
			expect(store.memories).toEqual([])
		})
	})
})
