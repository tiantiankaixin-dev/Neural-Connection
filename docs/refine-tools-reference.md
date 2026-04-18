# Refine 工具完整参考文档

> Neural-Connection refine（任务细化）流程的工具定义、参数结构与工作流。

---

## 1. Refine 工作流概览

定义在 `src/core/task/Task.ts` → `buildRefineSystemPrompt()`，共 4 阶段：

- **Phase 1 — Initial Understanding**：只读探索代码库、理解需求、向用户提问
- **Phase 2 — Rewrite Todo List (STEP 1)**：`update_todo_list` 重写为按架构层分组的粗粒度任务
- **Phase 3 — Write Plans (STEP 2)**：对每个 todo 调用 `write_todo_plan` 写入详细计划
- **Phase 4 — Transition to Build**：自动切换 build 模式，开始实现

Phase 1-3 严禁文件修改。仅 `update_todo_list` 和 `write_todo_plan` 可"写入"（写的是内部计划数据）。

---

## 2. 工具 1: `update_todo_list`

**源文件**: `src/core/prompts/tools/native-tools/update_todo_list.ts`

替换整个 TODO 列表。两种模式（工具名相同，description 不同）：

- **Normal 模式**（build 阶段）— 细粒度文件级追踪
- **Refine 模式**（plan 阶段）— 按架构层粗粒度分组

### 2.1 参数树

```
update_todo_list
└── todos: string (必填)
```

### 2.2 `todos` 参数

**类型**: `string` · **必填**: 是

完整的 markdown 任务清单字符串。每次调用**完整替换**旧列表。

格式：

- `[ ]` = 待做
- `[x]` = 已完成
- `[-]` = 进行中

**Normal 模式**：细粒度，每个 todo 列出拥有的文件路径，同一文件不得出现在多个未完成 todo 中。

**Refine 模式下**：

- 必须按**架构层**分组（Backend / Frontend / Shared 等）
- 同一层的所有文件合为一个 todo
- 目标是**最少数量**的粗粒度任务
- 禁止按单文件或单功能拆分
- **禁止**把“接口定义/类型约定/共享契约”作为独立的 todo 项——这些属于 `write_todo_plan` 的 `context` 字段。

### 2.3 Refine 模式调用示例

```json
{
	"todos": "[-] Backend: server.js, routes/api.js, models/user.js, middleware/auth.js, package.json\n[ ] Frontend: public/index.html, public/login.html, public/css/style.css, public/js/app.js"
}
```

### 2.4 完整 JSON 定义

Refine 模式的完整 tool JSON：

```json
{
	"type": "function",
	"function": {
		"name": "update_todo_list",
		"strict": true,
		"description": "（见源文件，REFINE_DESCRIPTION 变量，内容过长此处省略）",
		"parameters": {
			"type": "object",
			"properties": {
				"todos": {
					"type": "string",
					"description": "Full markdown checklist in execution order ... In refine / planning flows, rewrite it into architecture-based execution units: group ALL files of the same architectural layer into ONE todo item, producing the MINIMUM number of coarse-grained tasks. ..."
				}
			},
			"required": ["todos"],
			"additionalProperties": false
		}
	}
}
```

> Normal 模式结构完全相同，只是 `description` 和 `todos.description` 换成了 NORMAL_DESCRIPTION / NORMAL_TODOS_PARAM。

---

## 3. 工具 2: `write_todo_plan`

**源文件**: `src/core/prompts/tools/native-tools/write_todo_plan.ts`

为某个 todo 项写入详细实现计划。在 `update_todo_list` 重写列表后，对**每个** todo 项调用一次或多次。

**多次调用累积**：同一个 `todo_item_id` 可以调用多次，每次的 `context` 和 `plans` 会**追加**而不是覆盖。用于分离不同的接口约定给不同的文件组。

计划存为内部 markdown 文件，build 阶段自动注入给构建 agent。

