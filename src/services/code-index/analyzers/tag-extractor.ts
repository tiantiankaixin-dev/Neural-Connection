/**
 * File-Level Tag Extractor
 *
 * Extracts definition and reference tags from source code files using tree-sitter
 * tags queries (ported from aider). Falls back to lexer-based extraction when
 * tags queries yield no references.
 *
 * This runs on the COMPLETE file AST (not on chunked blocks) to avoid information
 * loss from chunking. Results are later mapped to individual CodeBlocks by line range.
 */
import * as path from "path"
import { Parser as ParserT, Language as LanguageT, Query as QueryT } from "web-tree-sitter"
import { getTagsQuery } from "./tags"
import { extractLexerRefs } from "./lexer-fallback"

// ─── Exported interfaces ───

export interface Tag {
	name: string
	kind: "def" | "ref"
	line: number // 1-indexed
	filePath: string
	subKind?: string // e.g. "function", "class", "method", "call", "type"
}

export interface ImportInfo {
	symbol: string
	path: string
	line: number // 1-indexed
}

export interface ClassDeclaration {
	name: string
	extends?: string
	implements?: string[]
	startLine: number // 1-indexed
	endLine: number // 1-indexed
}

export interface FileTagResult {
	tags: Tag[]
	imports: ImportInfo[]
	classDeclarations: ClassDeclaration[]
}

// ─── Import extraction regexes ───

// TypeScript/JavaScript: import { X } from "path", import X from "path", import * as X from "path"
const TS_IMPORT_REGEX =
	/import\s+(?:(?:\{([^}]+)\})|(?:\*\s+as\s+(\w+))|(?:(\w+)))\s+from\s+["']([^"']+)["']/g
// Python: from X import Y, import X
const PY_IMPORT_REGEX = /(?:from\s+([\w.]+)\s+import\s+([\w,\s*]+)|import\s+([\w.,\s]+))/g
// Go: import "path", import ( "path" )
const GO_IMPORT_REGEX = /import\s+(?:\(\s*)?(?:(\w+)\s+)?["']([^"']+)["']/g
// Rust: use path::item
const RUST_IMPORT_REGEX = /use\s+([\w]+(?:::[\w]+)*)(?:::\{([^}]+)\})?/g
// Java/Kotlin: import path.Class
const JAVA_IMPORT_REGEX = /import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/g
// C/C++: #include "path" or #include <path>
const C_INCLUDE_REGEX = /#include\s+["<]([^">]+)[">]/g
// C#: using Namespace
const CS_USING_REGEX = /using\s+(?:static\s+)?([\w.]+)\s*;/g
// Ruby: require "path", require_relative "path"
const RUBY_REQUIRE_REGEX = /require(?:_relative)?\s+["']([^"']+)["']/g
// PHP: use Namespace\Class
const PHP_USE_REGEX = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?/g

interface ImportPattern {
	regex: RegExp
	extractor: (match: RegExpExecArray, line: number) => ImportInfo[]
}

const IMPORT_PATTERNS: Record<string, ImportPattern> = {
	ts: {
		regex: TS_IMPORT_REGEX,
		extractor: (match, line) => {
			const modulePath = match[4]
			const symbols: string[] = []
			if (match[1]) {
				symbols.push(...match[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()))
			}
			if (match[2]) symbols.push(match[2])
			if (match[3]) symbols.push(match[3])
			return symbols.map((s) => ({ symbol: s, path: modulePath, line }))
		},
	},
	py: {
		regex: PY_IMPORT_REGEX,
		extractor: (match, line) => {
			if (match[1] && match[2]) {
				return match[2]
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.map((s) => ({ symbol: s, path: match[1], line }))
			}
			if (match[3]) {
				return match[3]
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.map((s) => ({ symbol: s.split(".").pop()!, path: s, line }))
			}
			return []
		},
	},
	go: {
		regex: GO_IMPORT_REGEX,
		extractor: (match, line) => {
			const alias = match[1] || match[2].split("/").pop()!
			return [{ symbol: alias, path: match[2], line }]
		},
	},
	rs: {
		regex: RUST_IMPORT_REGEX,
		extractor: (match, line) => {
			const basePath = match[1]
			if (match[2]) {
				return match[2]
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.map((s) => ({ symbol: s, path: basePath, line }))
			}
			const symbol = basePath.split("::").pop()!
			return [{ symbol, path: basePath, line }]
		},
	},
	java: {
		regex: JAVA_IMPORT_REGEX,
		extractor: (match, line) => {
			const fullPath = match[1]
			const symbol = fullPath.split(".").pop()!
			return [{ symbol, path: fullPath, line }]
		},
	},
	c: {
		regex: C_INCLUDE_REGEX,
		extractor: (match, line) => {
			const includePath = match[1]
			const symbol = path.basename(includePath, path.extname(includePath))
			return [{ symbol, path: includePath, line }]
		},
	},
	cs: {
		regex: CS_USING_REGEX,
		extractor: (match, line) => {
			const ns = match[1]
			const symbol = ns.split(".").pop()!
			return [{ symbol, path: ns, line }]
		},
	},
	rb: {
		regex: RUBY_REQUIRE_REGEX,
		extractor: (match, line) => {
			const reqPath = match[1]
			const symbol = path.basename(reqPath)
			return [{ symbol, path: reqPath, line }]
		},
	},
	php: {
		regex: PHP_USE_REGEX,
		extractor: (match, line) => {
			const ns = match[1]
			const alias = match[2] || ns.split("\\").pop()!
			return [{ symbol: alias, path: ns, line }]
		},
	},
}

