// Ported from aider's elixir-tags.scm
// Cleaned: removed ignore patterns for kernel keywords (kept #match? which is supported)
export const elixirTagsQuery = `
; Definitions

; modules and protocols
(call
  target: (identifier) @_keyword
  (arguments (alias) @name.definition.module)
  (#match? @_keyword "^(defmodule|defprotocol)$")) @definition.module

; functions/macros
(call
  target: (identifier) @_keyword
  (arguments
    [
      (identifier) @name.definition.function
      (call target: (identifier) @name.definition.function)
      (binary_operator
        left: (call target: (identifier) @name.definition.function)
        operator: "when")
    ])
  (#match? @_keyword "^(def|defp|defdelegate|defguard|defguardp|defmacro|defmacrop|defn|defnp)$")) @definition.function

; References

; function call
(call
  target: [
   (identifier) @name.reference.call
   (dot
     right: (identifier) @name.reference.call)
  ]) @reference.call

; pipe into function call
(binary_operator
  operator: "|>"
  right: (identifier) @name.reference.call) @reference.call

; modules
(alias) @name.reference.module @reference.module
`
