/**
 * Lexer Fallback for Reference Extraction
 *
 * Inspired by aider's Pygments fallback strategy:
 * When a language has no tags.scm query (or the query yields zero references),
 * this module scans the source code lexically to extract identifier tokens as references.
 *
 * It filters out language keywords and short/trivial identifiers to reduce noise.
 */

// Common keywords across many languages that should be excluded from reference extraction
const COMMON_KEYWORDS = new Set([
	// Control flow
	"if",
	"else",
	"elif",
	"switch",
	"case",
	"default",
	"for",
	"while",
	"do",
	"break",
	"continue",
	"return",
	"yield",
	"throw",
	"try",
	"catch",
	"finally",
	"with",
	"when",
	"match",
	"guard",

	// Declarations
	"var",
	"let",
	"const",
	"function",
	"class",
	"interface",
	"struct",
	"enum",
	"type",
	"trait",
	"impl",
	"module",
	"namespace",
	"package",
	"import",
	"export",
	"from",
	"require",
	"include",
	"using",
	"use",
	"mod",

	// Modifiers
	"public",
	"private",
	"protected",
	"static",
	"abstract",
	"virtual",
	"override",
	"final",
	"sealed",
	"readonly",
	"async",
	"await",
	"synchronized",
	"volatile",
	"transient",
	"extern",
	"inline",
	"unsafe",

	// Types & values
	"void",
	"null",
	"nil",
	"undefined",
	"true",
	"false",
	"self",
	"this",
	"super",
	"new",
	"delete",
	"typeof",
	"instanceof",
	"sizeof",
	"as",
	"is",
	"in",
	"of",
	"not",
	"and",
	"or",

	// Other
	"extends",
	"implements",
	"constructor",
	"prototype",
	"then",
	"end",
	"begin",
	"def",
	"fn",
	"fun",
	"lambda",
	"proc",
	"puts",
	"print",
	"println",
	"printf",
	"assert",
	"raise",
	"pass",
	"None",
	"True",
	"False",
])

// Minimum identifier length to be considered a meaningful reference
const MIN_IDENTIFIER_LENGTH = 4

// Regex to match identifier tokens (camelCase, snake_case, PascalCase, etc.)
const IDENTIFIER_REGEX = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g

// Regex to detect meaningful naming conventions
const MEANINGFUL_NAME_REGEX = /^(?:[a-z]+[A-Z]|[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]|[A-Z][a-zA-Z]+)/ // camelCase, PascalCase, snake_case

export interface LexerRef {
	name: string
	line: number
}

/**
 * Extract identifier tokens from source code as potential references.
 * Used as a fallback when tree-sitter tags.scm queries yield no references.
 *
 * @param content Source code content
 * @param definedNames Set of names already identified as definitions (to exclude from refs)
 * @returns Array of lexer-extracted references with line numbers
 */
export function extractLexerRefs(content: string, definedNames: Set<string>): LexerRef[] {
	const refs: LexerRef[] = []
	const lines = content.split("\n")

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		// Skip comment lines (simple heuristic)
		const trimmed = line.trimStart()
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("<!--") ||
			trimmed.startsWith("--")
		) {
			continue
		}

		let match: RegExpExecArray | null
		IDENTIFIER_REGEX.lastIndex = 0
		while ((match = IDENTIFIER_REGEX.exec(line)) !== null) {
			const name = match[1]

			// Filter criteria (inspired by aider's nameQualityMul logic)
			if (name.length < MIN_IDENTIFIER_LENGTH) {
				continue
			}
			if (COMMON_KEYWORDS.has(name)) {
				continue
			}
			if (definedNames.has(name)) {
				continue
			}
			// All-uppercase names are likely constants, not references to other code blocks
			if (name === name.toUpperCase() && name.length > 1) {
				continue
			}

			refs.push({ name, line: i + 1 }) // 1-indexed line number
		}
	}

	return refs
}

/**
 * Deduplicate lexer refs by name, keeping the first occurrence line.
 */
export function deduplicateLexerRefs(refs: LexerRef[]): LexerRef[] {
	const seen = new Map<string, number>()
	const result: LexerRef[] = []

	for (const ref of refs) {
		if (!seen.has(ref.name)) {
			seen.set(ref.name, ref.line)
			result.push(ref)
		}
	}

	return result
}
