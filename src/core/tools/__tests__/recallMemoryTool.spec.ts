import { RecallMemoryTool, recallMemoryTool } from "../RecallMemoryTool"
import { regressMemory, formatRegressionResult, RegressionResult } from "../../condense/regression"
import { SummaryPanel, SummaryEntry } from "../../webview/SummaryPanel"

// Mock memory-persistence (disk loading)
vi.mock("../../task-persistence/memory-persistence", () => ({
	loadAllSummaryEntries: vi.fn().mockResolvedValue([]),
	loadGlobalSummary: vi.fn().mockResolvedValue(null),
}))

import { loadAllSummaryEntries, loadGlobalSummary } from "../../task-persistence/memory-persistence"

describe("RecallMemoryTool", () => {
	let tool: RecallMemoryTool

	beforeEach(() => {
		tool = new RecallMemoryTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("recall_memory")
		})
	})

	describe("singleton export", () => {
		it("should export a singleton instance", () => {
			expect(recallMemoryTool).toBeInstanceOf(RecallMemoryTool)
			expect(recallMemoryTool.name).toBe("recall_memory")
		})
	})

	describe("execute", () => {
		let mockTask: any
		let mockPushToolResult: any
		let mockHandleError: any
		let capturedResult: string | undefined

		beforeEach(() => {
			vi.clearAllMocks()
			capturedResult = undefined

			mockTask = {
				consecutiveMistakeCount: 0,
				didToolFailInCurrentTurn: false,
				globalStoragePath: "/mock/global/storage",
				taskId: "test-task-123",
				sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter: query"),
				recordToolError: vi.fn(),
				recordToolUsage: vi.fn(),
				getRegressionApiHandler: vi.fn().mockResolvedValue(null),
			}

			mockPushToolResult = vi.fn((result: string) => {
				capturedResult = result
			})

			mockHandleError = vi.fn()
		})

		it("should error when query is empty", async () => {
			await tool.execute({ query: "" }, mockTask, {
				askApproval: vi.fn(),
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("recall_memory")
			expect(mockTask.didToolFailInCurrentTurn).toBe(true)
			expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("recall_memory", "query")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter: query")
		})

		it("should error when query is whitespace only", async () => {
			await tool.execute({ query: "   " }, mockTask, {
				askApproval: vi.fn(),
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("recall_memory")
		})

		it("should error when query is undefined", async () => {
			await tool.execute({ query: undefined as any }, mockTask, {
				askApproval: vi.fn(),
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(1)
		})

		it("should return error when no regression model is configured", async () => {
			mockTask.getRegressionApiHandler.mockResolvedValue(undefined)

			await tool.execute({ query: "test query" }, mockTask, {
				askApproval: vi.fn(),
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockPushToolResult).toHaveBeenCalled()
			expect(capturedResult).toContain("No regression model configured")
		})

		it("should call handleError on unexpected exception", async () => {
			mockTask.getRegressionApiHandler.mockRejectedValue(new Error("API explosion"))

			await tool.execute({ query: "test query" }, mockTask, {
				askApproval: vi.fn(),
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockHandleError).toHaveBeenCalledWith("recalling memory", expect.any(Error))
		})
	})
})

describe("regressMemory", () => {
	let mockSummaryPanel: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Reset SummaryPanel singleton entries
		mockSummaryPanel = SummaryPanel.getInstance()
		// Clear entries by accessing internal state
		;(mockSummaryPanel as any).entries = []
	})

	it("should return error when no entries available", async () => {
		const mockApi = {} as any
		const result = await regressMemory("test query", mockApi)

		expect(result.success).toBe(false)
		expect(result.error).toContain("No summary entries available")
		expect(result.chain).toHaveLength(0)
		expect(result.originalMessages).toHaveLength(0)
	})

	it("should return global Q sourceMessages when only global entry exists", async () => {
		const globalEntry: SummaryEntry = {
			id: "global-1",
			timestamp: Date.now(),
			text: "Global summary of everything",
			isGlobal: true,
			sourceMessages: [
				{ role: "user", content: "Hello", ts: 1000, id: "msg-1" },
				{ role: "assistant", content: "Hi there", ts: 2000, id: "msg-2" },
			],
		}
		;(mockSummaryPanel as any).entries = [globalEntry]

		const mockApi = {} as any
		const result = await regressMemory("test query", mockApi)

		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(1)
		expect(result.chain[0].level).toBe("global")
		expect(result.originalMessages).toHaveLength(2)
	})

	it("should return error when only global Q exists without sourceMessages", async () => {
		const globalEntry: SummaryEntry = {
			id: "global-1",
			timestamp: Date.now(),
			text: "Global summary",
			isGlobal: true,
		}
		;(mockSummaryPanel as any).entries = [globalEntry]

		const mockApi = {} as any
		const result = await regressMemory("test query", mockApi)

		expect(result.success).toBe(false)
		expect(result.error).toContain("No detailed summaries available")
	})

	it("should return single non-global summary directly without model call", async () => {
		const entry: SummaryEntry = {
			id: "summary-1",
			timestamp: Date.now(),
			text: "Summary about authentication",
			isGlobal: false,
			sourceMessages: [{ role: "user", content: "Fix auth", ts: 1000, id: "msg-1" }],
		}
		;(mockSummaryPanel as any).entries = [entry]

		const mockApi = {} as any
		const result = await regressMemory("auth bug", mockApi)

		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(1)
		expect(result.chain[0].level).toBe("individual")
		expect(result.chain[0].entryId).toBe("summary-1")
		expect(result.originalMessages).toHaveLength(1)
	})

	it("should return single rolling summary directly without model call", async () => {
		const entry: SummaryEntry = {
			id: "rolling-1",
			timestamp: Date.now(),
			text: "Rolling summary of recent work",
			isGlobal: false,
			isRolling: true,
			sourceMessages: [{ role: "user", content: "Continue working", ts: 3000, id: "msg-3" }],
		}
		;(mockSummaryPanel as any).entries = [entry]

		const mockApi = {} as any
		const result = await regressMemory("recent work", mockApi)

		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(1)
		expect(result.chain[0].level).toBe("rolling")
	})

	it("should ask regression model when multiple summaries exist", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "summary-1",
				timestamp: Date.now() - 10000,
				text: "Summary about authentication",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "Fix auth", ts: 1000, id: "msg-1" }],
			},
			{
				id: "summary-2",
				timestamp: Date.now(),
				text: "Summary about dashboard UI",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "Build dashboard", ts: 2000, id: "msg-2" }],
			},
		]
		;(mockSummaryPanel as any).entries = entries

		// Mock API handler that returns "2" (selecting the dashboard summary)
		const mockApi = {
			createMessage: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text", text: "2" }
				})(),
			),
			getModel: vi.fn().mockReturnValue({ id: "test-model" }),
		} as any

		const result = await regressMemory("dashboard", mockApi)

		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(1) // no global, just selected individual
		expect(result.chain[0].entryId).toBe("summary-2")
		expect(result.originalMessages).toHaveLength(1)
		expect(result.originalMessages[0].content).toBe("Build dashboard")
	})

	it("should include global Q in chain when present alongside other summaries", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "global-1",
				timestamp: Date.now() - 20000,
				text: "Global overview",
				isGlobal: true,
			},
			{
				id: "summary-1",
				timestamp: Date.now(),
				text: "Detail about feature X",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "Implement X", ts: 1000, id: "msg-1" }],
			},
		]
		;(mockSummaryPanel as any).entries = entries

		const mockApi = {} as any
		const result = await regressMemory("feature X", mockApi)

		// Single non-global summary → direct return, but global Q should be in chain
		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(2) // global + individual
		expect(result.chain[0].level).toBe("global")
		expect(result.chain[1].level).toBe("individual")
	})

	it("should handle unparseable model response", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "s1",
				timestamp: Date.now(),
				text: "Summary A",
				isGlobal: false,
				sourceMessages: [],
			},
			{
				id: "s2",
				timestamp: Date.now(),
				text: "Summary B",
				isGlobal: false,
				sourceMessages: [],
			},
		]
		;(mockSummaryPanel as any).entries = entries

		const mockApi = {
			createMessage: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text", text: "I think both are relevant" }
				})(),
			),
		} as any

		const result = await regressMemory("query", mockApi)

		expect(result.success).toBe(false)
		expect(result.error).toContain("unparseable")
	})

	it("should handle out-of-range model response", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "s1",
				timestamp: Date.now(),
				text: "Summary A",
				isGlobal: false,
				sourceMessages: [],
			},
			{
				id: "s2",
				timestamp: Date.now(),
				text: "Summary B",
				isGlobal: false,
				sourceMessages: [],
			},
		]
		;(mockSummaryPanel as any).entries = entries

		const mockApi = {
			createMessage: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "text", text: "5" }
				})(),
			),
		} as any

		const result = await regressMemory("query", mockApi)

		expect(result.success).toBe(false)
		expect(result.error).toContain("out-of-range")
	})

	it("should handle model call failure", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "s1",
				timestamp: Date.now(),
				text: "Summary A",
				isGlobal: false,
				sourceMessages: [],
			},
			{
				id: "s2",
				timestamp: Date.now(),
				text: "Summary B",
				isGlobal: false,
				sourceMessages: [],
			},
		]

		expect(result.success).toBe(true)
		expect(result.chain).toHaveLength(1) // no global, just selected individual
		expect(result.chain[0].entryId).toBe("summary-2")
		expect(result.originalMessages).toHaveLength(1)
		expect(result.originalMessages[0].content).toBe("Build dashboard")
	})

	it("should include global Q in chain when present alongside other summaries", async () => {
		const entries: SummaryEntry[] = [
			{
				id: "global-1",
				timestamp: Date.now() - 20000,
				text: "Global overview",
				isGlobal: true,
			},
			{
				id: "summary-1",
				timestamp: Date.now(),
				text: "Detail about feature X",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "Implement X", ts: 1000, id: "msg-1" }],
			},
		]
		;(mockSummaryPanel as any).entries = entries

		const mockApi = {} as any
		const result = await regressMemory("feature X", mockApi)
		expect(result.success).toBe(false)
		expect(result.error).toContain("Regression model call failed")
	})

	describe("disk loading", () => {
		it("should load entries from disk when globalStoragePath and taskId provided", async () => {
			const diskEntries: SummaryEntry[] = [
				{
					id: "disk-1",
					timestamp: Date.now(),
					text: "Disk summary",
					isGlobal: false,
					sourceMessages: [{ role: "user", content: "From disk", ts: 5000, id: "msg-d1" }],
				},
			]
			;(loadAllSummaryEntries as any).mockResolvedValue(diskEntries)
			;(loadGlobalSummary as any).mockResolvedValue(null)

			const mockApi = {} as any
			const result = await regressMemory("test", mockApi, {
				globalStoragePath: "/mock/storage",
				taskId: "task-abc",
			})

			expect(loadAllSummaryEntries).toHaveBeenCalledWith("/mock/storage", "task-abc")
			expect(result.success).toBe(true)
			expect(result.chain[0].entryId).toBe("disk-1")
		})

		it("should prepend Global Q from disk if not already in entries", async () => {
			const diskEntries: SummaryEntry[] = [
				{
					id: "disk-1",
					timestamp: Date.now(),
					text: "Individual summary",
					isGlobal: false,
					sourceMessages: [{ role: "user", content: "Work", ts: 5000, id: "msg-1" }],
				},
			]
			;(loadAllSummaryEntries as any).mockResolvedValue(diskEntries)
			;(loadGlobalSummary as any).mockResolvedValue({
				condenseId: "global-disk",
				timestamp: Date.now() - 10000,
				text: "Global Q from disk",
			})

			const mockApi = {} as any
			const result = await regressMemory("test", mockApi, {
				globalStoragePath: "/mock/storage",
				taskId: "task-abc",
			})

			expect(result.success).toBe(true)
			expect(result.chain).toHaveLength(2)
			expect(result.chain[0].level).toBe("global")
			expect(result.chain[0].summaryText).toBe("Global Q from disk")
		})

		it("should fall back to SummaryPanel when disk load fails", async () => {
			;(loadAllSummaryEntries as any).mockRejectedValue(new Error("Disk read error"))

			// Put something in SummaryPanel as fallback
			const fallbackEntry: SummaryEntry = {
				id: "memory-1",
				timestamp: Date.now(),
				text: "In-memory summary",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "Fallback", ts: 1000, id: "msg-f1" }],
			}
			;(mockSummaryPanel as any).entries = [fallbackEntry]

			const mockApi = {} as any
			const result = await regressMemory("test", mockApi, {
				globalStoragePath: "/mock/storage",
				taskId: "task-abc",
			})

			expect(result.success).toBe(true)
			expect(result.chain[0].entryId).toBe("memory-1")
		})

		it("should fall back to SummaryPanel when disk returns empty", async () => {
			;(loadAllSummaryEntries as any).mockResolvedValue([])
			;(loadGlobalSummary as any).mockResolvedValue(null)

			const memEntry: SummaryEntry = {
				id: "mem-1",
				timestamp: Date.now(),
				text: "Memory panel entry",
				isGlobal: false,
				sourceMessages: [{ role: "user", content: "In memory", ts: 1000, id: "msg-m1" }],
			}
			;(mockSummaryPanel as any).entries = [memEntry]

			const mockApi = {} as any
			const result = await regressMemory("test", mockApi, {
				globalStoragePath: "/mock/storage",
				taskId: "task-abc",
			})

			expect(result.success).toBe(true)
			expect(result.chain[0].entryId).toBe("mem-1")
		})
	})
})