### 3.1 参数树

```
write_todo_plan
├── todo_item_id : string              (必填)
├── context      : string              (必填)
├── plan_type    : "file" | "general"  (必填)
└── plans        : array               (必填)
    └── [每个条目]
        ├── target : string                                          (必填)
        ├── action : "CREATE" | "MODIFY" | "DELETE" | "GENERAL"      (必填)
        └── body   : string                                          (必填)
```

### 3.2 完整 JSON 定义

```json
{
	"type": "function",
	"function": {
		"name": "write_todo_plan",
		"strict": true,
		"description": "（见源文件 WRITE_TODO_PLAN_DESCRIPTION，内容过长此处省略）",
		"parameters": {
			"type": "object",
			"properties": {
				"todo_item_id": {
					"type": "string",
					"description": "The ID of the todo item to write plans for"
				},
				"context": {
					"type": "string",
					"description": "Markdown string containing the cross-cutting context for this todo item: interface contracts & shared type definitions (verbatim code), cross-task dependencies, background exploration findings, and conventions/constraints. This is injected as the first thing the build agent sees."
				},
				"plan_type": {
					"type": "string",
					"enum": ["file", "general"],
					"description": "\"file\" for plans that modify/create real project files. \"general\" for non-code plans."
				},
				"plans": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"target": {
								"type": "string",
								"description": "Relative file path (file plans) or descriptive section title (general plans)"
							},
							"action": {
								"type": "string",
								"enum": ["CREATE", "MODIFY", "DELETE", "GENERAL"],
								"description": "Action for this target. GENERAL only valid for general plans."
							},
							"body": {
								"type": "string",
								"description": "Markdown plan body only. Do not include PLAN_TARGET header markup."
							}
						},
						"required": ["target", "action", "body"],
						"additionalProperties": false
					}
				}
			},
			"required": ["todo_item_id", "context", "plan_type", "plans"],
			"additionalProperties": false
		}
	}
}
```

>

### 3.3 各参数详解

#### 参数 `todo_item_id`

- **类型**: `string`
- **必填**: 是
- **含义**: 目标 todo 项的唯一 ID。来自 `update_todo_list` 返回的结果。

---

#### 参数 `context`

- **类型**: `string`（markdown 格式）
- **必填**: 是
- **含义**: 父 agent 为当前 todo 准备的**跨任务上下文**。

每次调用的 context 应该明确标注它 **定义** 或 **引用** 了哪些接口约定。

必须包含的内容：

1. **接口契约与共享类型定义**
   逐字写出 TypeScript 接口/类型代码。
   若任务 A 和任务 B 共享同一接口，两个任务的 context 都必须包含完全相同的定义。

2. **跨任务依赖描述**
   当前任务依赖哪些其他任务的产出；需要为哪些其他任务提供什么。

3. **Phase 1 探索发现**
   文件路径、行号、已有代码片段、代码模式与约定。

4. **约定与约束**
   命名规范、框架选择、库版本要求等。

在系统中的作用：

- UI 显示为独立可展开的 **“Task Context”** 区块（紫色图标）—— 多次调用产生多个可展开块，带序号标签
- 作为 build agent 看到的**最先消息**注入（所有 contexts 按顺序注入，然后是 plans）
- 是 build agent 理解“这个任务如何融入全局”的**唯一信息来源**

---

#### 参数 `plan_type`

- **类型**: `string` 枚举
- **必填**: 是
- **可选值**:
    - `"file"` — 涉及修改/创建真实项目文件。每个 plan entry 的 target 必须是真实相对文件路径。
    - `"general"` — 非代码计划（评审、调试策略、架构分析、调研等）。每个 plan entry 的 target 是描述性标题。

> 如果任务本质是调研/评审/分析，即使最终可能导致文件修改，也用 `"general"`。
> 只有当前 todo **直接**要求改文件时才用 `"file"`。

---

#### 参数 `plans`

