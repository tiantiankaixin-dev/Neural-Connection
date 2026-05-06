import { describe, expect, it } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { buildPlanEntryContent, readPlanFiles, savePlanFiles, validatePlanTargetStubEntry } from "../plan-persistence"

describe("validatePlanTargetStubEntry", () => {
	it("accepts root project dotfiles as real file targets", () => {
		expect(validatePlanTargetStubEntry({ target: ".env", action: "CREATE" })).toBeNull()
		expect(validatePlanTargetStubEntry({ target: ".env.local", action: "CREATE" })).toBeNull()
		expect(validatePlanTargetStubEntry({ target: ".gitignore", action: "MODIFY" })).toBeNull()
		expect(validatePlanTargetStubEntry({ target: ".npmrc", action: "MODIFY" })).toBeNull()
	})

	it("continues to reject non-file target descriptions", () => {
		expect(validatePlanTargetStubEntry({ target: "Backend implementation", action: "CREATE" })).toContain(
			"real relative project file path",
		)
		expect(validatePlanTargetStubEntry({ target: ".", action: "CREATE" })).toContain(
			"real relative project file path",
		)
		expect(validatePlanTargetStubEntry({ target: "..", action: "CREATE" })).toContain(
			"real relative project file path",
		)
	})
})

describe("readPlanFiles", () => {
	it("does not parse markdown headings inside task context or plan bodies as separate plans", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "plan-persistence-"))
		const body = [
			"## 文件用途",
			"- Own authentication routes.",
			"",
			"## 引用依赖",
			"- imports db helpers.",
			"",
			"## 被引用",
			"- server.js mounts this router.",
		].join("\n")

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
						body,
					}),
				},
			],
			"file",
			["## Task Context", "- Architecture role: Own backend auth."].join("\n"),
		)

		const result = await readPlanFiles(globalStoragePath, "task-id", "timestamp", "todo-id", "Backend layer")

		expect(result.contexts).toHaveLength(1)
		expect(result.contexts[0]).toContain("## Task Context")
		expect(result.plans).toHaveLength(1)
		expect(result.plans[0].filePath).toBe("routes/auth.js")
		expect(result.plans[0].content).toContain("## 文件用途")
		expect(result.plans[0].content).toContain("## 引用依赖")
		expect(result.plans[0].content).toContain("## 被引用")
		expect(result.stubPlans).toHaveLength(0)
	})
})
