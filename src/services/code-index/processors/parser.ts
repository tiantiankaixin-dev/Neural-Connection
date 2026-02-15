import { readFile } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import { Node } from "web-tree-sitter"
import { LanguageParser, loadRequiredLanguageParsers } from "../../tree-sitter/languageParser"
import { parseMarkdown } from "../../tree-sitter/markdownParser"
import { ICodeParser, CodeBlock } from "../interfaces"
import { scannerExtensions, shouldUseFallbackChunking } from "../shared/supported-extensions"
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS, MIN_CHUNK_REMAINDER_CHARS, MAX_CHARS_TOLERANCE_FACTOR } from "../constants"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"
import { TagExtractor, FileTagResult } from "../analyzers/tag-extractor"

/**
 * Implementation of the code parser interface
 */
export class CodeParser implements ICodeParser {
	private loadedParsers: LanguageParser = {}
	private pendingLoads: Map<string, Promise<LanguageParser>> = new Map()
	private tagExtractor: TagExtractor = new TagExtractor()
	// Markdown files are now supported using the custom markdown parser
	// which extracts headers and sections for semantic indexing

	/**
	 * Parses a code file into code blocks
	 * @param filePath Path to the file to parse
	 * @param options Optional parsing options
	 * @returns Promise resolving to array of code blocks
	 */
	async parseFile(
		filePath: string,
		options?: {
			content?: string
			fileHash?: string
		},
	): Promise<CodeBlock[]> {
		// Get file extension
		const ext = path.extname(filePath).toLowerCase()

		// Skip if not a supported language
		if (!this.isSupportedLanguage(ext)) {
			return []
		}

		// Get file content
		let content: string
		let fileHash: string

		if (options?.content) {
			content = options.content
			fileHash = options.fileHash || this.createFileHash(content)
		} else {
			try {
				content = await readFile(filePath, "utf8")
				fileHash = this.createFileHash(content)
			} catch (error) {
				console.error(`Error reading file ${filePath}:`, error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
					stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
					location: "parseFile",
				})
				return []
			}
		}

