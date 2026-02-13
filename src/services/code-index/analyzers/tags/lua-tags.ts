// Ported from aider's lua-tags.scm
// Fixed: tree-sitter-lua (tree-sitter-wasms) uses function_definition_statement,
// local_function_definition_statement, not function_declaration/function_statement
export const luaTagsQuery = `
(function_definition_statement
  name: (identifier) @name.definition.function) @definition.function

(local_function_definition_statement
  name: (identifier) @name.definition.function) @definition.function

(call
  (variable
    (identifier) @name.reference.call)) @reference.call
`
