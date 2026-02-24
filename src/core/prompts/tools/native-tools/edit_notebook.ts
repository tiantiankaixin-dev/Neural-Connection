import type OpenAI from "openai"

const EDIT_NOTEBOOK_DESCRIPTION = `Edit a specific cell in a Jupyter notebook (.ipynb) file. You can replace cell content or insert a new cell.

Use this tool to:
- Modify code or markdown in a specific cell
- Insert new cells at a specific position
- Update cell content after reading with read_notebook

Parameters:
- absolute_path: (required) Absolute path to the Jupyter notebook file
- new_source: (required) The new content for the cell
- cell_number: (optional) 0-indexed cell number to edit (default: 0)
- cell_type: (optional) Cell type: 'code' or 'markdown' (required for insert mode)
- edit_mode: (optional) 'replace' to modify existing cell, 'insert' to add new cell (default: 'replace')
- cell_id: (optional) Alternative to cell_number for targeting specific cells

Example: Replace cell 0 content
{ "absolute_path": "/path/to/notebook.ipynb", "new_source": "print('updated')", "cell_number": 0 }

Example: Insert new code cell at position 2
{ "absolute_path": "/path/to/notebook.ipynb", "new_source": "# New cell", "cell_number": 2, "cell_type": "code", "edit_mode": "insert" }

IMPORTANT:
- Use read_notebook first to understand the notebook structure
- cell_number is 0-indexed
- When inserting into an empty notebook, cell_number must be 0
- Cascade cannot delete notebook cells - ask user to delete manually if needed`

const ABSOLUTE_PATH_PARAMETER_DESCRIPTION = "Absolute path to the Jupyter notebook file (.ipynb)"

const NEW_SOURCE_PARAMETER_DESCRIPTION = "New content for the cell"

const CELL_NUMBER_PARAMETER_DESCRIPTION = "0-indexed cell number to edit (default: 0)"

const CELL_TYPE_PARAMETER_DESCRIPTION = "Cell type: 'code' or 'markdown' (required for insert mode)"

const EDIT_MODE_PARAMETER_DESCRIPTION = "Edit operation: 'replace' or 'insert' (default: 'replace')"

const CELL_ID_PARAMETER_DESCRIPTION = "Alternative to cell_number for targeting specific cells by ID"

export default {
	type: "function",
	function: {
		name: "edit_notebook",
		description: EDIT_NOTEBOOK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				absolute_path: {
					type: "string",
					description: ABSOLUTE_PATH_PARAMETER_DESCRIPTION,
				},
				new_source: {
					type: "string",
					description: NEW_SOURCE_PARAMETER_DESCRIPTION,
				},
				cell_number: {
					type: ["integer", "null"],
					description: CELL_NUMBER_PARAMETER_DESCRIPTION,
				},
				cell_type: {
					type: ["string", "null"],
					enum: ["code", "markdown", null],
					description: CELL_TYPE_PARAMETER_DESCRIPTION,
				},
				edit_mode: {
					type: ["string", "null"],
					enum: ["replace", "insert", null],
					description: EDIT_MODE_PARAMETER_DESCRIPTION,
				},
				cell_id: {
					type: ["string", "null"],
					description: CELL_ID_PARAMETER_DESCRIPTION,
				},
			},
			required: ["absolute_path", "new_source", "cell_number", "cell_type", "edit_mode", "cell_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
