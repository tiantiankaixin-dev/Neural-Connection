import { z } from "zod"

/**
 * TodoStatus
 */
export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"] as const)

export type TodoStatus = z.infer<typeof todoStatusSchema>

/**
 * TodoItem
 */
export const todoItemSchema = z.object({
	id: z.string(),
	content: z.string(),
	status: todoStatusSchema,
	/** Interface contracts / shared types for this layer (refine); shown to build subagent and UI. */
	context: z.string().optional(),
})

export type TodoItem = z.infer<typeof todoItemSchema>