describe("formatRegressionResult", () => {
	it("should format failure result", () => {
		const result: RegressionResult = {
			success: false,
			query: "test query",
			chain: [],
			originalMessages: [],
			error: "No entries",
		}

		const formatted = formatRegressionResult(result)
		expect(formatted).toContain("[Memory Regression]")
		expect(formatted).toContain("No relevant original messages")
		expect(formatted).toContain("test query")
		expect(formatted).toContain("No entries")
	})

	it("should format success result with chain and messages", () => {
		const result: RegressionResult = {
			success: true,
			query: "auth bug",
			chain: [
				{
					level: "global",
					summaryText: "Global overview of the project and authentication work",
					entryId: "g1",
				},
				{ level: "individual", summaryText: "Fixed token refresh in auth module", entryId: "s1" },
			],
			originalMessages: [
				{ role: "user", content: "Fix the auth token refresh bug", ts: 1000 },
				{ role: "assistant", content: "I found the issue in auth.ts", ts: 2000 },
			],
		}

		const formatted = formatRegressionResult(result)
		expect(formatted).toContain("[Memory Regression]")
		expect(formatted).toContain("Drill-down")
		expect(formatted).toContain("Global Q")
		expect(formatted).toContain("Individual Summary")
		expect(formatted).toContain("Original Messages")
		expect(formatted).toContain("Fix the auth token refresh bug")
		expect(formatted).toContain("I found the issue in auth.ts")
	})

	it("should format empty originalMessages as failure", () => {
		const result: RegressionResult = {
			success: true,
			query: "test",
			chain: [{ level: "individual", summaryText: "Some summary", entryId: "s1" }],
			originalMessages: [],
		}

		const formatted = formatRegressionResult(result)
		expect(formatted).toContain("No relevant original messages")
	})

	it("should handle rolling summary in chain", () => {
		const result: RegressionResult = {
			success: true,
			query: "recent work",
			chain: [{ level: "rolling", summaryText: "Rolling summary of recent changes", entryId: "r1" }],
			originalMessages: [{ role: "user", content: "Continue with the refactoring" }],
		}

		const formatted = formatRegressionResult(result)
		expect(formatted).toContain("Rolling Summary")
	})

	it("should handle messages with array content", () => {
		const result: RegressionResult = {
			success: true,
			query: "test",
			chain: [{ level: "individual", summaryText: "Summary", entryId: "s1" }],
			originalMessages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Here is the code fix" },
						{ type: "text", text: "And more details" },
					],
				},
			],
		}

		const formatted = formatRegressionResult(result)
		expect(formatted).toContain("Here is the code fix")
		expect(formatted).toContain("And more details")
	})
})
