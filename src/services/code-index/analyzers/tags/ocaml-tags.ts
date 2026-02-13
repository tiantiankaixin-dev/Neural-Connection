// Ported from aider's ocaml-tags.scm
// Cleaned: removed @doc patterns and unsupported #strip! predicates
// Kept supported predicates (#eq?)
export const ocamlTagsQuery = `
; Modules
(module_definition (module_binding (module_name) @name.definition.module) @definition.module)
(module_path (module_name) @name.reference.module) @reference.module

; Module types
(module_type_definition (module_type_name) @name.definition.interface) @definition.interface
(module_type_path (module_type_name) @name.reference.implementation) @reference.implementation

; Functions
(value_definition
  [
    (let_binding
      pattern: (value_name) @name.definition.function
      (parameter))
    (let_binding
      pattern: (value_name) @name.definition.function
      body: [(fun_expression) (function_expression)])
  ] @definition.function
)

(external (value_name) @name.definition.function) @definition.function

(application_expression
  function: (value_path (value_name) @name.reference.call)) @reference.call

; Operator
(value_definition
  (let_binding
    pattern: (parenthesized_operator (_) @name.definition.function)) @definition.function)

; Classes
[
  (class_definition (class_binding (class_name) @name.definition.class) @definition.class)
  (class_type_definition (class_type_binding (class_type_name) @name.definition.class) @definition.class)
]

[
  (class_path (class_name) @name.reference.class)
  (class_type_path (class_type_name) @name.reference.class)
] @reference.class

; Methods
(method_definition (method_name) @name.definition.method) @definition.method
(method_invocation (method_name) @name.reference.call) @reference.call
`
