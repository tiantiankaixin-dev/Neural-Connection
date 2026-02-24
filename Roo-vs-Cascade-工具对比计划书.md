# Roo vs Cascade 工具集完整对比分析计划书

> **生成日期**: 2026-02-24
> **目的**: 对 Roo (Cline/Roo Code) 的 Architect 模式工具集与 Cascade (Windsurf) 工具集进行逐一详细对比，找出所有参数缺漏、功能差异和设计差异
> **数据来源**: Roo 系统 prompt JSON 完整定义 + Cascade 实际可用工具 schema

---

## 一、概述

### 1.1 Roo 工具集总览（14个工具）

| #   | 工具名                    | 参数状态       | 描述                   |
| --- | ------------------------- | -------------- | ---------------------- |
| 1   | `codebase_search_broad`   | ✅ 完整定义    | 探索式语义搜索         |
| 2   | `codebase_search_precise` | ✅ 完整定义    | 精确符号语义搜索       |
| 3   | `apply_diff`              | ❌ `{}` 空参数 | 通过 diff 应用代码变更 |
| 4   | `ask_followup_question`   | ✅ 完整定义    | 向用户提问             |
| 5   | `attempt_completion`      | ✅ 完整定义    | 向用户呈现最终结果     |
| 6   | `browser_action`          | ❌ `{}` 空参数 | 浏览器自动化操作       |
| 7   | `list_files`              | ❌ `{}` 空参数 | 列出目录内容           |
| 8   | `new_task`                | ❌ `{}` 空参数 | 创建子任务             |
| 9   | `read_file`               | ❌ `{}` 空参数 | 读取文件内容           |
| 10  | `skill`                   | ❌ `{}` 空参数 | 加载并执行技能         |
| 11  | `search_files`            | ❌ `{}` 空参数 | 正则搜索文件           |
| 12  | `switch_mode`             | ❌ `{}` 空参数 | 切换模式               |
| 13  | `update_todo_list`        | ✅ 完整定义    | 更新 TODO 列表         |
| 14  | `write_to_file`           | ❌ `{}` 空参数 | 创建或覆写文件         |

**注意**: 14个工具中仅有 **5个** 有完整的参数 schema 定义，其余 **9个** 的 `parameters.properties` 为空对象 `{}`。

### 1.2 Cascade 工具集总览（28+个工具）

| #   | 工具名                   | 参数状态    | 描述                         |
| --- | ------------------------ | ----------- | ---------------------------- |
| 1   | `ask_user_question`      | ✅ 完整定义 | 向用户提问（含多选项）       |
| 2   | `browser_preview`        | ✅ 完整定义 | Web 服务器预览               |
| 3   | `check_deploy_status`    | ✅ 完整定义 | 检查部署状态                 |
| 4   | `code_search`            | ✅ 完整定义 | 语义代码搜索（子代理模式）   |
| 5   | `command_status`         | ✅ 完整定义 | 后台命令状态查询             |
| 6   | `create_memory`          | ✅ 完整定义 | 持久化记忆数据库             |
| 7   | `deploy_web_app`         | ✅ 完整定义 | 部署 Web 应用                |
| 8   | `edit`                   | ✅ 完整定义 | 精确字符串替换编辑           |
| 9   | `edit_notebook`          | ✅ 完整定义 | 编辑 Jupyter Notebook 单元格 |
| 10  | `find_by_name`           | ✅ 完整定义 | 按名称/扩展名搜索文件        |
| 11  | `grep_search`            | ✅ 完整定义 | 基于 ripgrep 的搜索          |
| 12  | `list_dir`               | ✅ 完整定义 | 列出目录内容                 |
| 13  | `multi_edit`             | ✅ 完整定义 | 单文件多处原子化编辑         |
| 14  | `read_deployment_config` | ✅ 完整定义 | 读取部署配置                 |
| 15  | `read_file`              | ✅ 完整定义 | 读取文件（支持渐进式）       |
| 16  | `read_notebook`          | ✅ 完整定义 | 读取 Jupyter Notebook        |
| 17  | `read_resource`          | ✅ 完整定义 | 读取 MCP 资源                |
| 18  | `read_terminal`          | ✅ 完整定义 | 读取终端内容                 |
| 19  | `read_url_content`       | ✅ 完整定义 | 读取 URL 内容                |
| 20  | `run_command`            | ✅ 完整定义 | 执行终端命令                 |
| 21  | `search_web`             | ✅ 完整定义 | 网络搜索                     |
| 22  | `todo_list`              | ✅ 完整定义 | TODO 列表管理                |
| 23  | `trajectory_search`      | ✅ 完整定义 | 搜索对话历史                 |
| 24  | `view_content_chunk`     | ✅ 完整定义 | 查看文档内容块               |
| 25  | `write_to_file`          | ✅ 完整定义 | 创建新文件                   |
| 26  | `list_resources`         | ✅ 完整定义 | 列出 MCP 资源                |
| 27  | `mcp14_guess_tool`       | ✅ 完整定义 | MCP Unity 工具猜测           |
| 28  | `mcp14_unity_tools`      | ✅ 完整定义 | MCP Unity 工具执行           |
| 29  | `mcp25_yofayac_tabi`     | ✅ 完整定义 | yofayac_tabi MCP 工具        |

**Cascade 所有工具均有完整参数 schema 定义。**

---

## 二、逐工具详细对比

### 2.1 文件读取 — `read_file`

#### Roo 定义

