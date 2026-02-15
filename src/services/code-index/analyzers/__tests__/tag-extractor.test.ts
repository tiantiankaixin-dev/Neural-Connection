import { describe, it, expect, vi, beforeEach } from "vitest"
import { TagExtractor, Tag, FileTagResult } from "../tag-extractor"
import { extractLexerRefs, deduplicateLexerRefs } from "../lexer-fallback"

// Must use vi.hoisted() so variables are available when vi.mock factory runs (hoisted)
const { mockCaptures, mockQuery, mockParse, mockParser } = vi.hoisted(() => {
	const mockCaptures = vi.fn()
	const mockQuery = { captures: mockCaptures }
	const mockParse = vi.fn()
	const mockParser = { parse: mockParse }
	return { mockCaptures, mockQuery, mockParse, mockParser }
})

vi.mock("web-tree-sitter", () => ({
	Query: vi.fn().mockImplementation(() => mockQuery),
}))

describe("TagExtractor", () => {
	let extractor: TagExtractor

	beforeEach(() => {
		extractor = new TagExtractor()
		vi.clearAllMocks()
	})

	describe("extract()", () => {
		it("should return empty result when tree parse fails", () => {
			mockParse.mockReturnValue(null)

			const result = extractor.extract("/test/file.ts", "const x = 1;", mockParser as any, {} as any)

			expect(result.tags).toEqual([])
			expect(result.imports).toEqual([])
			expect(result.classDeclarations).toEqual([])
		})

		it("should classify definition captures correctly when tags query is pre-cached", () => {
			const mockNode = {
				text: "myFunction",
				startPosition: { row: 5 },
			}
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 0,
					child: () => null,
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([{ name: "name.definition.function", node: mockNode }])

			// Pre-populate the tags query cache to bypass require("web-tree-sitter")
			;(extractor as any).tagsQueryCache.set("ts", mockQuery)

			const result = extractor.extract("/test/file.ts", "function myFunction() {}", mockParser as any, {} as any)

			const defTags = result.tags.filter((t) => t.kind === "def")
			expect(defTags.length).toBeGreaterThanOrEqual(1)
			expect(defTags[0].name).toBe("myFunction")
			expect(defTags[0].kind).toBe("def")
			expect(defTags[0].subKind).toBe("function")
			expect(defTags[0].line).toBe(6) // 0-indexed row 5 → 1-indexed line 6
		})

		it("should classify reference captures correctly when tags query is pre-cached", () => {
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 0,
					child: () => null,
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([
				{
					name: "name.definition.function",
					node: { text: "foo", startPosition: { row: 0 } },
				},
				{
					name: "name.reference.call",
					node: { text: "bar", startPosition: { row: 2 } },
				},
			])

			// Pre-populate the tags query cache to bypass require("web-tree-sitter")
			;(extractor as any).tagsQueryCache.set("ts", mockQuery)

			const result = extractor.extract(
				"/test/file.ts",
				"function foo() {}\nbar()\n",
				mockParser as any,
				{} as any,
			)

			const refs = result.tags.filter((t) => t.kind === "ref")
			expect(refs.length).toBe(1)
			expect(refs[0].name).toBe("bar")
			expect(refs[0].subKind).toBe("call")
		})

		it("should strip generic type parameters from captured text", () => {
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 0,
					child: () => null,
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([
				{
					name: "name.reference.class",
					node: { text: "Singleton<GameManager>", startPosition: { row: 5 } },
				},
				{
					name: "name.reference.class",
					node: { text: "Dictionary<string, List<int>>", startPosition: { row: 10 } },
				},
				{
					name: "name.definition.class",
					node: { text: "GameManager", startPosition: { row: 0 } },
				},
			])

			// Pre-populate the tags query cache for .cs extension
			;(extractor as any).tagsQueryCache.set("cs", mockQuery)

			const result = extractor.extract(
				"/test/file.cs",
				"class GameManager : Singleton<GameManager> {}",
				mockParser as any,
				{} as any,
			)

			const refs = result.tags.filter((t) => t.kind === "ref")
			expect(refs.length).toBe(2)
			// Generic params should be stripped
			expect(refs[0].name).toBe("Singleton")
			expect(refs[1].name).toBe("Dictionary")

			const defs = result.tags.filter((t) => t.kind === "def")
			expect(defs.length).toBe(1)
			// Non-generic names should be unchanged
			expect(defs[0].name).toBe("GameManager")
		})

		it("should skip empty capture names", () => {
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 0,
					child: () => null,
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([
				{
					name: "name.definition.function",
					node: { text: "", startPosition: { row: 0 } },
				},
			])

			const result = extractor.extract("/test/file.ts", "x", mockParser as any, {} as any)

			// The empty-text capture should be skipped; lexer fallback may add refs
			const defTags = result.tags.filter((t) => t.kind === "def")
			expect(defTags.length).toBe(0)
		})

		it("should fall back to lexer when no refs found", () => {
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 0,
					child: () => null,
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			// Only definitions, no references
			mockCaptures.mockReturnValue([
				{
					name: "name.definition.function",
					node: { text: "myFunc", startPosition: { row: 0 } },
				},
			])

			const content = "function myFunc() { someHelper(); anotherHelper(); }"
			const result = extractor.extract("/test/file.ts", content, mockParser as any, {} as any)

			// Lexer fallback should add refs (someHelper, anotherHelper)
			const refs = result.tags.filter((t) => t.kind === "ref")
			expect(refs.length).toBeGreaterThan(0)
			// Lexer refs should have subKind "lexer"
			for (const ref of refs) {
				expect(ref.subKind).toBe("lexer")
			}
		})
	})

	describe("import extraction", () => {
		it("should extract TypeScript imports", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `import { foo, bar } from "./utils"\nimport path from "path"\n`
			const result = extractor.extract("/test/file.ts", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const fooImport = result.imports.find((i) => i.symbol === "foo")
			expect(fooImport).toBeDefined()
			expect(fooImport!.path).toBe("./utils")
		})

		it("should extract Python imports", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `from os.path import join, exists\nimport sys\n`
			const result = extractor.extract("/test/file.py", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const joinImport = result.imports.find((i) => i.symbol === "join")
			expect(joinImport).toBeDefined()
			expect(joinImport!.path).toBe("os.path")
		})

		it("should return empty for unsupported language imports", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `some content`
			const result = extractor.extract("/test/file.xyz", content, mockParser as any, {} as any)

			expect(result.imports).toEqual([])
		})

		it("should extract Go imports", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `import "fmt"\nimport "net/http"\n`
			const result = extractor.extract("/test/file.go", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const fmtImport = result.imports.find((i) => i.symbol === "fmt")
			expect(fmtImport).toBeDefined()
			expect(fmtImport!.path).toBe("fmt")
			const httpImport = result.imports.find((i) => i.symbol === "http")
			expect(httpImport).toBeDefined()
			expect(httpImport!.path).toBe("net/http")
		})

		it("should extract Rust use statements", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `use std::collections::HashMap;\nuse std::io::{Read, Write};\n`
			const result = extractor.extract("/test/file.rs", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(3)
			const hashMap = result.imports.find((i) => i.symbol === "HashMap")
			expect(hashMap).toBeDefined()
			const readImport = result.imports.find((i) => i.symbol === "Read")
			expect(readImport).toBeDefined()
			const writeImport = result.imports.find((i) => i.symbol === "Write")
			expect(writeImport).toBeDefined()
		})

		it("should extract Java imports", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `import java.util.ArrayList;\nimport static java.lang.Math.PI;\n`
			const result = extractor.extract("/test/file.java", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const arrayList = result.imports.find((i) => i.symbol === "ArrayList")
			expect(arrayList).toBeDefined()
			expect(arrayList!.path).toBe("java.util.ArrayList")
		})

		it("should extract C# using statements", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `using System.Collections.Generic;\nusing static System.Math;\n`
			const result = extractor.extract("/test/file.cs", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const generic = result.imports.find((i) => i.symbol === "Generic")
			expect(generic).toBeDefined()
			expect(generic!.path).toBe("System.Collections.Generic")
		})

		it("should extract Ruby require statements", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `require "json"\nrequire_relative "helpers/utils"\n`
			const result = extractor.extract("/test/file.rb", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const jsonReq = result.imports.find((i) => i.symbol === "json")
			expect(jsonReq).toBeDefined()
			const utilsReq = result.imports.find((i) => i.symbol === "utils")
			expect(utilsReq).toBeDefined()
		})

		it("should extract PHP use statements", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `use App\\Models\\User;\nuse Illuminate\\Support\\Facades\\DB as Database;\n`
			const result = extractor.extract("/test/file.php", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const user = result.imports.find((i) => i.symbol === "User")
			expect(user).toBeDefined()
			expect(user!.path).toBe("App\\Models\\User")
			const db = result.imports.find((i) => i.symbol === "Database")
			expect(db).toBeDefined()
		})

		it("should extract C/C++ includes", () => {
			const mockTree = {
				rootNode: { type: "program", childCount: 0, child: () => null },
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const content = `#include <stdio.h>\n#include "mylib.hpp"\n`
			const result = extractor.extract("/test/file.c", content, mockParser as any, {} as any)

			expect(result.imports.length).toBeGreaterThanOrEqual(2)
			const stdio = result.imports.find((i) => i.symbol === "stdio")
			expect(stdio).toBeDefined()
			expect(stdio!.path).toBe("stdio.h")
			const mylib = result.imports.find((i) => i.symbol === "mylib")
			expect(mylib).toBeDefined()
		})
	})

	describe("class declaration extraction", () => {
		it("should extract class declarations from AST", () => {
			const classNameNode = { text: "MyClass" }
			const superclassNode = { text: "BaseClass" }
			const classNode = {
				type: "class_declaration",
				childForFieldName: (name: string) => {
					if (name === "name") return classNameNode
					if (name === "superclass" || name === "superClass") return superclassNode
					return null
				},
				startPosition: { row: 0 },
				endPosition: { row: 10 },
				childCount: 0,
				child: () => null,
			}
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 1,
					child: (i: number) => (i === 0 ? classNode : null),
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const result = extractor.extract(
				"/test/file.ts",
				"class MyClass extends BaseClass {}",
				mockParser as any,
				{} as any,
			)

			expect(result.classDeclarations.length).toBe(1)
			expect(result.classDeclarations[0].name).toBe("MyClass")
			expect(result.classDeclarations[0].extends).toBe("BaseClass")
			expect(result.classDeclarations[0].startLine).toBe(1)
			expect(result.classDeclarations[0].endLine).toBe(11)
		})

		it("should strip generic type parameters from extends in class declarations", () => {
			// Simulate C# AST: class GameManager : Singleton<GameManager>
			// base_list child is a generic_name node whose text includes type args
			const baseType = {
				text: "Singleton<GameManager>",
				type: "generic_name",
				childCount: 0,
				child: () => null,
			}
			const baseList = {
				type: "base_list",
				childCount: 1,
				child: (i: number) => (i === 0 ? baseType : null),
				children: [baseType],
				childForFieldName: () => null,
			}
			const classNameNode = { text: "GameManager" }
			const classNode = {
				type: "class_declaration",
				childForFieldName: (name: string) => {
					if (name === "name") return classNameNode
					return null
				},
				startPosition: { row: 0 },
				endPosition: { row: 10 },
				childCount: 2,
				child: (i: number) => (i === 1 ? baseList : null),
			}
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 1,
					child: (i: number) => (i === 0 ? classNode : null),
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const result = extractor.extract(
				"/test/file.cs",
				"class GameManager : Singleton<GameManager> {}",
				mockParser as any,
				{} as any,
			)

			expect(result.classDeclarations.length).toBe(1)
			const decl = result.classDeclarations[0]
			expect(decl.name).toBe("GameManager")
			// Generic type params should be stripped
			expect(decl.extends).toBe("Singleton")
		})

		it("should extract implements from class_heritage / heritage_clause", () => {
			// Simulate TS AST: class_declaration → class_heritage → implements_clause → type nodes
			const implTypeA = { text: "Serializable", type: "type_identifier", childCount: 0, child: () => null }
			const implTypeB = { text: "Disposable", type: "type_identifier", childCount: 0, child: () => null }
			const implementsClause = {
				type: "implements_clause",
				childCount: 2,
				child: (i: number) => (i === 0 ? implTypeA : i === 1 ? implTypeB : null),
				children: [implTypeA, implTypeB],
				text: "implements Serializable, Disposable",
				childForFieldName: () => null,
			}
			const extendsTypeNode = { text: "BaseClass", type: "type_identifier", childCount: 0, child: () => null }
			const extendsClause = {
				type: "extends_clause",
				childCount: 2,
				child: (i: number) => (i === 1 ? extendsTypeNode : null),
				children: [extendsTypeNode],
				text: "extends BaseClass",
				childForFieldName: (name: string) => (name === "value" ? extendsTypeNode : null),
			}
			const heritageNode = {
				type: "class_heritage",
				childCount: 2,
				child: (i: number) => (i === 0 ? extendsClause : i === 1 ? implementsClause : null),
				children: [extendsClause, implementsClause],
				childForFieldName: () => null,
			}
			const classNameNode = { text: "MyService" }
			const classNode = {
				type: "class_declaration",
				childForFieldName: (name: string) => {
					if (name === "name") return classNameNode
					return null
				},
				startPosition: { row: 0 },
				endPosition: { row: 20 },
				childCount: 2,
				child: (i: number) => (i === 1 ? heritageNode : null),
			}
			const mockTree = {
				rootNode: {
					type: "program",
					childCount: 1,
					child: (i: number) => (i === 0 ? classNode : null),
				},
				delete: vi.fn(),
			}
			mockParse.mockReturnValue(mockTree)
			mockCaptures.mockReturnValue([])

			const result = extractor.extract(
				"/test/file.ts",
				"class MyService extends BaseClass implements Serializable, Disposable {}",
				mockParser as any,
				{} as any,
			)

			expect(result.classDeclarations.length).toBe(1)
			const decl = result.classDeclarations[0]
			expect(decl.name).toBe("MyService")
			expect(decl.extends).toBe("BaseClass")
			expect(decl.implements).toBeDefined()
			expect(decl.implements).toContain("Serializable")
			expect(decl.implements).toContain("Disposable")
		})
	})
})

