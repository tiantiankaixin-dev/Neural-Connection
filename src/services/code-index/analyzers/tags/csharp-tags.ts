// Ported from aider's c_sharp-tags.scm
export const csharpTagsQuery = `
(class_declaration
 name: (identifier) @name.definition.class
 ) @definition.class

(class_declaration
   bases: (base_list (_) @name.reference.class)
 ) @reference.class

(interface_declaration
 name: (identifier) @name.definition.interface
 ) @definition.interface

(interface_declaration
 bases: (base_list (_) @name.reference.interface)
 ) @reference.interface

(method_declaration
 name: (identifier) @name.definition.method
 ) @definition.method

(object_creation_expression
 type: (identifier) @name.reference.class
 ) @reference.class

(type_parameter_constraints_clause
 target: (identifier) @name.reference.class
 ) @reference.class

(type_constraint
 type: (identifier) @name.reference.class
 ) @reference.class

(variable_declaration
 type: (identifier) @name.reference.class
 ) @reference.class

(invocation_expression
 function:
  (member_access_expression
    name: (identifier) @name.reference.send
 )
) @reference.send

(member_access_expression
 expression: (identifier) @name.reference.class
) @reference.class

(namespace_declaration
 name: (identifier) @name.definition.module
) @definition.module
`
