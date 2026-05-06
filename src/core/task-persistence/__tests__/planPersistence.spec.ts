import { describe, expect, it } from "vitest"

import { validatePlanTargetStubEntry } from "../plan-persistence"

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
