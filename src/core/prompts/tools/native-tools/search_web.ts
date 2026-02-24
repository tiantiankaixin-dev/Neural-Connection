import type OpenAI from "openai"

const SEARCH_WEB_DESCRIPTION = `Perform a web search to get a list of relevant web documents for a given query. Returns URLs, titles, and snippets from search results.

Use this tool to:
- Find documentation or reference materials online
- Research solutions to technical problems
- Discover relevant resources for the current task

Parameters:
- query: (required) The search query string
- domain: (optional) Preferred domain to prioritize in search results
- max_results: (optional) Maximum number of results to return (default: 5, max: 10)

Example: Search for documentation
{ "query": "TypeScript generics tutorial", "domain": null, "max_results": 5 }

Example: Search within a specific domain
{ "query": "useState hook", "domain": "react.dev", "max_results": 5 }`

const QUERY_PARAMETER_DESCRIPTION = "The search query string"

const DOMAIN_PARAMETER_DESCRIPTION = "Optional domain to prioritize in search results (e.g., 'react.dev')"

const MAX_RESULTS_PARAMETER_DESCRIPTION = "Maximum number of results to return (default: 5, max: 10)"

export default {
	type: "function",
	function: {
		name: "search_web",
		description: SEARCH_WEB_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				domain: {
					type: ["string", "null"],
					description: DOMAIN_PARAMETER_DESCRIPTION,
				},
				max_results: {
					type: ["integer", "null"],
					description: MAX_RESULTS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "domain", "max_results"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
