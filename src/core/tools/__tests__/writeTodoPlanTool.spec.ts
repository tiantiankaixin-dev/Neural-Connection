import { describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	buildPlanEntryContent,
	buildPlanTargetStubContent,
	readPlanFiles,
	savePlanFiles,
} from "../../task-persistence/plan-persistence"
import { WriteTodoPlanTool } from "../WriteTodoPlanTool"

describe("WriteTodoPlanTool", () => {
	function createTaskMock(globalStoragePath: string, overrides: Record<string, unknown> = {}) {
		return {
			globalStoragePath,
			taskId: "task-id",
			taskTimestamp: "timestamp",
			todoList: [
				{ id: "todo-id", content: "Backend layer", status: "in_progress", context: "" },
				{ id: "next-id", content: "Frontend layer", status: "pending", context: "" },
			],
			isRefineMode: true,
			activeRefineTodoItemIds: ["todo-id", "next-id"],
			pendingRefineStep3RetryTodoItemId: null,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			persistRefineResumeState: vi.fn(async () => undefined),
			clearSubagentResumeState: vi.fn(async () => undefined),
			persistSubagentResumeState: vi.fn(async () => undefined),
			applyTaskContextAgreementsToPlanEntries: vi.fn((plans) => ({ plans, appliedCount: 0 })),
			enqueuePostRefineAgreementPass: vi.fn(async () => ({
				executed: true,
				appendedCount: 0,
				fileAgreementCount: 0,
				planAgreementCount: 0,
				planAgreements: [],
			})),
			say: vi.fn(async () => undefined),
			...overrides,
		}
	}

	it("rejects STEP 2 file plan targets that were not seeded by STEP 1", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "write-todo-plan-"))
		await savePlanFiles(
			globalStoragePath,
			"task-id",
			"timestamp",
			"todo-id",
			"Backend layer",
			[
				{
					filePath: "routes/auth.js",
					content: buildPlanTargetStubContent({ target: "routes/auth.js", action: "MODIFY" }),
				},
			],
			"file",
		)

		const tool = new WriteTodoPlanTool()
		let toolResult = ""
		const task = createTaskMock(globalStoragePath, {
			todoList: [{ id: "todo-id", content: "Backend layer", status: "in_progress", context: "" }],
			activeRefineTodoItemIds: ["todo-id"],
		})

		await tool.execute(
			{
				todo_item_id: "todo-id",
				plan_type: "file",
				plans: [
					{
						target: "routes/session.js",
						action: "MODIFY",
						body: "## 文件用途\n- This should be inside an existing file target, not a new target.",
					},
				],
			},
			task as any,
			{
				askApproval: vi.fn() as any,
				handleError: vi.fn(),
				pushToolResult: (content: unknown) => {
					toolResult = String(content)
				},
			} as any,
		)

		expect(toolResult).toContain("STEP 2 cannot create new plan targets")
		expect(toolResult).toContain("routes/session.js")
		expect(toolResult).toContain("routes/auth.js")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("locks refine on the same todo and requires STEP 3 retry when agreement pass JSON fails", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "write-todo-plan-"))
		await savePlanFiles(
			globalStoragePath,
			"task-id",
			"timestamp",
			"todo-id",
			"Backend layer",
			[
				{
					filePath: "routes/auth.js",
					content: buildPlanTargetStubContent({ target: "routes/auth.js", action: "MODIFY" }),
				},
			],
			"file",
		)

		const tool = new WriteTodoPlanTool()
		let toolResult = ""
		const task = createTaskMock(globalStoragePath, {
			enqueuePostRefineAgreementPass: vi.fn(async () => ({
				executed: true,
				appendedCount: 0,
				fileAgreementCount: 0,
				error: "Invalid JSON response",
			})),
		})

		await tool.execute(
			{
				todo_item_id: "todo-id",
				plan_type: "file",
				plans: [
					{
						target: "routes/auth.js",
						action: "MODIFY",
						body: "Use POST /auth/login and return a token payload.",
					},
				],
			},
			task as any,
			{
				askApproval: vi.fn() as any,
				handleError: vi.fn(),
				pushToolResult: (content: unknown) => {
					toolResult = String(content)
				},
			} as any,
		)

		expect(task.pendingRefineStep3RetryTodoItemId).toBe("todo-id")
		expect(task.activeRefineTodoItemIds).toEqual(["todo-id", "next-id"])
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(toolResult).toContain("STEP 3 FAILED AFTER PLAN SAVE")
		expect(toolResult).toContain("RETRY REQUIRED")
		expect(toolResult).toContain("same todo_item_id")
		expect(toolResult).toContain("todo-id")
	})

	it("retries STEP 3 from saved plans without creating another plan file", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "write-todo-plan-"))
		await savePlanFiles(
			globalStoragePath,
			"task-id",
			"timestamp",
			"todo-id",
			"Backend layer",
			[
				{
					filePath: "routes/auth.js",
					content: buildPlanTargetStubContent({ target: "routes/auth.js", action: "MODIFY" }),
				},
			],
			"file",
		)
		await savePlanFiles(
			globalStoragePath,
			"task-id",
			"timestamp",
			"todo-id",
			"Backend layer",
			[
				{
					filePath: "routes/auth.js",
					content: buildPlanEntryContent({
						target: "routes/auth.js",
						action: "MODIFY",
						body: "Use POST /auth/login and return a token payload.",
					}),
				},
			],
			"file",
		)
		const beforeRetry = await readPlanFiles(globalStoragePath, "task-id", "timestamp", "todo-id", "Backend layer")

		const tool = new WriteTodoPlanTool()
		let toolResult = ""
		const task = createTaskMock(globalStoragePath, {
			pendingRefineStep3RetryTodoItemId: "todo-id",
			enqueuePostRefineAgreementPass: vi.fn(async () => ({
				executed: true,
				appendedCount: 0,
				fileAgreementCount: 0,
				planAgreementCount: 0,
				planAgreements: [],
			})),
		})

		await tool.execute(
			{
				todo_item_id: "todo-id",
				plan_type: "file",
				plans: [
					{
						target: "routes/auth.js",
						action: "MODIFY",
						body: "This submitted body should be ignored because STEP 3 retry reuses saved plans.",
					},
				],
			},
			task as any,
			{
				askApproval: vi.fn() as any,
				handleError: vi.fn(),
				pushToolResult: (content: unknown) => {
					toolResult = String(content)
				},
			} as any,
		)

		const afterRetry = await readPlanFiles(globalStoragePath, "task-id", "timestamp", "todo-id", "Backend layer")
		expect(task.enqueuePostRefineAgreementPass).toHaveBeenCalledWith(
			expect.objectContaining({ id: "todo-id" }),
			beforeRetry.plans,
		)
		expect(afterRetry.plans).toHaveLength(beforeRetry.plans.length)
		expect(task.pendingRefineStep3RetryTodoItemId).toBeNull()
		expect(toolResult).toContain("STEP 3 retry succeeded")
	})
})
