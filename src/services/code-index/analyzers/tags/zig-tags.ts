// Ported from aider's zig-tags.scm
export const zigTagsQuery = `
(FnProto) @name.definition.function
(VarDecl "const" @name.definition.constant)
(VarDecl "var" @name.definition.variable)
`