```json
{
	"name": "read_file",
	"description": "Read file contents at a path",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**
- 描述仅说"读取路径上的文件内容"
- 系统提示中提到可以"read and write files"，但工具定义无任何参数

#### Cascade 定义

```json
{
	"name": "read_file",
	"parameters": {
		"properties": {
			"file_path": {
				"description": "The path to the file to read. Must be an absolute path.",
				"type": "string"
			},
			"offset": {
				"description": "The 1-indexed line number to start reading from. Only provide if the file is larger than 1000 lines to read a portion of the file.",
				"type": "integer"
			},
			"limit": {
				"description": "The number of lines to read. Only provide if you also provide the offset parameter. Keep this large (hundreds of lines) to minimize how many times you need to call the tool to read a whole file.",
				"type": "integer"
			}
		},
		"required": ["file_path"]
	}
}
```

#### 差异分析

| 参数/特性    | Roo                   | Cascade                                | 差距说明                         |
| ------------ | --------------------- | -------------------------------------- | -------------------------------- |
| `file_path`  | ❌ 未定义(但隐含需要) | ✅ 必选, string, 绝对路径              | Roo 的 schema 中完全没有路径参数 |
| `offset`     | ❌ 不存在             | ✅ 可选, integer, 1-indexed 行号       | Roo 无法从指定行开始读           |
| `limit`      | ❌ 不存在             | ✅ 可选, integer, 读取行数             | Roo 无法限制读取行数             |
| 渐进式读取   | ❌                    | ✅ offset+limit 组合                   | Roo 只能一次性全量读取           |
| 图片自动识别 | ❌ 未提及             | ✅ jpg/png/gif/svg等自动视觉呈现       | Roo 无法查看图片                 |
| 行号格式     | ❌ 未提及             | ✅ cat -n 格式 (1-indexed)             | -                                |
| 长行截断     | ❌ 未提及             | ✅ 超2000字符自动截断                  | -                                |
| 批量读取     | ❌ 未提及             | ✅ 可在单次响应中并行调用多个read_file | -                                |
| 空文件处理   | ❌ 未提及             | ✅ 空文件返回系统提醒警告              | -                                |

**关键缺漏**: Roo 缺少 `offset` 和 `limit` 参数，无法渐进式读取大文件。对于超过1000行的文件，Cascade 可以分段读取，而 Roo 只能一次性全量加载。

---

### 2.2 文件搜索 — `search_files` vs `grep_search`

#### Roo 定义

```json
{
	"name": "search_files",
	"description": "Search files with regex patterns",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**

#### Cascade 定义

```json
{
	"name": "grep_search",
	"parameters": {
		"properties": {
			"SearchPath": {
				"description": "The path to search. This can be a directory or a file. This is a required parameter.",
				"type": "string"
			},
			"Query": {
				"description": "The search term or pattern to look for within files.",
				"type": "string"
			},
			"Includes": {
				"description": "Glob patterns to filter files found within the 'SearchPath', if 'SearchPath' is a directory. For example, '*.go' to only include Go files, or '!**/vendor/*' to exclude vendor directories.",
				"items": { "type": "string" },
				"type": "array"
			},
			"MatchPerLine": {
				"description": "Show the surrounding file content together with the matches, instead of just the files. Use this ONLY if you have found a very specific search, and not for broad initial searches.",
				"type": "boolean"
			},
			"CaseSensitive": {
				"description": "If true, performs a case-sensitive search. Defaults to false (case-insensitive).",
				"type": "boolean"
			},
			"FixedStrings": {
				"description": "If true, treats Query as a literal string where all characters are matched exactly (no regex). Defaults to false (regex).",
				"type": "boolean"
			}
		},
		"required": ["SearchPath", "Query"]
	}
}
```

#### 差异分析

| 参数/特性    | Roo `search_files` | Cascade `grep_search`                                   | 差距说明                           |
| ------------ | ------------------ | ------------------------------------------------------- | ---------------------------------- |
| 搜索路径     | ❌ 未定义          | ✅ `SearchPath` 必选, 可为目录或文件                    | Roo schema 中无路径参数            |
| 搜索查询     | ❌ 未定义          | ✅ `Query` 必选, 搜索词或正则模式                       | Roo schema 中无查询参数            |
| 文件类型过滤 | ❌ 不存在          | ✅ `Includes` glob 数组 (如 `"*.js"`, `"!**/vendor/*"`) | 无法按文件类型筛选搜索范围         |
| 上下文显示   | ❌ 不存在          | ✅ `MatchPerLine` 布尔值，显示匹配行周围内容            | 无法查看匹配行的上下文             |
| 大小写控制   | ❌ 不存在          | ✅ `CaseSensitive` 布尔值，默认 false                   | 无法控制大小写敏感性               |
| 字面量搜索   | ❌ 不存在          | ✅ `FixedStrings` 布尔值，关闭正则                      | 搜索包含正则特殊字符的字面量时困难 |
| 底层引擎     | 未知               | ripgrep (极快)                                          | -                                  |
| 结果截断     | 未知               | 结果过多时截断，需缩小搜索范围                          | -                                  |

**关键缺漏**: Roo 的 `search_files` 参数完全为空，缺少所有6个关键参数。无法过滤文件类型、控制大小写、查看上下文、做字面量搜索。

---

### 2.3 文件列表 — `list_files` vs `list_dir` + `find_by_name`

#### Roo 定义

```json
{
	"name": "list_files",
	"description": "List directory contents",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**
- 系统提示中提到了 `recursive` 参数（"If you pass 'true' for the recursive parameter, it will list files recursively"），但工具 schema 中**未定义此参数**
- 这意味着系统提示和工具 schema 之间存在**不一致**

#### Cascade `list_dir` 定义

```json
{
	"name": "list_dir",
	"parameters": {
		"properties": {
			"DirectoryPath": {
				"description": "The absolute path to the directory to list (must be absolute, not relative)",
				"type": "string"
			}
		},
		"required": ["DirectoryPath"]
	}
}
```

#### Cascade `find_by_name` 定义

```json
{
	"name": "find_by_name",
	"parameters": {
		"properties": {
			"SearchDirectory": {
				"description": "The directory to search within",
				"type": "string"
			},
			"Pattern": {
				"description": "Pattern to search for, supports glob format",
				"type": "string"
			},
			"Extensions": {
				"description": "Optional, file extensions to include (without leading .), matching paths must match at least one of the included extensions",
				"items": { "type": "string" },
				"type": "array"
			},
			"Excludes": {
				"description": "Optional, exclude files/directories that match the given glob patterns",
				"items": { "type": "string" },
				"type": "array"
			},
			"MaxDepth": {
				"description": "Optional, maximum depth to search",
				"type": "integer"
			},
			"Type": {
				"description": "Optional, type filter, enum=file,directory,any",
				"type": "string"
			},
			"FullPath": {
				"description": "Optional, whether the full absolute path must match the glob pattern",
				"type": "boolean"
			}
		},
		"required": ["SearchDirectory", "Pattern"]
	}
}
```

#### 差异分析

| 参数/特性  | Roo `list_files`         | Cascade `list_dir`              | Cascade `find_by_name`         | 差距说明              |
| ---------- | ------------------------ | ------------------------------- | ------------------------------ | --------------------- |
| 目录路径   | ❌ 未定义                | ✅ `DirectoryPath` 必选         | ✅ `SearchDirectory` 必选      | Roo schema 无路径参数 |
| 递归模式   | 系统提示提到但schema中❌ | 默认递归（含递归大小/数量信息） | N/A                            | 不一致                |
| glob 搜索  | ❌                       | ❌                              | ✅ `Pattern` 必选              | Roo 无文件名模式搜索  |
| 扩展名过滤 | ❌                       | ❌                              | ✅ `Extensions` 数组           | 无法按扩展名筛选      |
| 排除模式   | ❌                       | ❌                              | ✅ `Excludes` glob 数组        | 无法排除特定目录/文件 |
| 深度限制   | ❌                       | ❌                              | ✅ `MaxDepth` integer          | 无法限制搜索深度      |
| 类型筛选   | ❌                       | ❌                              | ✅ `Type` (file/directory/any) | 无法只搜索文件或目录  |
| 全路径匹配 | ❌                       | ❌                              | ✅ `FullPath` boolean          | -                     |
| 结果信息   | 仅文件路径               | 含相对路径+大小/项数            | 含类型+大小+修改时间+相对路径  | -                     |
| 结果上限   | 未知                     | 无限制                          | 50条                           | -                     |
| 底层引擎   | 未知                     | OS原生                          | `fd` (极快)                    | -                     |
| gitignore  | 未知                     | 未知                            | 默认忽略 gitignored 文件       | -                     |
| 智能大小写 | ❌                       | ❌                              | ✅ 默认 smart case             | -                     |

**关键缺漏**:

1. Roo 的 `list_files` 参数为空，系统提示中提到的 `recursive` 参数在 schema 中不存在（**系统提示与工具定义不一致**）
2. Roo **完全没有** 等价于 `find_by_name` 的高级文件搜索工具，无法按扩展名、glob 模式、深度限制搜索文件

---

### 2.4 代码编辑 — `apply_diff` + `write_to_file` vs `edit` + `multi_edit` + `write_to_file`

#### Roo `apply_diff` 定义

```json
{
	"name": "apply_diff",
	"description": "Apply code changes via diff",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**
- 描述仅说"通过 diff 应用代码变更"

#### Roo `write_to_file` 定义

```json
{
	"name": "write_to_file",
	"description": "Create or overwrite a file",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**

#### Cascade `edit` 定义

```json
{
	"name": "edit",
	"parameters": {
		"properties": {
			"file_path": {
				"description": "The path to the file to modify, absolute path",
				"type": "string"
			},
			"old_string": {
				"description": "The text to replace. MUST be unique in the file unless replace_all is true",
				"type": "string"
			},
			"new_string": {
				"description": "The text to replace it with (must be different from old_string)",
				"type": "string"
			},
			"replace_all": {
				"description": "Replace all occurrences of old_string (default false)",
				"type": "boolean"
			},
			"explanation": {
				"description": "A description of the change to be made",
				"type": "string"
			}
		},
		"required": ["explanation", "file_path", "old_string", "new_string"]
	}
}
```

#### Cascade `multi_edit` 定义

```json
{
	"name": "multi_edit",
	"parameters": {
		"properties": {
			"file_path": {
				"description": "The path to the file to modify, absolute path",
				"type": "string"
			},
			"edits": {
				"description": "Array of edit operations to perform sequentially on the file",
				"items": {
					"properties": {
						"old_string": { "type": "string" },
						"new_string": { "type": "string" },
						"replace_all": { "type": "boolean" }
					},
					"required": ["old_string", "new_string"]
				},
				"minItems": 1,
				"type": "array"
			},
			"explanation": {
				"description": "A description of the change to be made",
				"type": "string"
			}
		},
		"required": ["explanation", "file_path", "edits"]
	}
}
```

#### Cascade `write_to_file` 定义

```json
{
	"name": "write_to_file",
	"parameters": {
		"properties": {
			"TargetFile": {
				"description": "The target file to create and write code to.",
				"type": "string"
			},
			"CodeContent": {
				"description": "The code contents to write to the file.",
				"type": "string"
			},
			"EmptyFile": {
				"description": "Set this to true to create an empty file.",
				"type": "boolean"
			}
		},
		"required": ["TargetFile", "CodeContent", "EmptyFile"]
	}
}
```

#### 差异分析

| 参数/特性              | Roo                   | Cascade                                          | 差距说明                         |
| ---------------------- | --------------------- | ------------------------------------------------ | -------------------------------- |
| **精确替换编辑**       | ❌ 无此工具           | ✅ `edit` 工具: find-and-replace                 | Roo 没有精确的字符串替换编辑能力 |
| **多处编辑**           | ❌ 无此工具           | ✅ `multi_edit` 工具: 原子化多处编辑             | Roo 无法在一次操作中修改文件多处 |
| **diff 编辑**          | `apply_diff` 参数为空 | ❌ 无此工具                                      | 两者互补，但 Roo 的参数未定义    |
| **全局替换**           | ❌                    | ✅ `replace_all` 参数                            | Roo 无法一次替换文件中所有匹配   |
| **变更说明**           | ❌                    | ✅ `explanation` 参数                            | Roo 不记录变更说明               |
| **write_to_file 路径** | ❌ 未定义             | ✅ `TargetFile` 必选                             | -                                |
| **write_to_file 内容** | ❌ 未定义             | ✅ `CodeContent` 必选                            | -                                |
| **创建空文件**         | ❌                    | ✅ `EmptyFile` 参数                              | -                                |
| **仅创建不覆盖**       | ❌ 未知               | ✅ Cascade 的 write_to_file 仅创建新文件，不覆盖 | 安全性差异                       |
| **编辑前必须读取**     | ❌ 未知               | ✅ Cascade 要求先 read_file 再 edit              | 安全性保障                       |

**关键缺漏**:

1. Roo **没有** `edit` 和 `multi_edit` 工具，无法进行精确的 find-and-replace 编辑
2. Roo 的 `apply_diff` 和 `write_to_file` 参数均为空，schema 中无任何具体参数定义
3. Cascade 的 `write_to_file` 设计为**仅创建新文件**（不覆盖已有文件），更安全；Roo 的是"Create or overwrite"

---

### 2.5 命令执行 — 缺失 vs `run_command` + `command_status` + `read_terminal`

#### Roo 定义

**工具列表中不存在 `execute_command` 工具！**

但系统提示中大量提及：

- "You can use the execute_command tool to run commands on the user's computer"
- "Before using the execute_command tool, you must first think about the SYSTEM INFORMATION"
- "respect working directory specified by the response to execute_command"
- "Before executing commands, check the 'Actively Running Terminals' section"

**这是一个严重的系统提示与工具定义不一致的问题。**

#### Cascade `run_command` 定义

```json
{
	"name": "run_command",
	"parameters": {
		"properties": {
			"CommandLine": {
				"description": "The exact command line string to execute.",
				"type": "string"
			},
			"Cwd": {
				"description": "The current working directory for the command",
				"type": "string"
			},
			"Blocking": {
				"description": "If true, the command will block until it is entirely finished. During this time, the user will not be able to interact with Cascade. Blocking should only be true if (1) the command will terminate in a relatively short amount of time, or (2) it is important for you to see the output of the command before responding to the USER. Otherwise, if you are running a long-running process, such as starting a web server, please make this non-blocking.",
				"type": "boolean"
			},
			"SafeToAutoRun": {
				"description": "Set to true if you believe that this command is safe to run WITHOUT user approval. A command is unsafe if it may have some destructive side-effects. Example unsafe side-effects include: deleting files, mutating state, installing system dependencies, making external requests, etc.",
				"type": "boolean"
			},
			"WaitMsBeforeAsync": {
				"description": "Only applicable if Blocking is false. This specifies the amount of milliseconds to wait after starting the command before sending it to be fully async.",
				"type": "integer"
			}
		},
		"required": ["CommandLine"]
	}
}
```

#### Cascade `command_status` 定义

```json
{
	"name": "command_status",
	"parameters": {
		"properties": {
			"CommandId": {
				"description": "ID of the command to get status for",
				"type": "string"
			},
			"OutputCharacterCount": {
				"description": "Number of characters to view. Make this as small as possible to avoid excessive memory usage.",
				"type": "integer"
			},
			"WaitDurationSeconds": {
				"description": "Number of seconds to wait for command completion before getting the status. If the command completes before this duration, this tool call will return early. Do not wait for a command for more than 60 seconds.",
				"default": 0,
				"type": "integer"
			}
		},
		"required": ["CommandId", "OutputCharacterCount"]
	}
}
```

#### Cascade `read_terminal` 定义

```json
{
	"name": "read_terminal",
	"parameters": {
		"properties": {
			"ProcessID": {
				"description": "Process ID of the terminal to read.",
				"type": "string"
			},
			"Name": {
				"description": "Name of the terminal to read.",
				"type": "string"
			}
		},
		"required": ["ProcessID", "Name"]
	}
}
```

#### 差异分析

| 参数/特性                        | Roo                 | Cascade                      | 差距说明                                   |
| -------------------------------- | ------------------- | ---------------------------- | ------------------------------------------ |
| **命令执行工具**                 | ❌ 工具列表中不存在 | ✅ `run_command` 完整定义    | **严重缺漏**：系统提示提到但工具不存在     |
| `CommandLine` / 命令内容         | ❌                  | ✅ 必选, string              | -                                          |
| `Cwd` / 工作目录                 | ❌ (需 cd && 方式)  | ✅ 可选, string, 直接指定    | Roo 只能用 `cd path && command` 的笨拙方式 |
| `Blocking` / 阻塞控制            | ❌                  | ✅ 可选, boolean             | 无法控制命令是否阻塞等待                   |
| `SafeToAutoRun` / 安全自动执行   | ❌                  | ✅ 可选, boolean             | 无安全自动执行机制                         |
| `WaitMsBeforeAsync` / 异步前等待 | ❌                  | ✅ 可选, integer             | 无法在异步前短暂等待错误                   |
| **命令状态查询**                 | ❌ 无此工具         | ✅ `command_status` 完整定义 | 无法查询后台命令执行状态                   |
| `CommandId`                      | ❌                  | ✅ 必选                      | -                                          |
| `OutputCharacterCount`           | ❌                  | ✅ 必选, 控制输出字符数      | -                                          |
| `WaitDurationSeconds`            | ❌                  | ✅ 可选, 等待完成            | -                                          |
| **终端读取**                     | ❌ 无此工具         | ✅ `read_terminal` 完整定义  | 无法读取已有终端内容                       |
| `ProcessID`                      | ❌                  | ✅ 必选                      | -                                          |
| `Name`                           | ❌                  | ✅ 必选                      | -                                          |

**关键缺漏**:

1. **`execute_command` 工具在工具列表中完全缺失**，但系统提示多处引用它——这是最严重的不一致
2. 没有 `command_status` 无法查询后台命令状态
3. 没有 `read_terminal` 无法读取已有终端输出
4. 没有工作目录参数，必须用 `cd && command` 的方式

---

### 2.6 语义搜索 — `codebase_search_*` vs `code_search`

#### Roo `codebase_search_broad` 定义

```json
{
	"name": "codebase_search_broad",
	"strict": true,
	"parameters": {
		"properties": {
			"query": {
				"type": "array",
				"items": { "type": "string" },
				"description": "Array of meaning-based search queries from different angles. Always provide 2-4 diverse queries for comprehensive results."
			},
			"path": {
				"type": ["string", "null"],
				"description": "Optional path filter. Leave empty or omit for GLOBAL search (recommended)."
			}
		},
		"required": ["query"],
		"additionalProperties": false
	}
}
```

#### Roo `codebase_search_precise` 定义

```json
{
	"name": "codebase_search_precise",
	"strict": true,
	"parameters": {
		"properties": {
			"query": {
				"type": "array",
				"items": { "type": "string" },
				"description": "Array of meaning-based search queries from different angles. Always provide 2-4 diverse queries for comprehensive results."
			},
			"path": {
				"type": ["string", "null"],
				"description": "Optional path filter. Leave empty or omit for GLOBAL search (recommended)."
			}
		},
		"required": ["query"],
		"additionalProperties": false
	}
}
```

#### Cascade `code_search` 定义

```json
{
	"name": "code_search",
	"parameters": {
		"properties": {
			"search_term": {
				"description": "Search problem statement that this subagent is supposed to research for.",
				"type": "string"
			},
			"search_folder_absolute_uri": {
				"description": "The absolute path of the folder where the search should be performed.",
				"type": "string"
			}
		},
		"required": ["search_folder_absolute_uri", "search_term"]
	}
}
```

#### 差异分析

| 参数/特性       | Roo `codebase_search_*`                     | Cascade `code_search`                  | 差距说明                   |
| --------------- | ------------------------------------------- | -------------------------------------- | -------------------------- |
| **工具数量**    | 2 个 (broad + precise)                      | 1 个                                   | Roo 区分探索式和精确式搜索 |
| **查询格式**    | ✅ `query` 数组, 2-4个多角度查询            | `search_term` 单个字符串               | Roo 支持多查询更全面       |
| **路径参数**    | `path` 可选, string\|null, 可省略做全局搜索 | `search_folder_absolute_uri` **必选**  | Cascade 必须指定搜索目录   |
| **全局搜索**    | ✅ 省略 path 即可                           | ❌ 必须指定文件夹                      | Roo 更灵活                 |
| **strict 模式** | ✅ `"strict": true`                         | 无此属性                               | Roo 有严格参数校验         |
| **返回内容**    | 源代码 + 类名 + 继承信息 + 方法签名         | 相关文件和行号范围                     | Roo 返回信息更丰富         |
| **实现方式**    | 向量数据库 (RAG) 语义搜索                   | 子代理模式 (并行 grep + readfile 多轮) | 底层实现不同               |
| **并行限制**    | 可以并行调用                                | ❌ 不能并行调用                        | Cascade 限制更严格         |

**分析**: 这是 Roo **优于** Cascade 的少数领域之一。Roo 的语义搜索设计更精细：

- 区分 broad（探索）和 precise（精确定位）
- 支持多查询数组覆盖不同角度
- 支持全局搜索（不需要指定路径）
- 返回更丰富的元数据（继承信息、方法签名等）

---

### 2.7 交互/提问 — `ask_followup_question` vs `ask_user_question`

#### Roo 定义

```json
{
	"name": "ask_followup_question",
	"strict": true,
	"parameters": {
		"properties": {
			"question": {
				"type": "string",
				"description": "Clear, specific question that captures the missing information you need"
			},
			"follow_up": {
				"type": "array",
				"description": "Required list of 2-4 suggested responses; each suggestion must be a complete, actionable answer and may include a mode switch",
				"items": {
					"properties": {
						"text": { "type": "string", "description": "Suggested answer the user can pick" },
						"mode": { "type": ["string", "null"], "description": "Optional mode slug to switch to" }
					},
					"required": ["text", "mode"],
					"additionalProperties": false
				},
				"minItems": 1,
				"maxItems": 4
			}
		},
		"required": ["question", "follow_up"],
		"additionalProperties": false
	}
}
```

#### Cascade 定义

```json
{
	"name": "ask_user_question",
	"parameters": {
		"properties": {
			"question": {
				"description": "The question to ask the user",
				"type": "string"
			},
			"options": {
				"description": "Up to 4 options for the user to choose from",
				"items": {
					"properties": {
						"label": { "description": "Short label for the option", "type": "string" },
						"description": { "description": "Longer description explaining the option", "type": "string" }
					},
					"required": ["label", "description"]
				},
				"type": "array"
			},
			"allowMultiple": {
				"description": "Whether the user can select multiple options",
				"type": "boolean"
			}
		},
		"required": ["question", "options", "allowMultiple"]
	}
}
```

#### 差异分析

| 参数/特性    | Roo `ask_followup_question`                       | Cascade `ask_user_question`       | 差距说明                   |
| ------------ | ------------------------------------------------- | --------------------------------- | -------------------------- |
| 问题         | ✅ `question` 必选                                | ✅ `question` 必选                | 等同                       |
| 选项结构     | `follow_up`: [{text, mode}]                       | `options`: [{label, description}] | 不同设计                   |
| 选项数量限制 | 1-4 个 (`minItems:1, maxItems:4`)                 | 最多 4 个                         | 类似                       |
| 多选支持     | ❌                                                | ✅ `allowMultiple` boolean        | Cascade 支持多选           |
| 模式切换     | ✅ 每个选项可附带 `mode` (如 "code", "architect") | ❌                                | Roo 的模式切换集成到问答中 |
| 选项详情     | 仅 `text` 字段                                    | `label` + `description` 双字段    | Cascade 更详细             |
| strict 模式  | ✅ `"strict": true`                               | 无                                | -                          |
| 禁止 "other" | 无限制                                            | ✅ 明确禁止包含 "other" 选项      | -                          |

**分析**: 两者各有优势。Roo 的模式切换集成更优雅；Cascade 的多选和 label+description 双字段结构更灵活。

---

### 2.8 TODO 列表 — `update_todo_list` vs `todo_list`

#### Roo 定义

```json
{
	"name": "update_todo_list",
	"strict": true,
	"parameters": {
		"properties": {
			"todos": {
				"type": "string",
				"description": "Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress"
			}
		},
		"required": ["todos"],
		"additionalProperties": false
	}
}
```

格式示例: `"[x] Analyze requirements\n[-] Implement core logic\n[ ] Write tests"`

#### Cascade 定义

```json
{
	"name": "todo_list",
	"parameters": {
		"properties": {
			"todos": {
				"type": "array",
				"items": {
					"properties": {
						"id": { "description": "unique identifier for the todo item", "type": "string" },
						"content": { "description": "todo item content", "type": "string" },
						"status": {
							"description": "todo item status",
							"enum": ["pending", "in_progress", "completed"],
							"type": "string"
						},
						"priority": {
							"description": "todo item priority",
							"enum": ["high", "medium", "low"],
							"type": "string"
						}
					},
					"required": ["id", "content", "status", "priority"]
				}
			}
		},
		"required": ["todos"]
	}
}
```

#### 差异分析

| 参数/特性   | Roo `update_todo_list`                | Cascade `todo_list`                   | 差距说明                    |
| ----------- | ------------------------------------- | ------------------------------------- | --------------------------- |
| 数据格式    | Markdown checklist 字符串             | JSON 数组 (结构化)                    | Cascade 更结构化            |
| 唯一标识    | ❌ 无 ID                              | ✅ `id` 字段                          | Cascade 可精确定位单个 TODO |
| 优先级      | ❌ 无                                 | ✅ `priority`: high/medium/low        | Roo 无法标记任务优先级      |
| 状态表示    | `[ ]`, `[x]`, `[-]`                   | `pending`, `in_progress`, `completed` | 语义等同，表示不同          |
| strict 模式 | ✅ `"strict": true`                   | 无                                    | -                           |
| 嵌套/子任务 | ❌ 明确禁止("no nesting or subtasks") | ❌ 也不支持                           | 等同                        |

**Roo 缺漏**: 无 `id` 字段和 `priority` 优先级标记。

---

### 2.9 完成/汇报 — `attempt_completion` vs 无

#### Roo 定义

```json
{
	"name": "attempt_completion",
	"strict": true,
	"parameters": {
		"properties": {
			"result": {
				"type": "string",
				"description": "Final result message to deliver to the user once the task is complete"
			}
		},
		"required": ["result"],
		"additionalProperties": false
	}
}
```

#### Cascade

**无等价工具。** Cascade 通过直接在对话中回复来完成任务，不需要显式调用 "完成" 工具。

**差异**: Roo 有明确的任务完成信号机制（`attempt_completion`），Cascade 没有。这是 Roo 的设计优势——明确的任务边界。

---

### 2.10 浏览器操作 — `browser_action` vs `browser_preview`

#### Roo 定义

```json
{
	"name": "browser_action",
	"description": "Browser automation actions",
	"parameters": {
		"type": "object",
		"properties": {}
	}
}
```

- 参数: **完全为空**
- 描述: "Browser automation actions" — 暗示是浏览器自动化（如 Puppeteer/Playwright 操作）

#### Cascade 定义

```json
{
	"name": "browser_preview",
	"parameters": {
		"properties": {
			"Url": {
				"description": "The URL of the target web server to provide a browser preview for.",
				"type": "string"
			},
			"Name": {
				"description": "A short name 3-5 word name for the target web server.",
				"type": "string"
			}
		},
		"required": ["Url", "Name"]
	}
}
```

#### 差异分析

| 参数/特性  | Roo `browser_action` | Cascade `browser_preview`   | 差距说明       |
| ---------- | -------------------- | --------------------------- | -------------- |
| 参数       | ❌ `{}` 空           | ✅ `Url` + `Name`           | Roo 无参数定义 |
| 功能定位   | 浏览器自动化操作     | Web 服务器预览              | 不同功能       |
| 自动化能力 | 可能支持点击/输入等  | 仅预览页面 + 收集控制台日志 | Roo 理论上更强 |
| 参数完整性 | ❌ 无法确认实际参数  | ✅ 完整                     | -              |

**分析**: 两者功能定位不同。Roo 的是自动化操作（但参数为空），Cascade 的是服务器预览。

---

## 三、Cascade 独有工具详细列表（Roo 完全没有）

### 3.1 部署相关

| 工具                     | 参数                                                                                                          | 功能                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `deploy_web_app`         | `ProjectPath` (必选), `Framework` (可选, enum: nextjs/react/svelte等), `ProjectId` (可选), `Subdomain` (可选) | 部署 Web 应用到 Netlify 等平台 |
| `check_deploy_status`    | `WindsurfDeploymentId` (必选)                                                                                 | 检查部署状态                   |
| `read_deployment_config` | `ProjectPath` (必选)                                                                                          | 读取部署配置                   |

### 3.2 网络/URL

| 工具                 | 参数                                             | 功能                 |
| -------------------- | ------------------------------------------------ | -------------------- |
| `read_url_content`   | `Url` (必选, HTTP/HTTPS)                         | 读取网页内容         |
| `view_content_chunk` | `document_id` (必选), `position` (必选, integer) | 查看已读文档的特定块 |
| `search_web`         | `query` (必选), `domain` (可选)                  | 网络搜索             |

### 3.3 持久化记忆

| 工具            | 参数                                                                                                                                    | 功能                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `create_memory` | `Id`, `Title` (必选), `Content` (必选), `CorpusNames` (数组), `Tags` (数组), `Action` (create/update/delete), `UserTriggered` (boolean) | 持久化记忆数据库，跨会话保存上下文 |

### 3.4 Notebook 支持

| 工具            | 参数                                                                                                                                                | 功能                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `read_notebook` | `AbsolutePath` (必选)                                                                                                                               | 读取 Jupyter Notebook，显示单元格ID和输出 |
| `edit_notebook` | `absolute_path` (必选), `new_source` (必选), `cell_number` (0-indexed), `cell_type` (code/markdown), `edit_mode` (replace/insert), `cell_id` (可选) | 编辑 Notebook 单元格                      |

### 3.5 对话历史

| 工具                | 参数                                                     | 功能                         |
| ------------------- | -------------------------------------------------------- | ---------------------------- |
| `trajectory_search` | `ID` (必选), `Query` (必选), `SearchType` (cascade/user) | 搜索对话历史，最多返回50个块 |

### 3.6 MCP 资源

| 工具             | 参数                              | 功能                    |
| ---------------- | --------------------------------- | ----------------------- |
| `list_resources` | `ServerName` (必选)               | 列出 MCP 服务器可用资源 |
| `read_resource`  | `ServerName` (必选), `Uri` (必选) | 读取 MCP 资源内容       |

### 3.7 命令管理（已在 2.5 节详述）

| 工具             | 参数                                                       | 功能             |
| ---------------- | ---------------------------------------------------------- | ---------------- |
| `command_status` | `CommandId`, `OutputCharacterCount`, `WaitDurationSeconds` | 查询后台命令状态 |
| `read_terminal`  | `ProcessID`, `Name`                                        | 读取终端内容     |

---

## 四、Roo 独有工具/概念详细列表（Cascade 没有）

### 4.1 模式系统

| 工具/概念        | 说明                                                           |
| ---------------- | -------------------------------------------------------------- |
| `switch_mode`    | 切换 5 种模式: architect/code/ask/debug/orchestrator           |
| 模式限制         | 不同模式有不同的文件编辑权限（如 architect 只能编辑 .md 文件） |
| 模式在提问中切换 | `ask_followup_question` 的 `follow_up` 中每个选项可附带 `mode` |

### 4.2 任务系统

| 工具                 | 说明                             |
| -------------------- | -------------------------------- |
| `new_task`           | 创建子任务（参数为空）           |
| `attempt_completion` | 明确的任务完成信号，传递最终结果 |

### 4.3 技能系统

| 工具                    | 说明                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `skill`                 | 加载并执行预定义技能（参数为空），如 `create-mcp-server`、`create-mode` |
| `mandatory_skill_check` | 每次响应前必须检查是否有适用技能                                        |
| `linked_file_handling`  | 技能链接文件的渐进式加载策略                                            |

---

## 五、系统提示与工具定义不一致问题

| #   | 问题                             | 严重程度      | 详情                                                                                               |
| --- | -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `execute_command` 缺失           | 🔴 严重       | 系统提示多处提到 `execute_command` 工具，但工具列表中**不存在此工具**                              |
| 2   | `list_files` 的 `recursive` 参数 | 🟡 中等       | 系统提示说"If you pass 'true' for the recursive parameter"，但工具 schema 中 `properties: {}` 为空 |
| 3   | `read_file` 隐含参数             | 🟡 中等       | 系统提示提到可以 "read files"，但 schema 中无路径参数定义                                          |
| 4   | `write_to_file` 隐含参数         | 🟡 中等       | 系统提示提到可以 "write files"，但 schema 中无内容/路径参数                                        |
| 5   | `apply_diff` 隐含参数            | 🟡 中等       | 描述说"Apply code changes via diff"但无任何参数                                                    |
| 6   | 9 个工具参数为空                 | 🟠 整体性问题 | 14 个工具中 9 个参数为空，可能是工具定义被截断或简化                                               |

**说明**: 参数为空的工具很可能是因为工具定义在传递给模型时被简化/截断了（实际 Roo/Cline 框架可能有完整的参数定义）。但从 JSON 字面上看，模型收到的参数信息确实不完整。

---

## 六、总结对比矩阵

### 6.1 功能覆盖度对比

| 能力维度        | Roo                                 | Cascade                                              | 对比            |
| --------------- | ----------------------------------- | ---------------------------------------------------- | --------------- |
| 文件读取        | 基础（无渐进式）                    | 高级（渐进式+图片+行号）                             | Cascade >>> Roo |
| 文件搜索 (正则) | 参数为空                            | 6个参数（路径/查询/过滤/大小写/上下文/字面量）       | Cascade >>> Roo |
| 文件查找 (按名) | 无此工具                            | `find_by_name` 7个参数                               | Cascade 独有    |
| 语义搜索        | 2个工具，多查询，全局搜索           | 1个工具，单查询，必须指定目录                        | Roo > Cascade   |
| 代码编辑        | diff（参数空） + 全文覆写（参数空） | edit + multi_edit + write_to_file（完整参数）        | Cascade >>> Roo |
| 命令执行        | 工具缺失！                          | run_command 5个参数 + command_status + read_terminal | Cascade >>> Roo |
| 文件列表        | 参数为空                            | list_dir + find_by_name                              | Cascade >>> Roo |
| 用户交互        | 支持模式切换                        | 支持多选 + label/description                         | 各有优势        |
| TODO 管理       | Markdown字符串                      | 结构化JSON + ID + 优先级                             | Cascade > Roo   |
| 浏览器          | 自动化（参数空）                    | 预览                                                 | 功能不同        |
| 部署            | 无                                  | deploy + check_status + read_config                  | Cascade 独有    |
| 网络访问        | 无                                  | read_url + search_web + view_chunk                   | Cascade 独有    |
| 持久记忆        | 无                                  | create_memory                                        | Cascade 独有    |
| Notebook        | 无                                  | read_notebook + edit_notebook                        | Cascade 独有    |
| 对话历史搜索    | 无                                  | trajectory_search                                    | Cascade 独有    |
| MCP 资源        | 无                                  | list_resources + read_resource                       | Cascade 独有    |
| 任务完成信号    | attempt_completion                  | 无（直接回复）                                       | Roo 独有        |
| 模式系统        | 5种模式+权限控制                    | 无                                                   | Roo 独有        |
| 技能系统        | skill + 技能检查                    | 无                                                   | Roo 独有        |
| 子任务          | new_task                            | 无                                                   | Roo 独有        |

### 6.2 参数完整性对比

| 指标                 | Roo                                                   | Cascade    |
| -------------------- | ----------------------------------------------------- | ---------- |
| 总工具数             | 14                                                    | 28+        |
| 参数完整的工具数     | 5 (35.7%)                                             | 28+ (100%) |
| 参数为空的工具数     | 9 (64.3%)                                             | 0 (0%)     |
| 系统提示与工具不一致 | 至少2处（execute_command缺失, list_files的recursive） | 0          |

---

## 七、结论与建议

### 7.1 Roo 的核心问题

1. **64.3% 的工具参数为空** — 模型收到的参数信息严重不完整，可能导致工具调用失败或不确定性
2. **execute_command 工具缺失** — 系统提示与工具列表严重不一致
3. **无渐进式文件读取** — 处理大文件时效率低
4. **无精确编辑工具** — 只能全文覆写或用 diff，缺少 find-and-replace

### 7.2 Roo 的设计优势

1. **语义搜索更精细** — 区分 broad/precise，支持多查询数组
2. **模式系统** — 不同模式有不同权限和能力，更安全
3. **技能系统** — 可加载预定义技能指令
4. **任务完成信号** — `attempt_completion` 提供明确的任务边界

### 7.3 工具参数为空的可能原因

这些参数为空的工具（`apply_diff`, `browser_action`, `list_files`, `new_task`, `read_file`, `skill`, `search_files`, `switch_mode`, `write_to_file`）很可能是因为：

1. **工具参数被运行时注入** — Roo/Cline 框架可能在实际调用时动态添加参数
2. **OpenAI API 兼容性** — 使用 `"strict": false` 的工具可能不需要完整 schema
3. **工具定义被截断/简化** — 导出的 JSON 可能不是完整版本
4. **模型依赖系统提示推断参数** — 模型从描述文本中推断需要传什么参数

但无论原因如何，从模型收到的 schema 来看，这些工具的参数信息确实是不完整的。
