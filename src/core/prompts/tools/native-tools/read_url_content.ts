import type OpenAI from "openai"

const READ_URL_CONTENT_DESCRIPTION = `Read content from a web URL. The URL must be an HTTP or HTTPS URL pointing to a valid internet resource.

Use this tool to:
- Fetch documentation from a website
- Read API documentation or reference materials
- Get content from online resources

The content will be converted to readable text format, stripping HTML tags and formatting.

Parameters:
- url: (required) The URL to read content from (must start with http:// or https://)
- max_length: (optional) Maximum characters of content to return (default: 10000)

Example: Read documentation from a URL
{ "url": "https://docs.example.com/api/reference", "max_length": 10000 }

Example: Read with limited content
{ "url": "https://example.com/page", "max_length": 5000 }`

const URL_PARAMETER_DESCRIPTION = "The URL to read content from (must be http:// or https://)"

const MAX_LENGTH_PARAMETER_DESCRIPTION = "Maximum characters of content to return (default: 10000)"

export default {
	type: "function",
	function: {
		name: "read_url_content",
		description: READ_URL_CONTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: URL_PARAMETER_DESCRIPTION,
				},
				max_length: {
					type: ["integer", "null"],
					description: MAX_LENGTH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["url", "max_length"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
