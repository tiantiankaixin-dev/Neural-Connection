import { CodeBlock } from "../interfaces"

/**
 * Builds an enriched text string for embedding by prepending contextual metadata
 * (file path, class name, identifier) to the raw code content.
 *
 * This gives the embedding model semantic signals about WHERE the code lives
 * and WHAT it represents, dramatically improving search relevance for queries
 * that mention file paths, class names, or architectural concepts.
 *
 * Example output:
 *   [Scripts/Player/PlayerController.cs] [Class: PlayerController extends MonoBehaviour] [HandleMovement]
 *   void HandleMovement() { ... }
 */
export function buildEmbeddingText(block: CodeBlock): string {
	const parts: string[] = []

	// File path context (use forward slashes for consistency)
	const filePath = block.file_path.replace(/\\/g, "/")
	parts.push(`[${filePath}]`)

	// Class context
	if (block.relations?.classContext?.className) {
		let classInfo = `[Class: ${block.relations.classContext.className}`
		if (block.relations.classContext.extends) {
			classInfo += ` extends ${block.relations.classContext.extends}`
		}
		classInfo += "]"
		parts.push(classInfo)
	}

	// Identifier (method/function name)
	if (block.identifier) {
		parts.push(`[${block.identifier}]`)
	}

	const prefix = parts.join(" ")
	return `${prefix}\n${block.content}`
}

/**
 * Builds a text string from a block's relationship metadata for embedding.
 *
 * This captures WHAT the block connects to (defines, refs, class context)
 * so the embedding model can semantically match queries about related concepts.
 * At query time, searching the relation vectors finds blocks whose CONNECTIONS
 * are most relevant to the query topic.
 *
 * Example output:
 *   Scripts/Player/PlayerMovement.cs | class: PlayerMovement extends MonoBehaviour
 *   | defines: HandleMovement, Awake | refs: CheckGrounded, Rigidbody, Vector3, MoveDirection
 */
export function buildRelationText(block: CodeBlock): string {
	const parts: string[] = []

	// File path context
	const filePath = block.file_path.replace(/\\/g, "/")
	parts.push(filePath)

	// Class context
	if (block.relations?.classContext?.className) {
		let classInfo = `class: ${block.relations.classContext.className}`
		if (block.relations.classContext.extends) {
			classInfo += ` extends ${block.relations.classContext.extends}`
		}
		parts.push(classInfo)
	}

	// Identifier
	if (block.identifier) {
		parts.push(`identifier: ${block.identifier}`)
	}

	// Defines
	const defines = block.relations?.defines || []
	if (defines.length > 0) {
		parts.push(`defines: ${defines.join(", ")}`)
	}

	// Refs
	const refs = block.relations?.refs || []
	if (refs.length > 0) {
		parts.push(`refs: ${refs.join(", ")}`)
	}

	return parts.join(" | ")
}