- **类型**: `array`
- **必填**: 是
- **含义**: 结构化计划条目数组，每个条目描述一个目标文件或计划章节。

##### 子字段 `plans[].target`

- **类型**: `string` · **必填**: 是
- `plan_type = "file"` → 相对文件路径（如 `src/core/Player.ts`）
- `plan_type = "general"` → 描述性标题（如 `"Architecture Overview"`）

##### 子字段 `plans[].action`

- **类型**: `string` 枚举 · **必填**: 是

| 值        | 含义         | 允许的 plan_type |
| --------- | ------------ | ---------------- |
| `CREATE`  | 新建文件     | `file`           |
| `MODIFY`  | 修改已有文件 | `file`           |
| `DELETE`  | 删除文件     | `file`           |
| `GENERAL` | 通用章节     | `general`        |

##### 子字段 `plans[].body`

- **类型**: `string`（markdown）· **必填**: 是
- 不要手写 `<<<PLAN_TARGET>>>` 头部标记，系统自动生成。

**`plan_type = "file"` 时 body 必须包含**:

- 目标文件的**完整蓝图**（相当于用规划形式把文件写一遍）
- `referenced_by_files`: 哪些文件引用/导入本文件
- `references_files`: 本文件导入/依赖哪些文件
- 所有函数/方法枚举（未修改+修改+新增），每个标注：
    - `name/signature`（函数签名）
    - `referenced_by`（被谁调用）
    - `references`（调用了谁）
    - `responsibility`（具体职责）
- 禁止模糊占位符如"其他 helper"或"现有方法保持不变"

**`plan_type = "general"` 时**: 自由格式，描述分析方法、调试假设、评审清单等。

---

### 3.4 调用示例

**多次调用模式**（推荐当一个 todo 有不同接口契约的文件时）:

````
Call 1: 定义 UserAPI 契约，关联用户相关文件
  todo_item_id: "be1"
  context:      "## Contract: UserAPI\n```ts\ninterface UserAPI { id: string; name: string }\n```"
  plans:        [src/models/user.ts, src/routes/users.ts]

Call 2: 定义 AuthAPI 契约，关联认证相关文件
  todo_item_id: "be1"
  context:      "## Contract: AuthAPI\n```ts\ninterface AuthToken { token: string; expiresAt: number }\n```"
  plans:        [src/middleware/auth.ts, src/routes/auth.ts]

Call 3: 引用两个契约，关联桥接文件
  todo_item_id: "be1"
  context:      "## References: UserAPI, AuthAPI\nserver.ts mounts both."
  plans:        [src/server.ts]
````

**单次调用模式**（所有文件共享同一 context）:

````json
{
	"todo_item_id": "abc123",
	"context": "## Shared Types\n```ts\ninterface Config { port: number }\n```",
	"plan_type": "file",
	"plans": [
		{ "target": "src/config.ts", "action": "CREATE", "body": "..." },
		{ "target": "src/server.ts", "action": "MODIFY", "body": "..." }
	]
}
````

---

## 4. Refine 系统提示词

**源文件**: `src/core/task/Task.ts` → `buildRefineSystemPrompt()`

### Phase 1: Initial Understanding

- 只读探索代码库
- `ask_followup_question` 澄清歧义
- 严禁文件修改

### Phase 2: Rewrite Todo List (STEP 1)

用 `update_todo_list` 按架构层分组：

- 正确：全栈 Web → Backend + Frontend（2 个任务）
- 正确：Monorepo 3 包 → 3 个任务
- 错误：一个文件一个任务
- 错误：同一层内按功能拆分
- 错误：按步骤拆分

### Phase 3: Write Plans (STEP 2)

对每个 todo 调用 `write_todo_plan`。

上下文隔离规则：

- 每个 todo 的 plan 是 build agent 的**唯一初始上下文**
- build agent 看不到 Phase 1 探索、对话历史、其他 todo 的 plan
- 因此每个 plan 必须**完全自包含**

