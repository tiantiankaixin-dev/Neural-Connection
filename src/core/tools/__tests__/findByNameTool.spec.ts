import { FindByNameTool } from "../FindByNameTool"

describe("FindByNameTool", () => {
	let tool: FindByNameTool

	beforeEach(() => {
		tool = new FindByNameTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("find_by_name")
		})
	})

	describe("matchGlob", () => {
		it("should match simple wildcards", () => {
			expect(tool.matchGlob("test.ts", "*.ts")).toBe(true)
			expect(tool.matchGlob("test.js", "*.ts")).toBe(false)
			expect(tool.matchGlob("test.tsx", "*.ts*")).toBe(true)
		})

		it("should match globstar patterns", () => {
			expect(tool.matchGlob("src/components/Button.tsx", "**/*.tsx")).toBe(true)
			expect(tool.matchGlob("Button.tsx", "**/*.tsx")).toBe(true)
		})

		it("should match single character wildcards", () => {
			expect(tool.matchGlob("test1.ts", "test?.ts")).toBe(true)
			expect(tool.matchGlob("test12.ts", "test?.ts")).toBe(false)
		})

		it("should be case insensitive", () => {
			expect(tool.matchGlob("Test.TS", "*.ts")).toBe(true)
			expect(tool.matchGlob("TEST.ts", "test.ts")).toBe(true)
		})
	})

	describe("formatSize", () => {
		it("should format bytes correctly", () => {
			expect(tool.formatSize(500)).toBe("500B")
			expect(tool.formatSize(1024)).toBe("1.0KB")
			expect(tool.formatSize(1024 * 1024)).toBe("1.0MB")
			expect(tool.formatSize(1024 * 1024 * 1024)).toBe("1.0GB")
		})

		it("should handle edge cases", () => {
			expect(tool.formatSize(0)).toBe("0B")
			expect(tool.formatSize(1023)).toBe("1023B")
			expect(tool.formatSize(1025)).toBe("1.0KB")
		})
	})
})
