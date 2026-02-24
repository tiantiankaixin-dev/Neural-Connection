import fs from "fs/promises"
import path from "path"
import { v4 as uuidv4 } from "uuid"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CreateMemoryParams {
	Action: "create" | "update" | "delete"
	Id?: string | null
	Title?: string | null
	Content?: string | null
	CorpusNames?: string[] | null
	Tags?: string[] | null
	UserTriggered: boolean
}

interface MemoryEntry {
	id: string
	title: string
	content: string
	corpusNames: string[]
	tags: string[]
	userTriggered: boolean
	createdAt: string
	updatedAt: string
}

interface MemoryStore {
	version: number
	memories: MemoryEntry[]
}

const MEMORY_FILE_NAME = ".roo-memories.json"
const MEMORY_STORE_VERSION = 1

export class CreateMemoryTool extends BaseTool<"create_memory"> {
	readonly name = "create_memory" as const

	async execute(params: CreateMemoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const { Action, Id, Title, Content, CorpusNames, Tags, UserTriggered } = params

		try {
			// Validate required parameters
			if (!Action) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("create_memory", "Action"))
				return
			}

			if (UserTriggered === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("create_memory", "UserTriggered"))
				return
			}

			// Validate action-specific requirements
			if (Action === "create" || Action === "update") {
				if (!Title) {
					task.consecutiveMistakeCount++
					task.recordToolError("create_memory")
					pushToolResult(formatResponse.toolError(`Title is required for ${Action} action.`))
					return
				}
				if (Content === null || Content === undefined) {
					task.consecutiveMistakeCount++
					task.recordToolError("create_memory")
					pushToolResult(formatResponse.toolError(`Content is required for ${Action} action.`))
					return
				}
			}

			if ((Action === "update" || Action === "delete") && !Id) {
				task.consecutiveMistakeCount++
				task.recordToolError("create_memory")
				pushToolResult(formatResponse.toolError(`Id is required for ${Action} action.`))
				return
			}

			task.consecutiveMistakeCount = 0

			// Get the memory file path
			const memoryFilePath = this.getMemoryFilePath(task.cwd)

			// Load existing memories
			let store = await this.loadMemoryStore(memoryFilePath)

			let result: string

			switch (Action) {
				case "create": {
					const newMemory: MemoryEntry = {
						id: uuidv4(),
						title: Title!,
						content: Content!,
						corpusNames: CorpusNames || [],
						tags: Tags || [],
						userTriggered: UserTriggered,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					}
					store.memories.push(newMemory)
					result = `Created memory: "${Title}" (id: ${newMemory.id})`
					break
				}

				case "update": {
					const index = store.memories.findIndex((m) => m.id === Id)
					if (index === -1) {
						pushToolResult(formatResponse.toolError(`Memory with id '${Id}' not found.`))
						return
					}
					store.memories[index] = {
						...store.memories[index],
						title: Title!,
						content: Content!,
						updatedAt: new Date().toISOString(),
					}
					result = `Updated memory: "${Title}" (id: ${Id})`
					break
				}

				case "delete": {
					const deleteIndex = store.memories.findIndex((m) => m.id === Id)
					if (deleteIndex === -1) {
						pushToolResult(formatResponse.toolError(`Memory with id '${Id}' not found.`))
						return
					}
					const deletedTitle = store.memories[deleteIndex].title
					store.memories.splice(deleteIndex, 1)
					result = `Deleted memory: "${deletedTitle}" (id: ${Id})`
					break
				}
			}

			// Ask for approval before saving
			const didApprove = await askApproval(
				"tool",
				JSON.stringify({ tool: "createMemory", action: Action, title: Title || Id }),
			)

			if (!didApprove) {
				pushToolResult("Memory operation was cancelled.")
				return
			}

			// Save the updated store
			await this.saveMemoryStore(memoryFilePath, store)

			pushToolResult(result)
			task.recordToolUsage("create_memory")
		} catch (error) {
			await handleError("managing memory", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** @internal Exposed for testing */
	public getMemoryFilePath(cwd: string): string {
		return path.join(cwd, MEMORY_FILE_NAME)
	}

	/** @internal Exposed for testing */
	public async loadMemoryStore(filePath: string): Promise<MemoryStore> {
		try {
			const content = await fs.readFile(filePath, "utf8")
			const store = JSON.parse(content) as MemoryStore

			// Validate version
			if (store.version !== MEMORY_STORE_VERSION) {
				// Handle version migration if needed in the future
				return { version: MEMORY_STORE_VERSION, memories: store.memories || [] }
			}

			return store
		} catch (error) {
			// File doesn't exist or is invalid, return empty store
			return { version: MEMORY_STORE_VERSION, memories: [] }
		}
	}

	/** @internal Exposed for testing */
	public async saveMemoryStore(filePath: string, store: MemoryStore): Promise<void> {
		await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf8")
	}

	/** @internal Exposed for testing - validate memory entry */
	public validateMemoryEntry(entry: Partial<MemoryEntry>): string[] {
		const errors: string[] = []

		if (!entry.title || entry.title.trim().length === 0) {
			errors.push("Title cannot be empty")
		}

		if (entry.content === undefined || entry.content === null) {
			errors.push("Content is required")
		}

		if (entry.tags) {
			const invalidTags = entry.tags.filter((tag) => !/^[a-z][a-z0-9_]*$/.test(tag))
			if (invalidTags.length > 0) {
				errors.push(`Tags must be snake_case: ${invalidTags.join(", ")}`)
			}
		}

		return errors
	}

	override async handlePartial(task: Task, block: ToolUse<"create_memory">): Promise<void> {
		// No partial handling needed for this tool
	}
}

export const createMemoryTool = new CreateMemoryTool()
