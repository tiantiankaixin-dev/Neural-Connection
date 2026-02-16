import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { ApiStream } from "../transform/stream"
import { countTokens } from "../../utils/countTokens"
import { isMcpTool } from "../../utils/mcp-name"

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	abstract createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	abstract getModel(): { id: string; info: ModelInfo }

	/**
	 * Converts an array of tools to be compatible with OpenAI's strict mode.
	 * Filters for function tools, applies schema conversion to their parameters,
	 * and ensures all tools have consistent strict: true values.
	 */
	protected convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			// MCP tools use the 'mcp--' prefix - disable strict mode for them
			// to preserve optional parameters from the MCP server schema
			const isMcp = isMcpTool(tool.function.name)

			return {
				...tool,
				function: {
					...tool.function,
					strict: !isMcp,
					parameters: isMcp
						? tool.function.parameters
						: this.convertToolSchemaForOpenAI(tool.function.parameters),
				},
			}
		})
	}

	/**
	 * Converts tool schemas to be compatible with OpenAI's strict mode by:
	 * - Ensuring all properties are in the required array (strict mode requirement)
	 * - Preserving nullable types (["type", "null"]) so the model can pass null
	 * - Adding additionalProperties: false to all object schemas (required by OpenAI Responses API)
	 * - Recursively processing nested objects and arrays (including nullable objects)
	 */
	protected convertToolSchemaForOpenAI(schema: any): any {
		if (!schema || typeof schema !== "object") {
			return schema
		}

		// Accept both "object" and ["object", "null"] as object schemas
		const schemaType = schema.type
		const isObjectType = schemaType === "object" || (Array.isArray(schemaType) && schemaType.includes("object"))

		if (!isObjectType) {
			return schema
		}

		const result = { ...schema }

		// OpenAI Responses API requires additionalProperties: false on all object schemas
		// Only add if not already set to false (to avoid unnecessary mutations)
		if (result.additionalProperties !== false) {
			result.additionalProperties = false
		}

		if (result.properties) {
			const allKeys = Object.keys(result.properties)
			// OpenAI strict mode requires ALL properties to be in required array
			result.required = allKeys

			// Recursively process nested objects (preserve nullable types as-is)
			const newProps = { ...result.properties }
			for (const key of allKeys) {
				const prop = newProps[key]
				if (!prop) continue

				const propType = prop.type
				const isNestedObject = propType === "object" || (Array.isArray(propType) && propType.includes("object"))
				const isArray = propType === "array" || (Array.isArray(propType) && propType.includes("array"))

				if (isNestedObject) {
					newProps[key] = this.convertToolSchemaForOpenAI(prop)
				} else if (isArray && prop.items) {
					const itemsType = prop.items.type
					const isItemsObject =
						itemsType === "object" || (Array.isArray(itemsType) && itemsType.includes("object"))
					if (isItemsObject) {
						newProps[key] = {
							...prop,
							items: this.convertToolSchemaForOpenAI(prop.items),
						}
					}
				}
			}
			result.properties = newProps
		}

		return result
	}

	/**
	 * Default token counting implementation using tiktoken.
	 * Providers can override this to use their native token counting endpoints.
	 *
	 * @param content The content to count tokens for
	 * @returns A promise resolving to the token count
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		if (content.length === 0) {
			return 0
		}

		return countTokens(content, { useWorker: true })
	}

	/**
	 * Default implementation returns false.
	 * AI SDK providers should override this to return true.
	 */
	isAiSdkProvider(): boolean {
		return false
	}
}
