import type OpenAI from "openai"

const READ_NOTEBOOK_DESCRIPTION = `Read and parse a Jupyter notebook (.ipynb) file, displaying cells with their IDs and outputs in a formatted view.

Use this tool to:
- View the contents of a Jupyter notebook
- Understand the structure and flow of notebook cells
- See code, markdown, and output content

The output will show each cell with:
- Cell number (0-indexed)
- Cell ID (for editing)
- Cell type (code/markdown)
- Source content
- Outputs (for code cells)

Parameters:
- path: (required) Absolute path to the Jupyter notebook file (.ipynb)

Example:
{ "path": "/path/to/notebook.ipynb" }`

const PATH_PARAMETER_DESCRIPTION = "Absolute path to the Jupyter notebook file (.ipynb)"

export default {
	type: "function",
	function: {
		name: "read_notebook",
		description: READ_NOTEBOOK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
