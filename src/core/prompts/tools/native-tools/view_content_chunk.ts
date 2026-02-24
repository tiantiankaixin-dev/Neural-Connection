import type OpenAI from "openai"

const VIEW_CONTENT_CHUNK_DESCRIPTION = `View a specific chunk of a web or knowledge base document content using its DocumentId and chunk position.

Use this tool to:
- Navigate through a large document that was read with read_url_content
- View specific sections of a previously fetched document
- Continue reading from where you left off

IMPORTANT: The DocumentId must have already been read by the read_url_content tool before this can be used.

Parameters:
- document_id: (required) The ID of the document that the chunk belongs to
- position: (required) The position/index of the chunk to view (0-indexed)

Example: View first chunk of a document
{ "document_id": "doc-abc123", "position": 0 }

Example: View second chunk
{ "document_id": "doc-abc123", "position": 1 }`

const DOCUMENT_ID_PARAMETER_DESCRIPTION = "The ID of the document that the chunk belongs to"

const POSITION_PARAMETER_DESCRIPTION = "The position of the chunk to view (0-indexed)"

export default {
	type: "function",
	function: {
		name: "view_content_chunk",
		description: VIEW_CONTENT_CHUNK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				document_id: {
					type: "string",
					description: DOCUMENT_ID_PARAMETER_DESCRIPTION,
				},
				position: {
					type: "integer",
					description: POSITION_PARAMETER_DESCRIPTION,
				},
			},
			required: ["document_id", "position"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
