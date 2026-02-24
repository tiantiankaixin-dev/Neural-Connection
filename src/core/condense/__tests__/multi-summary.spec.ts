// npx vitest src/core/condense/__tests__/multi-summary.spec.ts

/**
 * Tests for the Multi-Summary Model in getEffectiveApiHistory and
 * the segmented tagging behavior in summarizeConversation.
 *
 * The multi-summary model allows multiple sub-task summaries to coexist,
 * replacing the old "Fresh Start" model where only the last summary was visible.
 */

import Anthropic from "@anthropic-ai/sdk"
import { TelemetryService } from "@roo-code/telemetry"

import {
	getEffectiveApiHistory,
	getMessagesSinceLastSummary,
	summarizeConversation,
	generateGlobalSummaryText,
	autoUpdateGlobalSummary,
} from "../index"
import { ApiMessage } from "../../task-persistence/apiMessages"

// Mock the telemetry service
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: { captureContextCondensed: vi.fn() },
		hasInstance: () => true,
		createInstance: vi.fn(),
	},
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

describe("Multi-Summary Model", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})

	describe("getEffectiveApiHistory - multiple summaries", () => {
		it("should keep ALL sub-task summaries visible", () => {
			const s1 = "subtask-1"
			const s2 = "subtask-2"

			const messages: ApiMessage[] = [
				{ role: "user", content: "Task start", ts: 1, condenseParent: s1 },
				{ role: "assistant", content: "Working on subtask 1", ts: 2, condenseParent: s1 },
				{
					role: "user",
					content: "## Sub-Task Summary: Auth\nBuilt auth module",
					ts: 3,
					isSummary: true,
					condenseId: s1,
				},
				{ role: "user", content: "Now do subtask 2", ts: 4, condenseParent: s2 },
				{ role: "assistant", content: "Working on subtask 2", ts: 5, condenseParent: s2 },
				{
					role: "user",
					content: "## Sub-Task Summary: DB\nBuilt database",
					ts: 6,
					isSummary: true,
					condenseId: s2,
				},
				{ role: "user", content: "What next?", ts: 7 },
				{ role: "assistant", content: "Let me check", ts: 8 },
			]

			const effective = getEffectiveApiHistory(messages)

			// Should see: summary1 + summary2 + raw messages
			expect(effective.length).toBe(4)
			expect(effective[0].isSummary).toBe(true)
			expect(effective[0].condenseId).toBe(s1)
			expect(effective[1].isSummary).toBe(true)
			expect(effective[1].condenseId).toBe(s2)
			expect(effective[2].content).toBe("What next?")
			expect(effective[3].content).toBe("Let me check")
		})

		it("should keep three sub-task summaries visible", () => {
			const s1 = "subtask-1"
			const s2 = "subtask-2"
			const s3 = "subtask-3"

			const messages: ApiMessage[] = [
				// Sub-task 1 (condensed)
				{ role: "user", content: "msg1", ts: 1, condenseParent: s1 },
				{ role: "assistant", content: "msg2", ts: 2, condenseParent: s1 },
				{ role: "user", content: "Summary 1", ts: 3, isSummary: true, condenseId: s1 },
				// Sub-task 2 (condensed)
				{ role: "user", content: "msg3", ts: 4, condenseParent: s2 },
				{ role: "assistant", content: "msg4", ts: 5, condenseParent: s2 },
				{ role: "user", content: "Summary 2", ts: 6, isSummary: true, condenseId: s2 },
				// Sub-task 3 (condensed)
				{ role: "user", content: "msg5", ts: 7, condenseParent: s3 },
				{ role: "assistant", content: "msg6", ts: 8, condenseParent: s3 },
				{ role: "user", content: "Summary 3", ts: 9, isSummary: true, condenseId: s3 },
				// Current raw messages
				{ role: "user", content: "Current work", ts: 10 },
			]

			const effective = getEffectiveApiHistory(messages)

			// summary1 + summary2 + summary3 + current
			expect(effective.length).toBe(4)
			expect(effective[0].content).toBe("Summary 1")
			expect(effective[1].content).toBe("Summary 2")
			expect(effective[2].content).toBe("Summary 3")
			expect(effective[3].content).toBe("Current work")
		})

		it("should handle backward-compatible old data (all messages tagged)", () => {
			// Old format: ALL messages tagged with condenseParent, including previous summaries
			const s1 = "old-condense-1"
			const s2 = "old-condense-2"

			const messages: ApiMessage[] = [
				{ role: "user", content: "msg1", ts: 1, condenseParent: s1 },
				{ role: "assistant", content: "msg2", ts: 2, condenseParent: s1 },
				// Summary 1 was tagged with s2's condenseParent during second condense (old behavior)
				{ role: "user", content: "Summary 1", ts: 3, isSummary: true, condenseId: s1, condenseParent: s2 },
				{ role: "user", content: "msg3", ts: 4, condenseParent: s2 },
				{ role: "assistant", content: "msg4", ts: 5, condenseParent: s2 },
				{ role: "user", content: "Summary 2", ts: 6, isSummary: true, condenseId: s2 },
			]

			const effective = getEffectiveApiHistory(messages)

			// Summary 1 has condenseParent=s2, and s2's summary is at index 5.
			// Summary 1 is at index 2, which is BEFORE index 5. So it gets filtered.
			// This matches the old "Fresh Start" behavior: only the last summary visible.
			expect(effective.length).toBe(1)
			expect(effective[0].content).toBe("Summary 2")
			expect(effective[0].condenseId).toBe(s2)
		})

		it("should handle messages after summary with condenseParent (old data edge case)", () => {
			const s1 = "condense-1"

			const messages: ApiMessage[] = [
				{ role: "user", content: "msg1", ts: 1, condenseParent: s1 },
				{ role: "user", content: "Summary", ts: 2, isSummary: true, condenseId: s1 },
				// In old data, messages after summary might have condenseParent
				{ role: "user", content: "After summary", ts: 3, condenseParent: s1 },
				{ role: "assistant", content: "Response", ts: 4, condenseParent: s1 },
			]

			const effective = getEffectiveApiHistory(messages)

			// msg1 is before summary → filtered
			// "After summary" and "Response" are AFTER summary → kept (position-aware)
			expect(effective.length).toBe(3)
			expect(effective[0].content).toBe("Summary")
			expect(effective[1].content).toBe("After summary")
			expect(effective[2].content).toBe("Response")
		})

		it("should handle orphan tool_results at sub-task boundaries", () => {
			const s1 = "subtask-1"
			const toolUseId = "tool-abc"

			const messages: ApiMessage[] = [
				// Sub-task 1: assistant calls a tool, then sub-task is condensed
				{
					role: "assistant",
					content: [{ type: "tool_use", id: toolUseId, name: "read_file", input: { path: "test.ts" } }],
					ts: 1,
					condenseParent: s1,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: toolUseId, content: "file contents" }],
					ts: 2,
					condenseParent: s1,
				},
				{ role: "user", content: "Summary 1", ts: 3, isSummary: true, condenseId: s1 },
				// New tool call after summary
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-new", name: "write_file", input: { path: "out.ts" } }],
					ts: 4,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool-new", content: "written" }],
					ts: 5,
				},
			]

			const effective = getEffectiveApiHistory(messages)

			// Condensed tool messages filtered, summary kept, new tool messages kept
			expect(effective.length).toBe(3) // summary + new tool_use + new tool_result
			expect(effective[0].isSummary).toBe(true)
		})
	})

	describe("summarizeConversation - segmented tagging", () => {
		const mockApiHandler = {
			createMessage: vi.fn(),
			countTokens: vi.fn().mockResolvedValue(100),
			getModel: vi.fn().mockReturnValue({ info: { supportsImages: true } }),
		} as any

		beforeEach(() => {
			vi.clearAllMocks()
			// Mock createMessage to return a summary
			mockApiHandler.createMessage.mockImplementation(async function* () {
				yield { type: "text", text: "This is a sub-task summary" }
				yield { type: "usage", totalCost: 0.01, outputTokens: 50 }
			})
		})

		it("should only tag messages after last summary (not previous summaries)", async () => {
			const prevCondenseId = "prev-summary"

			const messages: ApiMessage[] = [
				// Already condensed by a previous summary
				{ role: "user", content: "Old msg 1", ts: 1, condenseParent: prevCondenseId },
				{ role: "assistant", content: "Old msg 2", ts: 2, condenseParent: prevCondenseId },
				// Previous summary
				{ role: "user", content: "Previous summary", ts: 3, isSummary: true, condenseId: prevCondenseId },
				// New messages (should be tagged)
				{ role: "user", content: "New msg 1", ts: 4 },
				{ role: "assistant", content: "New msg 2", ts: 5 },
				{ role: "user", content: "New msg 3", ts: 6 },
			]

			const result = await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId: "test-task",
				isAutomaticTrigger: false,
			})

			expect(result.error).toBeUndefined()

			// Previous summary should NOT be tagged
			const prevSummary = result.messages.find((m) => m.content === "Previous summary")
			expect(prevSummary).toBeDefined()
			expect(prevSummary!.isSummary).toBe(true)
			expect(prevSummary!.condenseParent).toBeUndefined()

			// Already-condensed messages should keep their existing condenseParent
			const oldMsg1 = result.messages.find((m) => m.content === "Old msg 1")
			expect(oldMsg1!.condenseParent).toBe(prevCondenseId) // Unchanged

			// New messages should be tagged with the new condenseId
			const newMsg1 = result.messages.find((m) => m.content === "New msg 1")
			const newMsg2 = result.messages.find((m) => m.content === "New msg 2")
			const newMsg3 = result.messages.find((m) => m.content === "New msg 3")
			expect(newMsg1!.condenseParent).toBeDefined()
			expect(newMsg2!.condenseParent).toBeDefined()
			expect(newMsg3!.condenseParent).toBeDefined()
			// All new messages should have the same condenseParent (the new condenseId)
			expect(newMsg1!.condenseParent).toBe(newMsg2!.condenseParent)
			expect(newMsg2!.condenseParent).toBe(newMsg3!.condenseParent)

			// New summary should exist
			const newSummary = result.messages.find((m) => m.isSummary && m.content !== "Previous summary")
			expect(newSummary).toBeDefined()
			expect(newSummary!.condenseId).toBe(newMsg1!.condenseParent)
		})

		it("should use subtaskTitle in summary heading when provided", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Work on auth", ts: 1 },
				{ role: "assistant", content: "Building auth module", ts: 2 },
				{ role: "user", content: "Done?", ts: 3 },
			]

			const result = await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "",
				taskId: "test-task",
				isAutomaticTrigger: false,
				subtaskTitle: "Implement Authentication",
			})

			expect(result.error).toBeUndefined()

			const summary = result.messages.find((m) => m.isSummary)
			expect(summary).toBeDefined()
			const content = summary!.content as Anthropic.Messages.ContentBlockParam[]
			const textBlock = content.find(
				(b) => b.type === "text" && (b as any).text.includes("Sub-Task Summary"),
			) as any
			expect(textBlock).toBeDefined()
			expect(textBlock.text).toContain("Sub-Task Summary: Implement Authentication")
		})

		it("should use default heading when subtaskTitle is not provided", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Do something", ts: 1 },
				{ role: "assistant", content: "Done", ts: 2 },
				{ role: "user", content: "More", ts: 3 },
			]

			const result = await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "",
				taskId: "test-task",
				isAutomaticTrigger: false,
			})

			expect(result.error).toBeUndefined()

			const summary = result.messages.find((m) => m.isSummary)
			const content = summary!.content as Anthropic.Messages.ContentBlockParam[]
			const textBlock = content.find(
				(b) => b.type === "text" && (b as any).text.includes("Conversation Summary"),
			) as any
			expect(textBlock).toBeDefined()
			expect(textBlock.text).toContain("## Conversation Summary")
		})
	})

	describe("Multi-summary end-to-end flow", () => {
		it("should produce correct effective history after two sub-task condensations", () => {
			// Simulate what happens after two task_memory(end) calls:
			// Sub-task 1: messages 0-4, condensed to summary_1
			// Sub-task 2: messages 5-8, condensed to summary_2
			// Current: messages 9-10
			const s1 = "subtask-condense-1"
			const s2 = "subtask-condense-2"

			const messages: ApiMessage[] = [
				// Sub-task 1 messages (condensed)
				{ role: "user", content: "Start auth", ts: 1, condenseParent: s1 },
				{ role: "assistant", content: "Creating auth", ts: 2, condenseParent: s1 },
				{ role: "user", content: "Add OAuth", ts: 3, condenseParent: s1 },
				{ role: "assistant", content: "Added OAuth", ts: 4, condenseParent: s1 },
				// Sub-task 1 summary
				{
					role: "user",
					content: "## Sub-Task Summary: Auth\nImplemented full auth with OAuth",
					ts: 5,
					isSummary: true,
					condenseId: s1,
				},
				// Sub-task 2 messages (condensed)
				{ role: "user", content: "Start database", ts: 6, condenseParent: s2 },
				{ role: "assistant", content: "Setting up DB", ts: 7, condenseParent: s2 },
				{ role: "user", content: "Add migrations", ts: 8, condenseParent: s2 },
				{ role: "assistant", content: "Added migrations", ts: 9, condenseParent: s2 },
				// Sub-task 2 summary
				{
					role: "user",
					content: "## Sub-Task Summary: Database\nSet up DB with migrations",
					ts: 10,
					isSummary: true,
					condenseId: s2,
				},
				// Current raw messages (active sub-task)
				{ role: "user", content: "Now build the API", ts: 11 },
				{ role: "assistant", content: "Starting API routes", ts: 12 },
			]

			const effective = getEffectiveApiHistory(messages)

			// Model should see: [summary_auth, summary_db, "Now build the API", "Starting API routes"]
			expect(effective.length).toBe(4)
			expect(effective[0].content).toContain("Auth")
			expect(effective[0].isSummary).toBe(true)
			expect(effective[1].content).toContain("Database")
			expect(effective[1].isSummary).toBe(true)
			expect(effective[2].content).toBe("Now build the API")
			expect(effective[3].content).toBe("Starting API routes")
		})

		it("should handle partial summary merge (context full during active sub-task)", () => {
			// When context gets full during an active sub-task, manageContext creates
			// a partial summary. Later, when task_memory(end) runs, the partial summary
			// + new messages get condensed into a final summary.
			const s1 = "subtask-1-complete"
			const s2_partial = "subtask-2-partial"
			const s2_final = "subtask-2-final"

			const messages: ApiMessage[] = [
				// Sub-task 1 (fully condensed)
				{ role: "user", content: "msg1", ts: 1, condenseParent: s1 },
				{ role: "user", content: "Summary: Sub-task 1 done", ts: 2, isSummary: true, condenseId: s1 },
				// Sub-task 2 partial (first batch condensed by auto-condense)
				{ role: "user", content: "msg2", ts: 3, condenseParent: s2_partial },
				{ role: "assistant", content: "msg3", ts: 4, condenseParent: s2_partial },
				// Partial summary — later tagged with s2_final's condenseParent when final condensation runs
				{
					role: "user",
					content: "Partial summary of sub-task 2",
					ts: 5,
					isSummary: true,
					condenseId: s2_partial,
					condenseParent: s2_final,
				},
				// Sub-task 2 continued after partial summary
				{ role: "user", content: "msg4", ts: 6, condenseParent: s2_final },
				// Final summary from task_memory(end)
				{
					role: "user",
					content: "Final summary: Sub-task 2 complete",
					ts: 7,
					isSummary: true,
					condenseId: s2_final,
				},
				// Current messages
				{ role: "user", content: "What's next?", ts: 8 },
			]

			const effective = getEffectiveApiHistory(messages)

			// Should see: summary1 + summary2_final + current
			// The partial summary should be hidden because it was tagged with s2_final's condenseParent
			const summaries = effective.filter((m) => m.isSummary)
			expect(summaries.length).toBe(2)
			expect(summaries[0].content).toContain("Sub-task 1 done")
			expect(summaries[1].content).toContain("Sub-task 2 complete")

			const nonSummary = effective.filter((m) => !m.isSummary)
			expect(nonSummary.length).toBe(1)
			expect(nonSummary[0].content).toBe("What's next?")
		})
	})

	describe("summarizeConversation - summarizeFromIndex (full-quality)", () => {
		const mockApiHandler = {
			createMessage: vi.fn(),
			countTokens: vi.fn().mockResolvedValue(100),
			getModel: vi.fn().mockReturnValue({ info: { supportsImages: true } }),
		} as any

		beforeEach(() => {
			vi.clearAllMocks()
			mockApiHandler.createMessage.mockImplementation(async function* () {
				yield { type: "text", text: "Comprehensive sub-task summary" }
				yield { type: "usage", totalCost: 0.01, outputTokens: 50 }
			})
		})

		it("should tag ALL messages from summarizeFromIndex including intermediate summaries", async () => {
			const partialId = "partial-summary"

			const messages: ApiMessage[] = [
				// Messages before the sub-task (should NOT be tagged)
				{ role: "user", content: "Pre-task msg", ts: 1 },
				{ role: "user", content: "Old summary", ts: 2, isSummary: true, condenseId: "old-s" },
				// Sub-task starts at index 2 (after old summary)
				{ role: "user", content: "Sub-task msg 1", ts: 3 },
				{ role: "assistant", content: "Sub-task msg 2", ts: 4 },
				// Intermediate partial summary from auto-condense
				{ role: "user", content: "Partial summary", ts: 5, isSummary: true, condenseId: partialId },
				// More sub-task messages
				{ role: "user", content: "Sub-task msg 3", ts: 6 },
				{ role: "assistant", content: "Sub-task msg 4", ts: 7 },
			]

			const result = await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "",
				taskId: "test",
				subtaskTitle: "Full Quality Test",
				summarizeFromIndex: 2, // Start from "Sub-task msg 1"
			})

			expect(result.error).toBeUndefined()

			// Pre-task messages should be UNTOUCHED
			const preTaskMsg = result.messages.find((m) => m.content === "Pre-task msg")
			expect(preTaskMsg!.condenseParent).toBeUndefined()

			// Old summary should be UNTOUCHED
			const oldSummary = result.messages.find((m) => m.content === "Old summary")
			expect(oldSummary!.condenseParent).toBeUndefined()
			expect(oldSummary!.isSummary).toBe(true)

			// Sub-task messages should be tagged
			const stMsg1 = result.messages.find((m) => m.content === "Sub-task msg 1")
			const stMsg2 = result.messages.find((m) => m.content === "Sub-task msg 2")
			const stMsg3 = result.messages.find((m) => m.content === "Sub-task msg 3")
			const stMsg4 = result.messages.find((m) => m.content === "Sub-task msg 4")
			expect(stMsg1!.condenseParent).toBeDefined()
			expect(stMsg2!.condenseParent).toBeDefined()
			expect(stMsg3!.condenseParent).toBeDefined()
			expect(stMsg4!.condenseParent).toBeDefined()

			// CRITICAL: Intermediate partial summary should ALSO be tagged (replaced by comprehensive summary)
			const partialSummary = result.messages.find((m) => m.content === "Partial summary")
			expect(partialSummary!.condenseParent).toBeDefined()
			expect(partialSummary!.condenseParent).toBe(stMsg1!.condenseParent)

			// New comprehensive summary should exist
			const newSummary = result.messages.find(
				(m) => m.isSummary && !m.condenseParent && m.content !== "Old summary",
			)
			expect(newSummary).toBeDefined()
			const content = newSummary!.content as any[]
			expect(content[0].text).toContain("Sub-Task Summary: Full Quality Test")
		})

		it("should produce correct effective history after full-quality condensation", async () => {
			const partialId = "partial-summary"

			const messages: ApiMessage[] = [
				{ role: "user", content: "Old summary", ts: 1, isSummary: true, condenseId: "old-s" },
				{ role: "user", content: "msg1", ts: 2 },
				{ role: "assistant", content: "msg2", ts: 3 },
				{ role: "user", content: "Partial", ts: 4, isSummary: true, condenseId: partialId },
				{ role: "user", content: "msg3", ts: 5 },
				{ role: "assistant", content: "msg4", ts: 6 },
			]

			const result = await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "",
				taskId: "test",
				subtaskTitle: "DB Setup",
				summarizeFromIndex: 1, // From msg1
			})

			expect(result.error).toBeUndefined()

			const effective = getEffectiveApiHistory(result.messages)

			// Should see: old_summary + new_comprehensive_summary
			// The partial summary should be hidden (tagged with condenseParent)
			const summaries = effective.filter((m) => m.isSummary)
			expect(summaries.length).toBe(2)
			expect(summaries[0].content).toBe("Old summary")
			const newContent = summaries[1].content as any[]
			expect(newContent[0].text).toContain("Sub-Task Summary: DB Setup")
		})

		it("should include intermediate summaries in messages sent to LLM", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "Old summary", ts: 1, isSummary: true, condenseId: "old-s" },
				{ role: "user", content: "Start work", ts: 2 },
				{ role: "assistant", content: "Working...", ts: 3 },
				{ role: "user", content: "Mid summary", ts: 4, isSummary: true, condenseId: "mid-s" },
				{ role: "user", content: "More work", ts: 5 },
			]

			await summarizeConversation({
				messages,
				apiHandler: mockApiHandler,
				systemPrompt: "",
				taskId: "test",
				summarizeFromIndex: 1,
			})

			// Verify that createMessage was called with messages from index 1 onward
			// (including the intermediate "Mid summary")
			const callArgs = mockApiHandler.createMessage.mock.calls[0]
			const requestMessages = callArgs[1] as any[]
			const allText = requestMessages
				.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
				.join(" ")
			expect(allText).toContain("Start work")
			expect(allText).toContain("Mid summary")
			expect(allText).toContain("More work")
		})
	})

	describe("getMessagesSinceLastSummary with multi-summary", () => {
		it("should return messages since the LAST summary only", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "msg1", ts: 1 },
				{ role: "user", content: "Summary 1", ts: 2, isSummary: true, condenseId: "s1" },
				{ role: "user", content: "msg2", ts: 3 },
				{ role: "user", content: "Summary 2", ts: 4, isSummary: true, condenseId: "s2" },
				{ role: "user", content: "msg3", ts: 5 },
				{ role: "assistant", content: "msg4", ts: 6 },
			]

			const since = getMessagesSinceLastSummary(messages)

			// Should return from Summary 2 onwards
			expect(since.length).toBe(3)
			expect(since[0].content).toBe("Summary 2")
			expect(since[1].content).toBe("msg3")
			expect(since[2].content).toBe("msg4")
		})
	})

	describe("Global Summary Q Model", () => {
		describe("getEffectiveApiHistory with isGlobalSummary", () => {
			it("should show Q + current messages (no stacked partials)", () => {
				const qId = "global-q-1"
				const sA = "subtask-a"

				const messages: ApiMessage[] = [
					// Task A messages (condensed by individual summary)
					{ role: "user", content: "task A msg", ts: 1, condenseParent: sA },
					// Individual summary A (hidden by Q)
					{ role: "user", content: "Summary A", ts: 2, isSummary: true, condenseId: sA, condenseParent: qId },
					// Global Q
					{
						role: "user",
						content: "## Global Task Summary\nAll tasks done",
						ts: 3,
						isSummary: true,
						isGlobalSummary: true,
						condenseId: qId,
					},
					// Current messages
					{ role: "user", content: "What next?", ts: 4 },
					{ role: "assistant", content: "Let me check", ts: 5 },
				]

				const effective = getEffectiveApiHistory(messages)

				// Model sees: [Q, "What next?", "Let me check"]
				expect(effective.length).toBe(3)
				expect(effective[0].isGlobalSummary).toBe(true)
				expect(effective[1].content).toBe("What next?")
				expect(effective[2].content).toBe("Let me check")
			})

			it("should show Q + stacked partials + current messages", () => {
				const qId = "global-q-1"
				const sA = "subtask-a"
				const p1 = "partial-1"
				const p2 = "partial-2"

				const messages: ApiMessage[] = [
					// Old stuff hidden by Q
					{ role: "user", content: "old msg", ts: 1, condenseParent: sA },
					{ role: "user", content: "Summary A", ts: 2, isSummary: true, condenseId: sA, condenseParent: qId },
					// Global Q
					{
						role: "user",
						content: "## Global Task Summary\nTask A done",
						ts: 3,
						isSummary: true,
						isGlobalSummary: true,
						condenseId: qId,
					},
					// Current task: auto-condense triggered twice (stacked partials)
					{ role: "user", content: "batch 1 msg", ts: 4, condenseParent: p1 },
					{ role: "assistant", content: "batch 1 resp", ts: 5, condenseParent: p1 },
					{ role: "user", content: "## Partial 1", ts: 6, isSummary: true, condenseId: p1 },
					{ role: "user", content: "batch 2 msg", ts: 7, condenseParent: p2 },
					{ role: "assistant", content: "batch 2 resp", ts: 8, condenseParent: p2 },
					{ role: "user", content: "## Partial 2", ts: 9, isSummary: true, condenseId: p2 },
					// Current raw messages
					{ role: "user", content: "latest msg", ts: 10 },
					{ role: "assistant", content: "latest resp", ts: 11 },
				]

				const effective = getEffectiveApiHistory(messages)

				// Model sees: [Q, Partial 1, Partial 2, latest msg, latest resp]
				expect(effective.length).toBe(5)
				expect(effective[0].isGlobalSummary).toBe(true)
				expect(effective[1].content).toBe("## Partial 1")
				expect(effective[1].isSummary).toBe(true)
				expect(effective[2].content).toBe("## Partial 2")
				expect(effective[2].isSummary).toBe(true)
				expect(effective[3].content).toBe("latest msg")
				expect(effective[4].content).toBe("latest resp")
			})

			it("should replace old Q with new Q after second task completes", () => {
				const q1Id = "global-q-1"
				const q2Id = "global-q-2"
				const sA = "subtask-a"
				const sB = "subtask-b"

				const messages: ApiMessage[] = [
					// Task A (hidden by sA, sA hidden by Q1, Q1 hidden by Q2)
					{ role: "user", content: "A msg", ts: 1, condenseParent: sA },
					{
						role: "user",
						content: "Summary A",
						ts: 2,
						isSummary: true,
						condenseId: sA,
						condenseParent: q1Id,
					},
					// Old Q1 (hidden by Q2)
					{
						role: "user",
						content: "Q v1",
						ts: 3,
						isSummary: true,
						isGlobalSummary: true,
						condenseId: q1Id,
						condenseParent: q2Id,
					},
					// Task B (hidden by sB, sB hidden by Q2)
					{ role: "user", content: "B msg", ts: 4, condenseParent: sB },
					{
						role: "user",
						content: "Summary B",
						ts: 5,
						isSummary: true,
						condenseId: sB,
						condenseParent: q2Id,
					},
					// New Q2
					{ role: "user", content: "Q v2", ts: 6, isSummary: true, isGlobalSummary: true, condenseId: q2Id },
					// Current
					{ role: "user", content: "Now what?", ts: 7 },
				]

				const effective = getEffectiveApiHistory(messages)

				// Only Q2 and current message visible
				expect(effective.length).toBe(2)
				expect(effective[0].content).toBe("Q v2")
				expect(effective[0].isGlobalSummary).toBe(true)
				expect(effective[1].content).toBe("Now what?")
			})
		})

		describe("generateGlobalSummaryText", () => {
			const mockApiHandler = {
				createMessage: vi.fn(),
			} as any

			beforeEach(() => {
				vi.clearAllMocks()
				mockApiHandler.createMessage.mockImplementation(async function* () {
					yield { type: "text", text: "Merged global summary of all tasks" }
					yield { type: "usage", totalCost: 0.02, outputTokens: 80 }
				})
			})

			it("should return null for empty summaries", async () => {
				const result = await generateGlobalSummaryText([], mockApiHandler)
				expect(result).toBeNull()
			})

			it("should return single summary directly without LLM call", async () => {
				const result = await generateGlobalSummaryText(
					[{ title: "Auth", summary: "Built auth module" }],
					mockApiHandler,
				)

				expect(result).not.toBeNull()
				expect(result!.text).toBe("Built auth module")
				expect(result!.cost).toBe(0)
				// No LLM call needed for single summary
				expect(mockApiHandler.createMessage).not.toHaveBeenCalled()
			})

			it("should merge multiple summaries via LLM", async () => {
				const result = await generateGlobalSummaryText(
					[
						{ title: "Auth", summary: "Built auth with OAuth" },
						{ title: "Database", summary: "Set up PostgreSQL with migrations" },
						{ title: "API", summary: "Created REST endpoints" },
					],
					mockApiHandler,
				)

				expect(result).not.toBeNull()
				expect(result!.text).toBe("Merged global summary of all tasks")
				expect(mockApiHandler.createMessage).toHaveBeenCalledTimes(1)

				// Verify the prompt includes all summaries
				const callArgs = mockApiHandler.createMessage.mock.calls[0]
				const systemPrompt = callArgs[0]
				const reqMessages = callArgs[1]
				expect(systemPrompt).toContain("summarizer")
				expect(reqMessages[0].content).toContain("Auth")
				expect(reqMessages[0].content).toContain("Database")
				expect(reqMessages[0].content).toContain("API")
			})

			it("should return null on LLM error", async () => {
				mockApiHandler.createMessage.mockImplementation(async function* () {
					throw new Error("API error")
				})

				const result = await generateGlobalSummaryText(
					[
						{ title: "A", summary: "summary A" },
						{ title: "B", summary: "summary B" },
					],
					mockApiHandler,
				)

				expect(result).toBeNull()
			})
		})

		describe("End-to-end Q flow with getEffectiveApiHistory", () => {
			it("should show only Q after first task, then updated Q after second task", () => {
				// After first task completes: Q1 = summary A
				const sA = "subtask-a"
				const q1 = "q-v1"

				let messages: ApiMessage[] = [
					{ role: "user", content: "A work", ts: 1, condenseParent: sA },
					{ role: "assistant", content: "A done", ts: 2, condenseParent: sA },
					{ role: "user", content: "Summary A", ts: 3, isSummary: true, condenseId: sA, condenseParent: q1 },
					{
						role: "user",
						content: "## Global Task Summary\nAuth built",
						ts: 4,
						isSummary: true,
						isGlobalSummary: true,
						condenseId: q1,
					},
				]

				let effective = getEffectiveApiHistory(messages)
				expect(effective.length).toBe(1)
				expect(effective[0].isGlobalSummary).toBe(true)
				expect(effective[0].content).toContain("Auth built")

				// User chats, then task B happens
				const sB = "subtask-b"
				const q2 = "q-v2"

				messages = [
					...messages,
					// Between-task chat (tagged by Q2 when task B ends)
					{ role: "user", content: "chat", ts: 5, condenseParent: sB },
					// Task B
					{ role: "user", content: "B work", ts: 6, condenseParent: sB },
					{ role: "assistant", content: "B done", ts: 7, condenseParent: sB },
					{ role: "user", content: "Summary B", ts: 8, isSummary: true, condenseId: sB, condenseParent: q2 },
				]

				// Q1 gets tagged, Q2 appended
				messages[3] = { ...messages[3], condenseParent: q2 } // tag old Q1
				messages.push({
					role: "user",
					content: "## Global Task Summary\nAuth + DB built",
					ts: 9,
					isSummary: true,
					isGlobalSummary: true,
					condenseId: q2,
				})

				effective = getEffectiveApiHistory(messages)
				expect(effective.length).toBe(1)
				expect(effective[0].content).toContain("Auth + DB built")
				expect(effective[0].condenseId).toBe(q2)
			})
		})
	})

	describe("autoUpdateGlobalSummary", () => {
		const mockApiHandler = {
			createMessage: vi.fn(),
			countTokens: vi.fn().mockResolvedValue(100),
			getModel: vi.fn().mockReturnValue({ id: "test", info: { contextWindow: 128000 } }),
		} as any

		it("should return unchanged messages when no summaries exist", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "hello", ts: 1 },
				{ role: "assistant", content: "hi", ts: 2 },
			]
			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			expect(result.messages).toBe(messages) // same reference
			expect(result.cost).toBe(0)
		})

		it("should promote single visible summary to Global Q (no LLM call)", async () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "hello", ts: 1, condenseParent: "s1" },
				{ role: "assistant", content: "hi", ts: 2, condenseParent: "s1" },
				{
					role: "user",
					content: [{ type: "text", text: "## Conversation Summary\nSummary of work done" }],
					ts: 3,
					isSummary: true,
					condenseId: "s1",
				},
			]
			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			expect(result.cost).toBe(0)

			// The summary should now be marked as Global Q
			const summary = result.messages[2]
			expect(summary.isGlobalSummary).toBe(true)
			expect((summary.content as any)[0].text).toContain("## Global Task Summary")
			expect((summary.content as any)[0].text).toContain("Summary of work done")

			// createMessage should NOT be called (no LLM call)
			expect(mockApiHandler.createMessage).not.toHaveBeenCalled()
		})

		it("should not modify if single summary is already a Global Q", async () => {
			const messages: ApiMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "## Global Task Summary\nExisting Q" }],
					ts: 3,
					isSummary: true,
					isGlobalSummary: true,
					condenseId: "q1",
				},
			]
			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			expect(result.messages).toBe(messages) // same reference
			expect(result.cost).toBe(0)
		})

		it("should merge 2 visible summaries into a new Global Q via LLM", async () => {
			const mergedText = "Comprehensive merged summary of both tasks"
			mockApiHandler.createMessage.mockReturnValue(
				(async function* () {
					yield { type: "text", text: mergedText }
					yield { type: "usage", totalCost: 0.01 }
				})(),
			)

			const messages: ApiMessage[] = [
				{ role: "user", content: "msg1", ts: 1, condenseParent: "s1" },
				{
					role: "user",
					content: [{ type: "text", text: "## Conversation Summary\nFirst summary" }],
					ts: 2,
					isSummary: true,
					condenseId: "s1",
				},
				{ role: "user", content: "msg2", ts: 3, condenseParent: "s2" },
				{
					role: "user",
					content: [{ type: "text", text: "## Conversation Summary\nSecond summary" }],
					ts: 4,
					isSummary: true,
					condenseId: "s2",
				},
			]

			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			expect(result.cost).toBe(0.01)

			// Old summaries should be tagged with new Q's condenseId
			const newQ = result.messages[result.messages.length - 1]
			expect(newQ.isGlobalSummary).toBe(true)
			expect(newQ.isSummary).toBe(true)
			expect((newQ.content as any)[0].text).toContain("## Global Task Summary")
			expect((newQ.content as any)[0].text).toContain(mergedText)

			// Old summaries should have condenseParent = newQ.condenseId
			expect(result.messages[1].condenseParent).toBe(newQ.condenseId)
			expect(result.messages[3].condenseParent).toBe(newQ.condenseId)

			// Verify effective history only shows the new Q
			const effective = getEffectiveApiHistory(result.messages)
			const summaries = effective.filter((m) => m.isSummary)
			expect(summaries.length).toBe(1)
			expect(summaries[0].isGlobalSummary).toBe(true)
		})

		it("should preserve auxiliary content blocks from the latest summary", async () => {
			mockApiHandler.createMessage.mockReturnValue(
				(async function* () {
					yield { type: "text", text: "Merged summary" }
					yield { type: "usage", totalCost: 0 }
				})(),
			)

			const messages: ApiMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "## Global Task Summary\nOld Q" }],
					ts: 1,
					isSummary: true,
					isGlobalSummary: true,
					condenseId: "q1",
				},
				{ role: "user", content: "new work", ts: 2, condenseParent: "s2" },
				{
					role: "user",
					content: [
						{ type: "text", text: "## Conversation Summary\nNew partial" },
						{
							type: "text",
							text: "<system-reminder>\n## Active Workflows\n<command>do stuff</command>\n</system-reminder>",
						},
					],
					ts: 3,
					isSummary: true,
					condenseId: "s2",
				},
			]

			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			const newQ = result.messages[result.messages.length - 1]

			// Should have 2 content blocks: merged text + auxiliary command block
			const content = newQ.content as Anthropic.Messages.ContentBlockParam[]
			expect(content.length).toBe(2)
			expect((content[0] as any).text).toContain("## Global Task Summary")
			expect((content[1] as any).text).toContain("Active Workflows")
		})

		it("should skip hidden summaries (with condenseParent pointing to existing summary)", async () => {
			const messages: ApiMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: "## Conversation Summary\nOld hidden" }],
					ts: 1,
					isSummary: true,
					condenseId: "s1",
					condenseParent: "q1",
				},
				{
					role: "user",
					content: [{ type: "text", text: "## Global Task Summary\nVisible Q" }],
					ts: 2,
					isSummary: true,
					isGlobalSummary: true,
					condenseId: "q1",
				},
			]

			const result = await autoUpdateGlobalSummary(messages, mockApiHandler)
			// Only 1 visible summary (the Q), and it's already a Global Q
			expect(result.messages).toBe(messages)
			expect(result.cost).toBe(0)
		})
	})
})