// Extension aliases: many extensions share the same import pattern
const EXT_TO_IMPORT_PATTERN: Record<string, string> = {
	ts: "ts",
	tsx: "ts",
	js: "ts",
	jsx: "ts",
	py: "py",
	go: "go",
	rs: "rs",
	java: "java",
	kt: "java",
	kts: "java",
	scala: "java",
	c: "c",
	h: "c",
	cpp: "c",
	hpp: "c",
	cs: "cs",
	rb: "rb",
	php: "php",
}

// ─── Tag Extractor ───

export class TagExtractor {
	// Cache compiled tags Query objects per extension
	private tagsQueryCache: Map<string, QueryT | null> = new Map()

	/**
	 * Extract tags (definitions + references) from a source file.
	 *
	 * @param filePath Absolute path to the file
	 * @param content File content
	 * @param parser Already-loaded tree-sitter Parser for this language
	 * @param language The tree-sitter Language object (needed to create tags Query)
	 * @returns FileTagResult with tags, imports, and class declarations
	 */
	extract(filePath: string, content: string, parser: ParserT, language: LanguageT): FileTagResult {
		const ext = path.extname(filePath).slice(1).toLowerCase()

		// 1. Parse the AST
		const tree = parser.parse(content)
		if (!tree) {
			return { tags: [], imports: [], classDeclarations: [] }
		}

		// 2. Run tags query to get def/ref captures
		const tags = this.extractTagsFromAST(filePath, ext, tree, language)

		// 3. If no refs found, fallback to lexer
		const hasRefs = tags.some((t) => t.kind === "ref")
		if (!hasRefs) {
			const definedNames = new Set(tags.filter((t) => t.kind === "def").map((t) => t.name))
			const lexerRefs = extractLexerRefs(content, definedNames)
			for (const ref of lexerRefs) {
				tags.push({
					name: ref.name,
					kind: "ref",
					line: ref.line,
					filePath,
					subKind: "lexer",
				})
			}
		}

		// 4. Extract imports (regex-based, language-aware)
		const imports = this.extractImports(content, ext)

		// 5. Extract class declarations from the AST
		const classDeclarations = this.extractClassDeclarations(tree, filePath, content)

		tree.delete()

		return { tags, imports, classDeclarations }
	}

	/**
	 * Run tags query on the AST and classify captures into def/ref Tags.
	 */
	private extractTagsFromAST(
		filePath: string,
		ext: string,
		tree: any, // Tree type from web-tree-sitter
		language: LanguageT,
	): Tag[] {
		const tagsQuery = this.getOrCreateTagsQuery(ext, language)
		if (!tagsQuery) {
			// No tags query for this language - all refs will come from lexer fallback
			return []
		}

		const tags: Tag[] = []

		try {
			const captures = tagsQuery.captures(tree.rootNode)

			for (const capture of captures) {
				const captureName = capture.name
				const node = capture.node
				const name = node.text

				if (!name || name.length === 0) {
					continue
				}

				let kind: "def" | "ref" | null = null
				let subKind: string | undefined

				if (captureName.startsWith("name.definition.")) {
					kind = "def"
					subKind = captureName.replace("name.definition.", "")
				} else if (captureName.startsWith("name.reference.")) {
					kind = "ref"
					subKind = captureName.replace("name.reference.", "")
				}
				// Skip captures that don't match def/ref pattern (e.g. @definition.function, @doc)

				if (kind) {
					tags.push({
						name,
						kind,
						line: node.startPosition.row + 1, // Convert 0-indexed to 1-indexed
						filePath,
						subKind,
					})
				}
			}
		} catch (error) {
			console.warn(`Tags query failed for ${filePath}: ${error instanceof Error ? error.message : error}`)
			// Return empty tags - lexer fallback will handle it
		}

		return tags
	}