注入顺序：

1. 所有 `contexts`（按调用顺序）→ build agent 最先看到
2. 所有 `plans` → 紧随其后

### Phase 4: Transition to Build

最后一个 `write_todo_plan` 结果包含 `[BUILD MODE ACTIVE]` 标记，agent 按计划实现第一个 pending todo。

---

## 5. 数据流

### 5.1 写入（refine Phase 3）

```
Parent Agent
  │ write_todo_plan({ todo_item_id, context, plan_type, plans })
  ▼
WriteTodoPlanTool.execute()
  ├─ savePlanFiles()
  │    存储到 task_optimize/ 目录
  │    context → <!-- BEGIN_TASK_CONTEXT --> ... <!-- END_TASK_CONTEXT -->
  │
  └─ task.say("refine_result", JSON.stringify({
       todoItemId, todoContent, planType,
       context,
       plans: [{ filePath, content, target, action, body }]
     }))
```

### 5.2 读取注入（build 阶段）

```
buildEffectiveHistory()
  ├─ readPlanFiles() → { plans, contexts: string[] }
  ├─ 逐个注入 [TASK CONTEXT (1/N)] ... [TASK CONTEXT (N/N)]
  └─ 注入 [IMPLEMENTATION PLAN]（所有 plans 合并）
```

### 5.3 UI 渲染

```
ChatView.tsx 解析多个 "refine_result" → 累积到 todoPlansById
  ▼
RefinedTodoCard
  ├── 📐 Task Context (1)（可展开）  ← contexts[0] (UserAPI)
  ├── 📐 Task Context (2)（可展开）  ← contexts[1] (AuthAPI)
  ├── 📄 src/models/user.ts          ← plans[0]
  ├── 📄 src/routes/users.ts         ← plans[1]
  ├── 📄 src/middleware/auth.ts       ← plans[2]
  └── 📄 src/server.ts               ← plans[3]
```

### 5.4 持久化

路径: `tasks/<taskId>/task_optimize/<taskTimestamp>/<safeName>.md`

```markdown
<!-- todoItemId: abc123 -->
<!-- planType: file -->

# Todo item content

<!-- BEGIN_TASK_CONTEXT -->

（context 内容）

<!-- END_TASK_CONTEXT -->

## src/server.ts

## （plans[0] content）

## src/routes/api.ts

## （plans[1] content）
```

读取接口:

```typescript
interface PlanReadResult {
	plans: PlanFile[] // { filePath, content }[]
	contexts: string[] // 从所有文件的 <!-- BEGIN_TASK_CONTEXT --> 段收集
}
```

---

## 6. 已知问题

### 6.1 接口约定被拆成单独任务

AI 在 Phase 2 把“接口定义”拆成独立 todo，而不是写进 `context` 字段。

**已修复**：

- `update_todo_list` refine 模式现在明确禁止“接口定义/类型约定/共享契约”作为独立 todo 项
- `write_todo_plan` 支持多次调用累积，不同接口约定分开写入不同的 context
- `buildRefineSystemPrompt` Phase 3 指示用多次调用模式分离接口

### 6.2 `context` vs `plans[].body` 职责

| 维度       | `context`                                     | `plans[].body`                 |
| ---------- | --------------------------------------------- | ------------------------------ |
| 粒度       | 每次调用级别（一个 todo 可有多个 context）    | 单个文件/章节                  |
| 内容       | 接口契约、共享类型、跨任务依赖、全局约定      | 单文件的完整实现蓝图           |
| 注入顺序   | 最先（所有 contexts 按顺序）                  | 第二                           |
| UI         | 多个带序号的 “Task Context (N)” 可展开块      | 各文件的可展开块               |
| 跨任务重复 | 是（共享接口在每个相关任务的 context 中重复） | 否（每个 body 只描述一个文件） |
