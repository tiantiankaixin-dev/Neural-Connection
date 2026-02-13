/**
 * Integration tests for TagExtractor using REAL tree-sitter wasm parsers.
 *
 * These tests load actual .wasm language files and compile real tags.scm queries
 * against real code snippets. If a tags.scm pattern is wrong, these tests WILL catch it.
 *
 * Unlike the unit tests in tag-extractor.test.ts (which mock tree-sitter),
 * these tests exercise the full pipeline:
 *   real code → real parser.parse() → real Query.captures() → tag classification
 */
import { describe, it, expect, beforeAll } from "vitest"
import path from "path"
import { TagExtractor } from "../tag-extractor"

// web-tree-sitter types
let Parser: any
let Language: any
let Query: any

const WASM_DIR = path.resolve(__dirname, "../../../../dist")

async function loadLang(langName: string) {
	const wasmPath = path.join(WASM_DIR, `tree-sitter-${langName}.wasm`)
	return await Language.load(wasmPath)
}

async function makeParser(language: any) {
	const parser = new Parser()
	parser.setLanguage(language)
	return parser
}

describe("TagExtractor — real tree-sitter integration", () => {
	let extractor: TagExtractor

	beforeAll(async () => {
		// Dynamic import to handle wasm initialization
		const wts = require("web-tree-sitter")
		Parser = wts.default?.Parser || wts.Parser || wts
		Language = wts.default?.Language || wts.Language
		Query = wts.default?.Query || wts.Query

		// If Parser itself needs init (web-tree-sitter convention)
		if (typeof Parser.init === "function") {
			await Parser.init()
		}

		extractor = new TagExtractor()
	})

	// ─── TypeScript ───

	describe("TypeScript", () => {
		let tsParser: any
		let tsLanguage: any

		beforeAll(async () => {
			tsLanguage = await loadLang("typescript")
			tsParser = await makeParser(tsLanguage)
		})

		it("should extract function definition from real TS code", () => {
			const code = `function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}`
			const result = extractor.extract("/test/math.ts", code, tsParser, tsLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("calculateTotal")
		})

		it("should extract class and method definitions from real TS code", () => {
			const code = `class UserService {
  private users: Map<string, User> = new Map();

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async createUser(data: CreateUserDto): Promise<User> {
    const user = new User(data);
    this.users.set(user.id, user);
    return user;
  }
}`
			const result = extractor.extract("/test/user-service.ts", code, tsParser, tsLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("UserService")
			expect(defNames).toContain("findById")
			expect(defNames).toContain("createUser")
		})

		it("should extract interface definitions from real TS code", () => {
			const code = `interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

type UserId = string;

enum Role {
  Admin = "ADMIN",
  User = "USER",
}`
			const result = extractor.extract("/test/types.ts", code, tsParser, tsLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("ApiResponse")
			expect(defNames).toContain("UserId")
			expect(defNames).toContain("Role")
		})

		it("should extract references (or fall back to lexer) from real TS code", () => {
			const code = `import { Logger } from "./logger";

function processOrder(order: Order): void {
  const validator = new OrderValidator();
  validator.validate(order);
  Logger.info("Order processed", { orderId: order.id });
  sendNotification(order.userId);
}`
			const result = extractor.extract("/test/order.ts", code, tsParser, tsLanguage)

			// Either tags query captures refs, or lexer fallback does
			const refs = result.tags.filter((t) => t.kind === "ref")
			const refNames = refs.map((t) => t.name)

			// These symbols are used but not defined in this file — must appear as refs
			const expectedRefs = ["OrderValidator", "sendNotification"]
			for (const expected of expectedRefs) {
				expect(refNames).toContain(expected)
			}
		})

		it("should extract arrow function definitions", () => {
			const code = `const fetchData = async (url: string): Promise<Response> => {
  return await fetch(url);
};

const multiply = (a: number, b: number) => a * b;`
			const result = extractor.extract("/test/utils.ts", code, tsParser, tsLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("fetchData")
			expect(defNames).toContain("multiply")
		})

		it("should extract class declarations with extends", () => {
			const code = `class AdminService extends UserService {
  async deleteUser(id: string): Promise<void> {
    await this.findById(id);
  }
}`
			const result = extractor.extract("/test/admin.ts", code, tsParser, tsLanguage)

			expect(result.classDeclarations.length).toBeGreaterThanOrEqual(1)
			const adminClass = result.classDeclarations.find((c) => c.name === "AdminService")
			expect(adminClass).toBeDefined()
			expect(adminClass!.extends).toBe("UserService")
		})

		it("should extract imports from real TS code", () => {
			const code = `import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { Config } from "./config";`
			const result = extractor.extract("/test/io.ts", code, tsParser, tsLanguage)

			expect(result.imports.length).toBeGreaterThanOrEqual(3)
			const importSymbols = result.imports.map((i) => i.symbol)
			expect(importSymbols).toContain("readFile")
			expect(importSymbols).toContain("writeFile")
			expect(importSymbols).toContain("path")
		})
	})

	// ─── JavaScript ───

	describe("JavaScript", () => {
		let jsParser: any
		let jsLanguage: any

		beforeAll(async () => {
			jsLanguage = await loadLang("javascript")
			jsParser = await makeParser(jsLanguage)
		})

		it("should extract function and class definitions from real JS code", () => {
			const code = `class EventEmitter {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  emit(event, ...args) {
    const handlers = this.listeners[event];
    if (handlers) {
      handlers.forEach(handler => handler(...args));
    }
  }
}

function createEmitter() {
  return new EventEmitter();
}`
			const result = extractor.extract("/test/emitter.js", code, jsParser, jsLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("EventEmitter")
			expect(defNames).toContain("createEmitter")
		})

		it("should extract references from real JS code (tags or lexer)", () => {
			// DatabaseClient.query() → member_expression captures "query" as ref
			// parseResponse() and sendToCache() → direct call captures
			const code = `const result = DatabaseClient.query("SELECT * FROM users");
const parsed = parseResponse(result);
sendToCache(parsed);`
			const result = extractor.extract("/test/db.js", code, jsParser, jsLanguage)

			const refs = result.tags.filter((t) => t.kind === "ref")
			const refNames = refs.map((t) => t.name)
			// Direct function calls are captured as refs
			expect(refNames).toContain("parseResponse")
			expect(refNames).toContain("sendToCache")
			// Member expression captures the property, not the object
			expect(refNames).toContain("query")
		})
	})

	// ─── Python ───

	describe("Python", () => {
		let pyParser: any
		let pyLanguage: any

		beforeAll(async () => {
			pyLanguage = await loadLang("python")
			pyParser = await makeParser(pyLanguage)
		})

		it("should extract function and class definitions from real Python code", () => {
			const code = `class DataProcessor:
    def __init__(self, config):
        self.config = config

    def process_batch(self, items):
        return [self.transform(item) for item in items]

    def transform(self, item):
        return item.upper()

def create_processor(config_path):
    config = load_config(config_path)
    return DataProcessor(config)`
			const result = extractor.extract("/test/processor.py", code, pyParser, pyLanguage)

			const defs = result.tags.filter((t) => t.kind === "def")
			const defNames = defs.map((t) => t.name)
			expect(defNames).toContain("DataProcessor")
			expect(defNames).toContain("process_batch")
			expect(defNames).toContain("transform")
			expect(defNames).toContain("create_processor")
		})

		it("should extract references from real Python code (tags or lexer)", () => {
			const code = `from utils import validate_input

def handle_request(request):
    validate_input(request.body)
    result = DatabaseService.execute(request.query)
    return format_response(result)`
			const result = extractor.extract("/test/handler.py", code, pyParser, pyLanguage)

			const refs = result.tags.filter((t) => t.kind === "ref")
			const refNames = refs.map((t) => t.name)
			expect(refNames).toContain("validate_input")
			expect(refNames).toContain("format_response")
		})

		it("should extract Python imports", () => {
			const code = `from os.path import join, exists
import json
from typing import List, Dict`
			const result = extractor.extract("/test/imports.py", code, pyParser, pyLanguage)

			expect(result.imports.length).toBeGreaterThanOrEqual(3)
			const symbols = result.imports.map((i) => i.symbol)
			expect(symbols).toContain("join")
			expect(symbols).toContain("exists")
			expect(symbols).toContain("json")
		})
	})

	// ─── Cross-language: tags query compilation smoke test ───

	describe("tags query compilation", () => {
		const languagesToTest = [
			{ name: "typescript", ext: "ts" },
			{ name: "javascript", ext: "js" },
			{ name: "python", ext: "py" },
			{ name: "java", ext: "java" },
			{ name: "rust", ext: "rs" },
			{ name: "go", ext: "go" },
			{ name: "cpp", ext: "cpp" },
			{ name: "c", ext: "c" },
			{ name: "c_sharp", ext: "cs" },
			{ name: "ruby", ext: "rb" },
			{ name: "php", ext: "php" },
			{ name: "swift", ext: "swift" },
			{ name: "kotlin", ext: "kt" },
			{ name: "lua", ext: "lua" },
		]

		for (const { name, ext } of languagesToTest) {
			it(`should compile tags query for ${name} without error`, async () => {
				const { getTagsQuery } = await import("../tags")
				const queryString = getTagsQuery(ext)

				if (!queryString) {
					// Some languages might not have tags queries — that's acceptable
					return
				}

				let lang: any
				try {
					lang = await loadLang(name)
				} catch {
					// wasm file might not exist for some languages in test env
					return
				}

				// This is the critical test: does the tags.scm query string
				// compile against the real grammar without throwing?
				expect(() => new Query(lang, queryString)).not.toThrow()
			})
		}
	})
})
