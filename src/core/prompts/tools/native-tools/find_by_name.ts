import type OpenAI from "openai"

const FIND_BY_NAME_DESCRIPTION = `Search for files and directories by name within a specified directory using glob patterns. This tool is optimized for fast file discovery based on names, extensions, and path patterns. Uses smart case matching and respects .gitignore by default.

Results are capped at 50 matches to avoid overwhelming output. Use filters to narrow down searches when needed.

Parameters:
- path: (required) The directory to search within, relative to workspace
- pattern: (required) Glob pattern to match file/directory names (e.g., "*.ts", "test*", "**/*.json")
- extensions: (optional) Array of file extensions to include (without leading dot), e.g., ["ts", "tsx", "js"]
- excludes: (optional) Array of glob patterns to exclude (e.g., ["node_modules", "*.test.ts"])
- max_depth: (optional) Maximum directory depth to search (1 = current directory only)
- type: (optional) Filter by type: "file", "directory", or "any" (default: "any")
- full_path: (optional) If true, pattern matches against full path; if false (default), only filename

Example: Find all TypeScript files in src
{ "path": "src", "pattern": "*", "extensions": ["ts", "tsx"] }

Example: Find test files excluding node_modules
{ "path": ".", "pattern": "*.test.*", "excludes": ["node_modules"] }

Example: Find directories named "components"
{ "path": "src", "pattern": "components", "type": "directory" }

Example: Find package.json files up to 3 levels deep
{ "path": ".", "pattern": "package.json", "max_depth": 3 }`

const PATH_PARAMETER_DESCRIPTION = "Directory to search within, relative to the workspace"

const PATTERN_PARAMETER_DESCRIPTION =
	"Glob pattern to match file/directory names. Supports wildcards: * (any chars), ? (single char), ** (recursive)"

const EXTENSIONS_PARAMETER_DESCRIPTION =
	"File extensions to include (without leading dot). Files must match at least one extension"

const EXCLUDES_PARAMETER_DESCRIPTION = "Glob patterns to exclude from results (e.g., node_modules, *.min.js)"

const MAX_DEPTH_PARAMETER_DESCRIPTION =
	"Maximum directory depth to search. 1 = current directory only, undefined = unlimited"

const TYPE_PARAMETER_DESCRIPTION =
	"Filter by entry type: 'file' for files only, 'directory' for directories only, 'any' for both"

const FULL_PATH_PARAMETER_DESCRIPTION =
	"If true, pattern matches against the full path; if false (default), only the filename is matched"

export default {
	type: "function",
	function: {
		name: "find_by_name",
		description: FIND_BY_NAME_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				pattern: {
					type: "string",
					description: PATTERN_PARAMETER_DESCRIPTION,
				},
				extensions: {
					type: ["array", "null"],
					items: { type: "string" },
					description: EXTENSIONS_PARAMETER_DESCRIPTION,
				},
				excludes: {
					type: ["array", "null"],
					items: { type: "string" },
					description: EXCLUDES_PARAMETER_DESCRIPTION,
				},
				max_depth: {
					type: ["integer", "null"],
					description: MAX_DEPTH_PARAMETER_DESCRIPTION,
				},
				type: {
					type: ["string", "null"],
					enum: ["file", "directory", "any", null],
					description: TYPE_PARAMETER_DESCRIPTION,
				},
				full_path: {
					type: ["boolean", "null"],
					description: FULL_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "pattern", "extensions", "excludes", "max_depth", "type", "full_path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
