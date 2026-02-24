import { TaskMemoryTool, TaskMemoryStore, TaskMemoryEntry } from "../TaskMemoryTool"

describe("TaskMemoryTool", () => {
	let tool: TaskMemoryTool

	beforeEach(() => {
		tool = new TaskMemoryTool()
	})

	describe("name", () => {
		it("should have the correct name", () => {
			expect(tool.name).toBe("task_memory")
		})
	})

	describe("getMemoryFilePath", () => {
		it("should return correct path with .roo-task-memories.json filename", () => {
			const filePath = tool.getMemoryFilePath("/project/root")
			expect(filePath).toContain(".roo-task-memories.json")
			expect(filePath).toContain("project")
		})

		it("should handle different cwd paths", () => {
			const path1 = tool.getMemoryFilePath("/a")
			const path2 = tool.getMemoryFilePath("/b")
			expect(path1).not.toBe(path2)
		})
	})

	describe("loadMemoryStore", () => {
		it("should return empty store for non-existent file", async () => {
			const store = await tool.loadMemoryStore("/non/existent/path.json")
			expect(store.version).toBe(1)
			expect(store.tasks).toEqual([])
		})
	})

	describe("searchTasks", () => {
		const now = new Date().toISOString()
		const earlier = new Date(Date.now() - 3600000).toISOString()

		const mockStore: TaskMemoryStore = {
			version: 1,
			tasks: [
				{
					id: "task-1",
					rooTaskId: "roo-1",
					status: "completed",
					title: "Fix authentication bug",
					description: "Token refresh was broken on mobile",
					previousContextSummary: "User had set up project and designed the database schema",
					taskSummary: "Fixed token refresh logic in auth.ts",
					keyFiles: ["src/auth/token.ts"],
					tags: ["bugfix", "auth"],
					startedAt: earlier,
					completedAt: now,
					conversationRef: {
						taskId: "roo-1",
						messageCountAtStart: 0,
						messageCountAtEnd: 20,
					},
				},
				{
					id: "task-2",
					rooTaskId: "roo-2",
					status: "active",
					title: "Implement user dashboard",
					description: "Create React dashboard with charts",
					previousContextSummary: "Fixed auth bug, now moving to dashboard feature",
					taskSummary: "",
					keyFiles: [],
					tags: ["feature", "frontend"],
					startedAt: now,
					completedAt: null,
					conversationRef: {
						taskId: "roo-2",
						messageCountAtStart: 0,
						messageCountAtEnd: null,
					},
				},
				{
					id: "task-3",
					rooTaskId: "roo-3",
					status: "completed",
					title: "Database migration",
					description: "Migrate user table to new schema",
					previousContextSummary: "Initial project setup was done",
					taskSummary: "Created migration script for user table",
					keyFiles: ["migrations/001_user_table.sql"],
					tags: ["database", "migration"],
					startedAt: earlier,
					completedAt: earlier,
					conversationRef: {
						taskId: "roo-3",
						messageCountAtStart: 5,
						messageCountAtEnd: 15,
					},
				},
			],
		}

		it("should return all tasks when no query or tags", () => {
			const results = tool.searchTasks(mockStore)
			expect(results).toHaveLength(3)
		})

		it("should filter by tags", () => {
			const results = tool.searchTasks(mockStore, undefined, ["auth"])
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-1")
		})

		it("should filter by multiple tags (OR logic)", () => {
			const results = tool.searchTasks(mockStore, undefined, ["auth", "frontend"])
			expect(results).toHaveLength(2)
		})

		it("should filter by query text in title", () => {
			const results = tool.searchTasks(mockStore, "dashboard")
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-2")
		})

		it("should filter by query text in description", () => {
			const results = tool.searchTasks(mockStore, "token refresh")
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-1")
		})

		it("should filter by query text in taskSummary", () => {
			const results = tool.searchTasks(mockStore, "migration script")
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-3")
		})

		it("should filter by query text in previousContextSummary", () => {
			const results = tool.searchTasks(mockStore, "database schema")
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-1")
		})

		it("should be case-insensitive", () => {
			const results = tool.searchTasks(mockStore, "DASHBOARD")
			expect(results).toHaveLength(1)
			expect(results[0].id).toBe("task-2")
		})

		it("should combine query and tags filter", () => {
			// "migration" matches task-3, but tag "auth" only matches task-1
			const results = tool.searchTasks(mockStore, "migration", ["auth"])
			expect(results).toHaveLength(0) // No task has both "migration" text AND "auth" tag
		})

		it("should return empty array for no matches", () => {
			const results = tool.searchTasks(mockStore, "nonexistent query")
			expect(results).toHaveLength(0)
		})

		it("should sort by most recent first", () => {
			const results = tool.searchTasks(mockStore)
			// task-2 started at 'now', task-1 and task-3 started at 'earlier'
			expect(results[0].id).toBe("task-2")
		})

		it("should handle empty store", () => {
			const emptyStore: TaskMemoryStore = { version: 1, tasks: [] }
			const results = tool.searchTasks(emptyStore, "anything")
			expect(results).toHaveLength(0)
		})

		it("should handle empty query string", () => {
			const results = tool.searchTasks(mockStore, "")
			expect(results).toHaveLength(3) // empty query returns all
		})

		it("should handle whitespace-only query", () => {
			const results = tool.searchTasks(mockStore, "   ")
			expect(results).toHaveLength(3) // whitespace-only query returns all
		})
	})

	describe("TaskMemoryEntry structure", () => {
		it("should have correct fields for a completed task", () => {
			const entry: TaskMemoryEntry = {
				id: "test-id",
				rooTaskId: "roo-task-123",
				status: "completed",
				title: "Test task",
				description: "A test task",
				previousContextSummary: "Previous context",
				taskSummary: "What was done",
				keyFiles: ["file1.ts", "file2.ts"],
				tags: ["test"],
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: "2025-01-01T01:00:00Z",
				conversationRef: {
					taskId: "roo-task-123",
					messageCountAtStart: 0,
					messageCountAtEnd: 30,
				},
			}

			expect(entry.status).toBe("completed")
			expect(entry.conversationRef.messageCountAtEnd).toBe(30)
			expect(entry.keyFiles).toHaveLength(2)
		})

		it("should have correct fields for an active task", () => {
			const entry: TaskMemoryEntry = {
				id: "test-id-2",
				rooTaskId: "roo-task-456",
				status: "active",
				title: "Active task",
				description: "In progress",
				previousContextSummary: "Context before",
				taskSummary: "",
				keyFiles: [],
				tags: [],
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: null,
				conversationRef: {
					taskId: "roo-task-456",
					messageCountAtStart: 10,
					messageCountAtEnd: null,
				},
			}

			expect(entry.status).toBe("active")
			expect(entry.completedAt).toBeNull()
			expect(entry.conversationRef.messageCountAtEnd).toBeNull()
			expect(entry.taskSummary).toBe("")
		})
	})

	describe("TaskMemoryStore structure", () => {
		it("should have version and tasks array", () => {
			const store: TaskMemoryStore = {
				version: 1,
				tasks: [],
			}
			expect(store.version).toBe(1)
			expect(store.tasks).toEqual([])
		})
	})
})