describe("extractLexerRefs", () => {
	it("should extract identifiers from code", () => {
		const content = "const result = calculateTotal(items)"
		const refs = extractLexerRefs(content, new Set())

		const names = refs.map((r) => r.name)
		expect(names).toContain("result")
		expect(names).toContain("calculateTotal")
		expect(names).toContain("items")
	})

	it("should filter out language keywords", () => {
		const content = "if (true) { const x = false; return null; }"
		const refs = extractLexerRefs(content, new Set())

		const names = refs.map((r) => r.name)
		expect(names).not.toContain("if")
		expect(names).not.toContain("true")
		expect(names).not.toContain("false")
		expect(names).not.toContain("const")
		expect(names).not.toContain("return")
		expect(names).not.toContain("null")
	})

	it("should exclude defined names", () => {
		const content = "function myFunc() { myFunc(); otherFunc(); }"
		const definedNames = new Set(["myFunc"])
		const refs = extractLexerRefs(content, definedNames)

		const names = refs.map((r) => r.name)
		expect(names).not.toContain("myFunc")
		expect(names).toContain("otherFunc")
	})

	it("should filter out short identifiers (< 4 chars)", () => {
		const content = "let ab = cd + efgh"
		const refs = extractLexerRefs(content, new Set())

		const names = refs.map((r) => r.name)
		expect(names).not.toContain("ab")
		expect(names).not.toContain("cd")
		expect(names).toContain("efgh")
	})

	it("should include line numbers", () => {
		const content = "line1_identifier\nline2_identifier"
		const refs = extractLexerRefs(content, new Set())

		const line1Ref = refs.find((r) => r.name === "line1_identifier")
		const line2Ref = refs.find((r) => r.name === "line2_identifier")
		expect(line1Ref?.line).toBe(1)
		expect(line2Ref?.line).toBe(2)
	})

	it("should filter out ALL_CAPS constants", () => {
		const content = "const x = MAX_RETRIES + DEFAULT_TIMEOUT + calculateValue()"
		const refs = extractLexerRefs(content, new Set())

		const names = refs.map((r) => r.name)
		expect(names).not.toContain("MAX_RETRIES")
		expect(names).not.toContain("DEFAULT_TIMEOUT")
		expect(names).toContain("calculateValue")
	})

	it("should skip comment lines", () => {
		const content = "// someLongIdentifier\n# anotherIdentifier\nrealIdentifier"
		const refs = extractLexerRefs(content, new Set())

		const names = refs.map((r) => r.name)
		expect(names).not.toContain("someLongIdentifier")
		expect(names).not.toContain("anotherIdentifier")
		expect(names).toContain("realIdentifier")
	})
})

describe("deduplicateLexerRefs", () => {
	it("should keep first occurrence and remove duplicates", () => {
		const refs = [
			{ name: "helperFunc", line: 1 },
			{ name: "otherFunc", line: 2 },
			{ name: "helperFunc", line: 5 },
			{ name: "helperFunc", line: 8 },
			{ name: "otherFunc", line: 10 },
		]
		const result = deduplicateLexerRefs(refs)

		expect(result.length).toBe(2)
		expect(result[0]).toEqual({ name: "helperFunc", line: 1 })
		expect(result[1]).toEqual({ name: "otherFunc", line: 2 })
	})

	it("should return empty for empty input", () => {
		expect(deduplicateLexerRefs([])).toEqual([])
	})

	it("should return all refs when no duplicates", () => {
		const refs = [
			{ name: "alpha", line: 1 },
			{ name: "bravo", line: 2 },
			{ name: "charlie", line: 3 },
		]
		const result = deduplicateLexerRefs(refs)
		expect(result.length).toBe(3)
	})
})
