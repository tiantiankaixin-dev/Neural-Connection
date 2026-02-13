import { typescriptTagsQuery } from "./typescript-tags"
import { javascriptTagsQuery } from "./javascript-tags"
import { pythonTagsQuery } from "./python-tags"
import { javaTagsQuery } from "./java-tags"
import { rustTagsQuery } from "./rust-tags"
import { goTagsQuery } from "./go-tags"
import { cppTagsQuery } from "./cpp-tags"
import { cTagsQuery } from "./c-tags"
import { csharpTagsQuery } from "./csharp-tags"
import { rubyTagsQuery } from "./ruby-tags"
import { phpTagsQuery } from "./php-tags"
import { swiftTagsQuery } from "./swift-tags"
import { kotlinTagsQuery } from "./kotlin-tags"
import { elixirTagsQuery } from "./elixir-tags"
import { luaTagsQuery } from "./lua-tags"
import { ocamlTagsQuery } from "./ocaml-tags"
import { scalaTagsQuery } from "./scala-tags"
import { solidityTagsQuery } from "./solidity-tags"
import { elispTagsQuery } from "./elisp-tags"
import { zigTagsQuery } from "./zig-tags"

/**
 * Maps file extensions (without dot) to their tags query strings.
 * Tags queries capture both @name.definition.* and @name.reference.* patterns.
 * Extensions not in this map will use lexer fallback for reference extraction.
 */
export const tagsQueryMap: Record<string, string> = {
	// TypeScript / TSX
	ts: typescriptTagsQuery,
	tsx: typescriptTagsQuery,

	// JavaScript / JSX / JSON
	js: javascriptTagsQuery,
	jsx: javascriptTagsQuery,

	// Python
	py: pythonTagsQuery,

	// Java
	java: javaTagsQuery,

	// Rust
	rs: rustTagsQuery,

	// Go
	go: goTagsQuery,

	// C++
	cpp: cppTagsQuery,
	hpp: cppTagsQuery,

	// C
	c: cTagsQuery,
	h: cTagsQuery,

	// C#
	cs: csharpTagsQuery,

	// Ruby
	rb: rubyTagsQuery,

	// PHP
	php: phpTagsQuery,

	// Swift
	swift: swiftTagsQuery,

	// Kotlin
	kt: kotlinTagsQuery,
	kts: kotlinTagsQuery,

	// Elixir
	ex: elixirTagsQuery,
	exs: elixirTagsQuery,

	// Lua
	lua: luaTagsQuery,

	// OCaml
	ml: ocamlTagsQuery,
	mli: ocamlTagsQuery,

	// Scala
	scala: scalaTagsQuery,

	// Solidity
	sol: solidityTagsQuery,

	// Elisp
	el: elispTagsQuery,

	// Zig
	zig: zigTagsQuery,
}

/**
 * Get the tags query string for a given file extension.
 * @param extension File extension without dot (e.g., "ts", "py")
 * @returns Tags query string or undefined if no tags query exists for this language
 */
export function getTagsQuery(extension: string): string | undefined {
	return tagsQueryMap[extension.toLowerCase()]
}

/**
 * Check if a language has a dedicated tags query (vs needing lexer fallback).
 */
export function hasTagsQuery(extension: string): boolean {
	return extension.toLowerCase() in tagsQueryMap
}