		// Parse the file
		return this.parseContent(filePath, content, fileHash)
	}

	/**
	 * Checks if a language is supported
	 * @param extension File extension
	 * @returns Boolean indicating if the language is supported
	 */
	private isSupportedLanguage(extension: string): boolean {
		return scannerExtensions.includes(extension)
	}

	/**
	 * Creates a hash for a file
	 * @param content File content
	 * @returns Hash string
	 */
	private createFileHash(content: string): string {
		return createHash("sha256").update(content).digest("hex")
	}

	/**
	 * Parses file content into code blocks
	 * @param filePath Path to the file
	 * @param content File content
	 * @param fileHash File hash
	 * @returns Array of code blocks
	 */
	private async parseContent(filePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
		const ext = path.extname(filePath).slice(1).toLowerCase()
		const seenSegmentHashes = new Set<string>()

		// Handle markdown files specially
		if (ext === "md" || ext === "markdown") {
			return this.parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if this extension should use fallback chunking
		if (shouldUseFallbackChunking(`.${ext}`)) {
			return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if we already have the parser loaded
		if (!this.loadedParsers[ext]) {
			const pendingLoad = this.pendingLoads.get(ext)
			if (pendingLoad) {
				try {
					await pendingLoad
				} catch (error) {
					console.error(`Error in pending parser load for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				}
			} else {
				const loadPromise = loadRequiredLanguageParsers([filePath])
				this.pendingLoads.set(ext, loadPromise)
				try {
					const newParsers = await loadPromise
					if (newParsers) {
						this.loadedParsers = { ...this.loadedParsers, ...newParsers }
					}
				} catch (error) {
					console.error(`Error loading language parser for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				} finally {
					this.pendingLoads.delete(ext)
				}
			}
		}

		const language = this.loadedParsers[ext]
		if (!language) {
			console.warn(`No parser available for file extension: ${ext}`)
			return []
		}

		const tree = language.parser.parse(content)

		// We don't need to get the query string from languageQueries since it's already loaded
		// in the language object
		const captures = tree ? language.query.captures(tree.rootNode) : []

		// Check if captures are empty
		if (captures.length === 0) {
			if (content.length >= MIN_BLOCK_CHARS) {
				// Perform fallback chunking if content is large enough
				const blocks = this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
				return blocks
			} else {
				// Return empty if content is too small for fallback
				return []
			}
		}

		const results: CodeBlock[] = []

		// Process captures if not empty
		const queue: Node[] = Array.from(captures).map((capture) => capture.node)

		while (queue.length > 0) {
			const currentNode = queue.shift()!

			// Check if the node meets the minimum character requirement
			if (currentNode.text.length >= MIN_BLOCK_CHARS) {
				// If it also exceeds the maximum character limit, try to break it down
				if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
					const nonCommentChildren = currentNode.children.filter(
						(child): child is Node => child !== null && !child.type.includes("comment"),
					)
					if (nonCommentChildren.length > 0) {
						const merged = this._decomposeWithMerge(
							nonCommentChildren,
							filePath,
							content,
							fileHash,
							seenSegmentHashes,
						)
						if (merged.blocks.length > 0) {
							results.push(...merged.blocks)
						}
						if (merged.requeue.length > 0) {
							queue.push(...merged.requeue)
						}
					} else {
						const chunkedBlocks = this._chunkLeafNodeByLines(
							currentNode,
							filePath,
							fileHash,
							seenSegmentHashes,
						)
						results.push(...chunkedBlocks)
					}
				} else {
					// Node meets min chars and is within max chars, create a block
					const identifier =
						currentNode.childForFieldName("name")?.text ||
						currentNode.children.find((c) => c?.type === "identifier")?.text ||
						null
					const type = currentNode.type
					const start_line = currentNode.startPosition.row + 1
					const end_line = currentNode.endPosition.row + 1
					const content = currentNode.text
					const contentPreview = content.slice(0, 100)
					const segmentHash = createHash("sha256")
						.update(`${filePath}-${start_line}-${end_line}-${content.length}-${contentPreview}`)
						.digest("hex")

					if (!seenSegmentHashes.has(segmentHash)) {
						seenSegmentHashes.add(segmentHash)
						results.push({
							file_path: filePath,
							identifier,
							type,
							start_line,
							end_line,
							content,
							segmentHash,
							fileHash,
						})
					}
				}
			}
			// Nodes smaller than minBlockChars are ignored
		}

		// [Code Graph] Extract tags and map to blocks
		this.mapTagsToBlocks(results, filePath, content, language.parser, language.language)

		return results
	}

	// Node type suffixes that indicate structural/anchor nodes (cross-language)
	private static readonly STRUCTURAL_NODE_SUFFIXES = [
		"_declaration",
		"_definition",
		"_item", // Rust: function_item, struct_item, impl_item
	]

	/**
	 * Checks if a node is a structural anchor (method, class, etc.) vs a satellite (field, statement).
	 * An anchor must match a structural type pattern AND span multiple lines.
	 */
	private _isAnchorNode(node: Node): boolean {
		const isStructuralType = CodeParser.STRUCTURAL_NODE_SUFFIXES.some((suffix) => node.type.endsWith(suffix))
		const isMultiLine = node.endPosition.row - node.startPosition.row >= 1
		return isStructuralType && isMultiLine
	}

	/**
	 * Decompose a large node's children using Node Type classification + merge.
	 *
	 * 1. Classify children as anchors (structural, multi-line) or satellites (single-line)
	 * 2. Assign each satellite to its nearest anchor by line distance
	 * 3. Expand each anchor's line range to include assigned satellites
	 * 4. Extract text from file content for the expanded range
	 * 5. If merged block fits MAX_BLOCK_CHARS → create block; else → requeue anchor for further decomposition
	 * 6. If no anchors → fallback to line-based chunking
	 */
	private _decomposeWithMerge(
		children: Node[],
		filePath: string,
		fileContent: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): { blocks: CodeBlock[]; requeue: Node[] } {
		const blocks: CodeBlock[] = []
		const requeue: Node[] = []

		// Sort children by start position
		const sorted = [...children].sort((a, b) => a.startPosition.row - b.startPosition.row)

		// Classify
		const anchors: Array<{ node: Node; startRow: number; endRow: number; satellites: Node[] }> = []
		const satellites: Node[] = []

		for (const child of sorted) {
			if (this._isAnchorNode(child)) {
				anchors.push({
					node: child,
					startRow: child.startPosition.row,
					endRow: child.endPosition.row,
					satellites: [],
				})
			} else {
				satellites.push(child)
			}
		}

		// Edge case: no anchors → fallback to line-based chunking
		if (anchors.length === 0) {
			// Merge all satellites' text; if big enough, chunk by lines
			if (sorted.length > 0) {
				const firstRow = sorted[0].startPosition.row
				const lastRow = sorted[sorted.length - 1].endPosition.row
				const lines = fileContent.split("\n").slice(firstRow, lastRow + 1)
				const chunked = this._chunkTextByLines(
					lines,
					filePath,
					fileHash,
					sorted[0].type,
					seenSegmentHashes,
					firstRow + 1, // 1-based
				)
				blocks.push(...chunked)
			}
			return { blocks, requeue }
		}

		// Assign each satellite to the nearest anchor
		for (const sat of satellites) {
			const satRow = sat.startPosition.row
			let bestAnchor = anchors[0]
			let bestDist = Math.abs(satRow - anchors[0].startRow)

			for (const anchor of anchors) {
				const distToStart = Math.abs(satRow - anchor.startRow)
				const distToEnd = Math.abs(satRow - anchor.endRow)
				const dist = Math.min(distToStart, distToEnd)
				if (dist < bestDist) {
					bestDist = dist
					bestAnchor = anchor
				}
			}
			bestAnchor.satellites.push(sat)
		}

		// For each anchor, expand range and create block
		const fileLines = fileContent.split("\n")

		for (const anchor of anchors) {
			// Compute expanded range
			let minRow = anchor.startRow
			let maxRow = anchor.endRow
			for (const sat of anchor.satellites) {
				minRow = Math.min(minRow, sat.startPosition.row)
				maxRow = Math.max(maxRow, sat.endPosition.row)
			}

			const mergedText = fileLines.slice(minRow, maxRow + 1).join("\n")

			if (mergedText.length < MIN_BLOCK_CHARS) {
				continue // Too small even after merge
			}

			if (mergedText.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
				// Still too big after merge → requeue the anchor node for further decomposition
				// and create blocks from satellites that don't overlap with the anchor
				requeue.push(anchor.node)

				// Satellites that are outside the anchor's original range get their own merge attempt
				for (const sat of anchor.satellites) {
					if (sat.text.length >= MIN_BLOCK_CHARS) {
						const startLine = sat.startPosition.row + 1
						const endLine = sat.endPosition.row + 1
						const contentPreview = sat.text.slice(0, 100)
						const segmentHash = createHash("sha256")
							.update(`${filePath}-${startLine}-${endLine}-${sat.text.length}-${contentPreview}`)
							.digest("hex")
						if (!seenSegmentHashes.has(segmentHash)) {
							seenSegmentHashes.add(segmentHash)
							blocks.push({
								file_path: filePath,
								identifier: null,
								type: sat.type,
								start_line: startLine,
								end_line: endLine,
								content: sat.text,
								segmentHash,
								fileHash,
							})
						}
					}
				}
			} else {
				// Fits within limit → create merged block
				const startLine = minRow + 1
				const endLine = maxRow + 1
				const identifier =
					anchor.node.childForFieldName("name")?.text ||
					anchor.node.children.find((c) => c?.type === "identifier")?.text ||
					null
				const contentPreview = mergedText.slice(0, 100)
				const segmentHash = createHash("sha256")
					.update(`${filePath}-${startLine}-${endLine}-${mergedText.length}-${contentPreview}`)
					.digest("hex")

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash)
					blocks.push({
						file_path: filePath,
						identifier,
						type: anchor.node.type,
						start_line: startLine,
						end_line: endLine,
						content: mergedText,
						segmentHash,
						fileHash,
					})
				}
			}
		}

		return { blocks, requeue }
	}

	/**
	 * Maps file-level tags (definitions + references) to individual CodeBlocks by line range.
	 * This enriches each block with relation data for the code graph.
	 */
	private mapTagsToBlocks(blocks: CodeBlock[], filePath: string, content: string, parser: any, language: any): void {
		if (blocks.length === 0) {
			return
		}

		try {
			const tagResult: FileTagResult = this.tagExtractor.extract(filePath, content, parser, language)

			const fileImports = tagResult.imports.map((imp) => ({ symbol: imp.symbol, path: imp.path }))

			for (const block of blocks) {
				const blockDefines = [
					...new Set(
						tagResult.tags
							.filter((t) => t.kind === "def" && t.line >= block.start_line && t.line <= block.end_line)
							.map((t) => t.name),
					),
				]

				const refSet = new Set(
					tagResult.tags
						.filter((t) => t.kind === "ref" && t.line >= block.start_line && t.line <= block.end_line)
						.map((t) => t.name),
				)

				// Add import symbols as refs to the block that covers the import
				// line, or to the first block as fallback. This creates PageRank
				// edges for import/using dependencies (especially valuable for
				// TS/JS where imports name specific symbols like class names).
				for (const imp of tagResult.imports) {
					if (imp.line >= block.start_line && imp.line <= block.end_line) {
						refSet.add(imp.symbol)
					} else if (block === blocks[0] && imp.line < block.start_line) {
						// Import is above the first block (common: imports at top of file)
						refSet.add(imp.symbol)
					}
				}

				const blockRefs = [...refSet]

				const lineCount = block.end_line - block.start_line + 1
				const refDensity = lineCount > 0 ? blockRefs.length / lineCount : 0

				const enclosingClass = tagResult.classDeclarations.find(
					(c) => c.startLine <= block.start_line && c.endLine >= block.end_line,
				)

				const classContext = enclosingClass
					? {
							className: enclosingClass.name,
							extends: enclosingClass.extends,
							implements: enclosingClass.implements,
						}
					: undefined

				block.relations = {
					defines: blockDefines,
					refs: blockRefs,
					refDensity,
					fileImports,
					classContext,
				}
			}
		} catch (error) {
			console.warn(`Tag extraction failed for ${filePath}: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Common helper function to chunk text by lines, avoiding tiny remainders.
	 */
	private _chunkTextByLines(
		lines: string[],
		filePath: string,
		fileHash: string,
		chunkType: string,
		seenSegmentHashes: Set<string>,
		baseStartLine: number = 1, // 1-based start line of the *first* line in the `lines` array
	): CodeBlock[] {
		const chunks: CodeBlock[] = []
		let currentChunkLines: string[] = []
		let currentChunkLength = 0
		let chunkStartLineIndex = 0 // 0-based index within the `lines` array
		const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR

		const finalizeChunk = (endLineIndex: number) => {
			if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
				const chunkContent = currentChunkLines.join("\n")
				const startLine = baseStartLine + chunkStartLineIndex
				const endLine = baseStartLine + endLineIndex
				const contentPreview = chunkContent.slice(0, 100)
				const segmentHash = createHash("sha256")
					.update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
					.digest("hex")

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash)
					chunks.push({
						file_path: filePath,
						identifier: null,
						type: chunkType,
						start_line: startLine,
						end_line: endLine,
						content: chunkContent,
						segmentHash,
						fileHash,
					})
				}
			}
			currentChunkLines = []
			currentChunkLength = 0
			chunkStartLineIndex = endLineIndex + 1
		}

		const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
			const segmentPreview = segment.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(
					`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
				)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				chunks.push({
					file_path: filePath,
					identifier: null,
					type: `${chunkType}_segment`,
					start_line: originalLineNumber,
					end_line: originalLineNumber,
					content: segment,
					segmentHash,
					fileHash,
				})
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineLength = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for newline, except last line
			const originalLineNumber = baseStartLine + i

			// Handle oversized lines (longer than effectiveMaxChars)
			if (lineLength > effectiveMaxChars) {
				// Finalize any existing normal chunk before processing the oversized line
				if (currentChunkLines.length > 0) {
					finalizeChunk(i - 1)
				}

				// Split the oversized line into segments
				let remainingLineContent = line
				let currentSegmentStartChar = 0
				while (remainingLineContent.length > 0) {
					const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
					remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
					createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
					currentSegmentStartChar += MAX_BLOCK_CHARS
				}
				// Update chunkStartLineIndex to continue processing from the next line
				chunkStartLineIndex = i + 1
				continue
			}

			// Handle normally sized lines
			if (currentChunkLength > 0 && currentChunkLength + lineLength > effectiveMaxChars) {
				// Re-balancing Logic
				let splitIndex = i - 1
				let remainderLength = 0
				for (let j = i; j < lines.length; j++) {
					remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
				}

				if (
					currentChunkLength >= MIN_BLOCK_CHARS &&
					remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
					currentChunkLines.length > 1
				) {
					for (let k = i - 2; k >= chunkStartLineIndex; k--) {
						const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
						const potentialChunkLength = potentialChunkLines.join("\n").length + 1
						const potentialNextChunkLines = lines.slice(k + 1)
						const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

						if (
							potentialChunkLength >= MIN_BLOCK_CHARS &&
							potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
						) {
							splitIndex = k
							break
						}
					}
				}

				finalizeChunk(splitIndex)

				if (i >= chunkStartLineIndex) {
					currentChunkLines.push(line)
					currentChunkLength += lineLength
				} else {
					i = chunkStartLineIndex - 1
					continue
				}
			} else {
				currentChunkLines.push(line)
				currentChunkLength += lineLength
			}
		}

		// Process the last remaining chunk
		if (currentChunkLines.length > 0) {
			finalizeChunk(lines.length - 1)
		}

		return chunks
	}

	private _performFallbackChunking(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		return this._chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
	}

	private _chunkLeafNodeByLines(
		node: Node,
		filePath: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = node.text.split("\n")
		const baseStartLine = node.startPosition.row + 1
		return this._chunkTextByLines(
			lines,
			filePath,
			fileHash,
			node.type, // Use the node's type
			seenSegmentHashes,
			baseStartLine,
		)
	}

	/**
	 * Helper method to process markdown content sections with consistent chunking logic
	 */
	private processMarkdownSection(
		lines: string[],
		filePath: string,
		fileHash: string,
		type: string,
		seenSegmentHashes: Set<string>,
		startLine: number,
		identifier: string | null = null,
	): CodeBlock[] {
		const content = lines.join("\n")

		if (content.trim().length < MIN_BLOCK_CHARS) {
			return []
		}

		// Check if content needs chunking (either total size or individual line size)
		const needsChunking =
			content.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR ||
			lines.some((line) => line.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR)

		if (needsChunking) {
			// Apply chunking for large content or oversized lines
			const chunks = this._chunkTextByLines(lines, filePath, fileHash, type, seenSegmentHashes, startLine)
			// Preserve identifier in all chunks if provided
			if (identifier) {
				chunks.forEach((chunk) => {
					chunk.identifier = identifier
				})
			}
			return chunks
		}

		// Create a single block for normal-sized content with no oversized lines
		const endLine = startLine + lines.length - 1
		const contentPreview = content.slice(0, 100)
		const segmentHash = createHash("sha256")
			.update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
			.digest("hex")

		if (!seenSegmentHashes.has(segmentHash)) {
			seenSegmentHashes.add(segmentHash)
			return [
				{
					file_path: filePath,
					identifier,
					type,
					start_line: startLine,
					end_line: endLine,
					content,
					segmentHash,
					fileHash,
				},
			]
		}

		return []
	}

	private parseMarkdownContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		const markdownCaptures = parseMarkdown(content) || []

		if (markdownCaptures.length === 0) {
			// No headers found, process entire content
			return this.processMarkdownSection(lines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1)
		}

		const results: CodeBlock[] = []
		let lastProcessedLine = 0

		// Process content before the first header
		if (markdownCaptures.length > 0) {
			const firstHeaderLine = markdownCaptures[0].node.startPosition.row
			if (firstHeaderLine > 0) {
				const preHeaderLines = lines.slice(0, firstHeaderLine)
				const preHeaderBlocks = this.processMarkdownSection(
					preHeaderLines,
					filePath,
					fileHash,
					"markdown_content",
					seenSegmentHashes,
					1,
				)
				results.push(...preHeaderBlocks)
			}
		}

		// Process markdown captures (headers and sections)
		for (let i = 0; i < markdownCaptures.length; i += 2) {
			const nameCapture = markdownCaptures[i]
			// Ensure we don't go out of bounds when accessing the next capture
			if (i + 1 >= markdownCaptures.length) break
			const definitionCapture = markdownCaptures[i + 1]

			if (!definitionCapture) continue

			const startLine = definitionCapture.node.startPosition.row + 1
			const endLine = definitionCapture.node.endPosition.row + 1
			const sectionLines = lines.slice(startLine - 1, endLine)

			// Extract header level for type classification
			const headerMatch = nameCapture.name.match(/\.h(\d)$/)
			const headerLevel = headerMatch ? parseInt(headerMatch[1]) : 1
			const headerText = nameCapture.node.text

			const sectionBlocks = this.processMarkdownSection(
				sectionLines,
				filePath,
				fileHash,
				`markdown_header_h${headerLevel}`,
				seenSegmentHashes,
				startLine,
				headerText,
			)
			results.push(...sectionBlocks)

			lastProcessedLine = endLine
		}

		// Process any remaining content after the last header section
		if (lastProcessedLine < lines.length) {
			const remainingLines = lines.slice(lastProcessedLine)
			const remainingBlocks = this.processMarkdownSection(
				remainingLines,
				filePath,
				fileHash,
				"markdown_content",
				seenSegmentHashes,
				lastProcessedLine + 1,
			)
			results.push(...remainingBlocks)
		}

		return results
	}
}

// Export a singleton instance for convenience
export const codeParser = new CodeParser()
