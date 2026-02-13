// Ported from aider's javascript-tags.scm
// Cleaned: removed @doc patterns and unsupported predicates (#strip!, #select-adjacent!)
// Kept supported predicates (#not-match?)
export const javascriptTagsQuery = `
(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

[
  (class
    name: (_) @name.definition.class)
  (class_declaration
    name: (_) @name.definition.class)
] @definition.class

[
  (function_expression
    name: (identifier) @name.definition.function)
  (function_declaration
    name: (identifier) @name.definition.function)
  (generator_function
    name: (identifier) @name.definition.function)
  (generator_function_declaration
    name: (identifier) @name.definition.function)
] @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)])) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.function
    value: [(arrow_function) (function_expression)])) @definition.function

(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function)
  ]
  right: [(arrow_function) (function_expression)]) @definition.function

(pair
  key: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
  arguments: (_) @reference.call)

(new_expression
  constructor: (_) @name.reference.class) @reference.class
`