	/**
	 * Get or create a compiled tags Query for a given file extension.
	 * Returns null if no tags query exists for this language.
	 */
	private getOrCreateTagsQuery(ext: string, language: LanguageT): QueryT | null {
		if (this.tagsQueryCache.has(ext)) {
			return this.tagsQueryCache.get(ext) ?? null
		}

		const queryString = getTagsQuery(ext)
		if (!queryString) {
			this.tagsQueryCache.set(ext, null)
			return null
		}

		try {
			const { Query } = require("web-tree-sitter")
			const query = new Query(language, queryString)
			this.tagsQueryCache.set(ext, query)
			return query
		} catch (error) {
			console.warn(`Failed to compile tags query for .${ext}: ${error instanceof Error ? error.message : error}`)
			this.tagsQueryCache.set(ext, null)
			return null
		}
	}

	/**
	 * Extract import statements using language-aware regex patterns.
	 */
	private extractImports(content: string, ext: string): ImportInfo[] {
		const patternKey = EXT_TO_IMPORT_PATTERN[ext]
		if (!patternKey) {
			return []
		}

		const pattern = IMPORT_PATTERNS[patternKey]
		if (!pattern) {
			return []
		}

		const imports: ImportInfo[] = []
		const lines = content.split("\n")

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			// Reset regex lastIndex for each line
			const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
			let match: RegExpExecArray | null
			while ((match = regex.exec(line)) !== null) {
				try {
					const extracted = pattern.extractor(match, i + 1) // 1-indexed
					imports.push(...extracted)
				} catch {
					// Skip malformed import lines
				}
			}
		}

		return imports
	}

	/**
	 * Extract class declarations from the AST by looking for class-like nodes.
	 * This is a best-effort extraction that works across many languages.
	 */
	private extractClassDeclarations(tree: any, filePath: string, content: string): ClassDeclaration[] {
		const declarations: ClassDeclaration[] = []
		const rootNode = tree.rootNode

		// Walk the AST looking for class-like declarations
		this.walkForClassNodes(rootNode, declarations, content)

		return declarations
	}

	/**
	 * Recursively walk AST nodes to find class declarations.
	 */
	private walkForClassNodes(node: any, declarations: ClassDeclaration[], content: string): void {
		const nodeType = node.type

		// Match common class-like node types across languages
		if (
			nodeType === "class_declaration" ||
			nodeType === "class_definition" ||
			nodeType === "class_specifier" ||
			nodeType === "abstract_class_declaration" ||
			nodeType === "class"
		) {
			const nameNode = node.childForFieldName("name")
			if (nameNode) {
				const decl: ClassDeclaration = {
					name: nameNode.text,
					startLine: node.startPosition.row + 1,
					endLine: node.endPosition.row + 1,
				}

				// Try to extract extends (heritage/superclass)
				const superclassNode =
					node.childForFieldName("superclass") || node.childForFieldName("superClass")
				if (superclassNode) {
					decl.extends = superclassNode.text
				}

				// Try heritage_clause (TypeScript/JavaScript)
				for (let i = 0; i < node.childCount; i++) {
					const child = node.child(i)
					if (!child) continue

					if (child.type === "class_heritage" || child.type === "heritage_clause") {
						const extendsClause = child.children?.find(
							(c: any) => c?.type === "extends_clause" || c?.text?.startsWith("extends"),
						)
						const implementsClause = child.children?.find(
							(c: any) => c?.type === "implements_clause" || c?.text?.startsWith("implements"),
						)
						if (extendsClause) {
							const typeNode = extendsClause.childForFieldName("value") || extendsClause.child(1)
							if (typeNode) {
								decl.extends = typeNode.text
							}
						}
						if (implementsClause) {
							decl.implements = []
							for (let j = 0; j < implementsClause.childCount; j++) {
								const implChild = implementsClause.child(j)
								if (
									implChild &&
									implChild.type !== "implements" &&
									implChild.type !== ","
								) {
									decl.implements.push(implChild.text)
								}
							}
						}
					}

					// Java/C# style: superclass, base_list, type_list
					if (child.type === "superclass" || child.type === "base_list") {
						const types = child.children?.filter(
							(c: any) => c && c.type !== "," && c.type !== "extends" && c.type !== ":",
						)
						if (types && types.length > 0) {
							decl.extends = types[0].text
							if (types.length > 1) {
								decl.implements = types.slice(1).map((t: any) => t.text)
							}
						}
					}

					if (child.type === "type_list") {
						decl.implements = child.children
							?.filter((c: any) => c && c.type !== ",")
							.map((c: any) => c.text)
					}
				}

				declarations.push(decl)
			}
		}

		// Recurse into children (but don't go too deep into class bodies for nested classes)
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i)
			if (child) {
				this.walkForClassNodes(child, declarations, content)
			}
		}
	}
}
