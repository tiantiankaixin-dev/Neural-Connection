# 上下文管理架构重构 — 代码级实现计划

## 目标

将上下文管理从「全量传递 + 延迟压缩」改为「选择式保留 + 动态背包装填」。

---

## 架构总览

```
attemptApiRequest 执行流程:

1. [选择阶段] needsContextCompression? → 扫描 output.json → AI 选择 → 保存 context_refs.json
2. [装填阶段] context_refs.json 存在? → 加载独立块 → 计算 token → 背包装填 → 注入历史
3. [兜底压缩] compressInTaskContext() → token > 75% 则压缩旧消息
4. [任务隔离] buildEffectiveHistory() → 剥离已完成小任务的消息
5. 发送给 API
```

---

## 文件改动清单

### 1. `src/core/condense/context-selector.ts` — 核心重构

#### 1.1 新增接口 `ContextBlock`

```typescript
// 位置: Types 区域（约 line 45）
export interface ContextBlock {
	/** context_refs.json 中的引用信息 */
	ref: ContextRef
	/** 该块的完整 ApiMessage 对（user + assistant） */
	messages: ApiMessage[]
	/** 该块的 token 数 */
	tokenCount: number
}
```

#### 1.2 重构 `loadContextAsMessages` → `loadContextBlocks`

**当前实现** (`loadContextAsMessages`, line 426-521):

- 加载所有选中 turn，合并成一个 user+assistant 消息对
- 不计算 token，不做装填

**新实现** (`loadContextBlocks`):

```typescript
/**
 * 加载 context_refs.json 中的每个选中 turn 为独立的 ContextBlock。
 * 每个块包含自己的 ApiMessage 对和 token 计数。
 * 不做装填 — 装填由 fitContextBlocks 负责。
 */
export async function loadContextBlocks(task: Task): Promise<ContextBlock[]> {
	// 1. 读取 context_refs.json
	// 2. 遍历 selectedTurns
	// 3. 每个 turn → 读取 output.json → 构建独立的 user+assistant 消息对
	// 4. 计算每个消息对的 token 数 (countMessageTokens)
	// 5. 返回 ContextBlock[]
}
```

对每个 turn，生成的消息对格式：

```typescript
const userMsg: ApiMessage = {
	role: "user",
	content: [
		{ type: "text", text: `<previous_context turn="${ref.turnNumber}">\n${turnContent}\n</previous_context>` },
	],
	ts: Date.now(),
	isSummary: true,
	isContextBlock: true, // 新字段，标记为上下文块
}
const assistantMsg: ApiMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Noted." }],
	ts: Date.now(),
	isContextBlock: true,
}
```

#### 1.3 新增 `fitContextBlocks` — 背包装填

```typescript
/**
 * 从 ContextBlock[] 中选择能装入预算的块。
 *
 * 算法: 贪心 — 按 turnNumber 顺序（保持时间顺序），逐个尝试装入。
 * 如果装不下，跳过（不删除，保留在 context_refs.json 中）。
 *
 * @param blocks - 所有可用的上下文块
 * @param budgetTokens - 可用的 token 预算
 * @returns { included: ContextBlock[], excluded: ContextBlock[] }
 */
export function fitContextBlocks(
	blocks: ContextBlock[],
	budgetTokens: number,
): { included: ContextBlock[]; excluded: ContextBlock[] } {
	const included: ContextBlock[] = []
	const excluded: ContextBlock[] = []
	let remaining = budgetTokens

	for (const block of blocks) {
		if (block.tokenCount <= remaining) {
			included.push(block)
			remaining -= block.tokenCount
		} else {
			excluded.push(block)
		}
	}

	return { included, excluded }
}
```

#### 1.4 新增 `executeTransitionSelection` — 第一阶段入口

```typescript
/**
 * 跨任务过渡时的选择阶段。
 * 在 attemptApiRequest 中检测到 needsContextCompression=true 时调用。
 *
 * 与 applyContextSelection 的区别:
 * - 不需要新 todo list（此时 AI 还没创建新任务列表）
 * - 基于通用相关性选择
 * - 只做选择 + 保存 refs + 替换旧历史
 *
 * 流程:
 * 1. 扫描 output.json 文件
 * 2. 构建摘要 → 发给选择模型（通用相关性 prompt）
 * 3. 保存 context_refs.json
 * 4. 加载选中块 → fitContextBlocks → 注入历史
 * 5. 替换 apiConversationHistory = [装入的块] + [当前用户消息]
 */
export async function executeTransitionSelection(task: Task): Promise<void> {
	// 1. scanTurnFiles (已有)
	// 2. packSummariesIntoBatches (已有)
	// 3. callSelectionModel (已有, 但用通用 prompt，不传 todo list)
	// 4. 保存 context_refs.json (已有)
	// 5. loadContextBlocks (新)
	// 6. 计算预算: contextWindow * 0.75 - currentMessageTokens
	// 7. fitContextBlocks (新)
	// 8. 构建新历史: [...includedBlocks.messages, ...currentMessages]
	// 9. overwriteApiConversationHistory
}
```

#### 1.5 新增 `injectContextBlocks` — 第二阶段入口

```typescript
/**
 * 每次 API 调用时，动态装填上下文块。
 * 在 attemptApiRequest 中 buildEffectiveHistory 之前调用。
 *
 * 流程:
 * 1. 检查 context_refs.json 是否存在
 * 2. loadContextBlocks
 * 3. 计算可用预算
 * 4. fitContextBlocks
 * 5. 确保 apiConversationHistory 开头是装入的块
 *    - 移除旧的上下文块（isContextBlock=true 的消息）
 *    - 插入新装入的块
 */
export async function injectContextBlocks(task: Task): Promise<void> {
	if (!task.contextRefsPath) return

	const blocks = await loadContextBlocks(task)
	if (blocks.length === 0) return

	// 计算当前对话（非上下文块）的 token 数
	const currentMessages = task.apiConversationHistory.filter((m) => !m.isContextBlock)
	let currentTokens = 0
	for (const msg of currentMessages) {
		currentTokens += await countMessageTokens(msg)
	}

	const modelInfo = task.api.getModel().info
	const contextWindow = modelInfo?.contextWindow || DEFAULT_CONTEXT_WINDOW
	const budget = Math.floor(contextWindow * 0.75) - currentTokens

	if (budget <= 0) {
		// 预算不足，移除所有上下文块
		task.apiConversationHistory = task.apiConversationHistory.filter((m) => !m.isContextBlock)
		return
	}

	const { included } = fitContextBlocks(blocks, budget)

	// 移除旧的上下文块，插入新的
	const nonBlockMessages = task.apiConversationHistory.filter((m) => !m.isContextBlock)
	const blockMessages = included.flatMap((b) => b.messages)
	task.apiConversationHistory = [...blockMessages, ...nonBlockMessages]
}
```

#### 1.6 保留 `compressInTaskContext` — 安全兜底（不改动）

已实现，保持不变。当 effective history tokens > 75% 时压缩旧消息。

#### 1.7 修改 `applyContextSelection` — 可选的精细化

当前 `applyContextSelection` 在 `UpdateTodoListTool` 中调用，基于新 todo list 做选择。
改为：**如果 context_refs.json 已存在，可以用新 todo list 做二次筛选**（可选优化，不在 v1 实现）。

v1 中：`applyContextSelection` 保持现有逻辑，但不再替换历史，只更新 context_refs.json。

---

### 2. `src/core/task-persistence/apiMessages.ts` — 新增字段

```typescript
// ApiMessage 接口中添加:
isContextBlock?: boolean  // 标记为动态上下文块，可被 injectContextBlocks 替换
```

**检查**: 需要确认 ApiMessage 接口定义位置，添加可选字段。

---

### 3. `src/core/task/Task.ts` — 修改 `attemptApiRequest`

#### 当前代码 (line 4175-4189):

```typescript
// In-task context compression
try {
    const compressed = await compressInTaskContext(this)
    ...
} catch ...

const effectiveHistory = this.buildEffectiveHistory()
```

#### 改为:

```typescript
// Phase 1: 跨任务过渡选择（一次性）
if (this.needsContextCompression) {
	try {
		await executeTransitionSelection(this)
		this.needsContextCompression = false
		console.log("[attemptApiRequest] Transition selection completed")
	} catch (err) {
		console.warn("[attemptApiRequest] Transition selection failed:", err)
		this.needsContextCompression = false
	}
}

// Phase 2: 动态上下文块装填（每次 API 调用）
try {
	await injectContextBlocks(this)
} catch (err) {
	console.warn("[attemptApiRequest] Context block injection failed:", err)
}

// Phase 3: 安全兜底 — token 溢出压缩
try {
	const compressed = await compressInTaskContext(this)
	if (compressed) {
		console.log("[attemptApiRequest] In-task context compression applied")
	}
} catch (err) {
	console.warn("[attemptApiRequest] In-task compression failed:", err)
}

// Phase 4: 任务隔离
const effectiveHistory = this.buildEffectiveHistory()
```

#### 导入修改:

```typescript
// 当前:
import { compressInTaskContext } from "../condense/context-selector"
// 改为:
import { compressInTaskContext, executeTransitionSelection, injectContextBlocks } from "../condense/context-selector"
```

---

### 4. `src/core/tools/UpdateTodoListTool.ts` — 简化

#### 当前 (line 89-101):

```typescript
const shouldCompress = hadPreviousTodoList || task.needsContextCompression
let contextSelectionResult = ...
if (shouldCompress) {
    task.needsContextCompression = false
    contextSelectionResult = await applyContextSelection(task, normalizedTodos)
}
```

#### 改为:

```typescript
// 跨任务选择已在 attemptApiRequest 中提前完成
// 这里只需要检查是否有 context_refs.json，获取 UI 展示数据
let contextSelectionResult: ContextSelectionResult | undefined
if (task.contextRefsPath) {
	try {
		contextSelectionResult = await loadContextSelectionForUI(task)
	} catch (err) {
		console.warn("[UpdateTodoList] Failed to load context refs for UI:", err)
	}
}
```

新增 `loadContextSelectionForUI` 函数：读取 context_refs.json + loadDetailedTurns，构建 ContextSelectionResult 用于 UI 显示。

---

### 5. 不需要改动的文件

| 文件                        | 原因                                            |
| --------------------------- | ----------------------------------------------- |
| `ChatRow.tsx`               | UI 组件不需要改动，已支持展开显示               |
| `AttemptCompletionTool.ts`  | 只设 `needsContextCompression = true`，不需要改 |
| `buildEffectiveHistory`     | 小任务隔离逻辑不变                              |
| `todo-context-generator.ts` | 已被 context-selector 替代，不需要改            |

---

## 执行顺序

1. **在 `apiMessages.ts` 中添加 `isContextBlock` 字段**
2. **重构 `context-selector.ts`**:
    - 添加 `ContextBlock` 接口
    - 实现 `loadContextBlocks`
    - 实现 `fitContextBlocks`
    - 实现 `executeTransitionSelection`
    - 实现 `injectContextBlocks`
    - 添加 `loadContextSelectionForUI`
3. **修改 `Task.ts` 的 `attemptApiRequest`**:
    - 添加 Phase 1 (transition selection)
    - 添加 Phase 2 (dynamic injection)
    - 更新 import
4. **简化 `UpdateTodoListTool.ts`**:
    - 移除 `applyContextSelection` 调用
    - 改为读取已有 context_refs 的 UI 数据
5. **验证 TypeScript 编译通过**

---

## 背包装填示例

```
上下文窗口: 128,000 tokens
预算 (75%): 96,000 tokens
当前对话: 30,000 tokens
可用预算: 96,000 - 30,000 = 66,000 tokens

context_refs.json 中的块:
  Block 1: Turn 3  [架构设计]     → 15,000 tokens
  Block 2: Turn 7  [核心修改]     → 25,000 tokens
  Block 3: Turn 12 [配置调整]     → 30,000 tokens
  Block 4: Turn 18 [测试修复]     → 8,000 tokens

装填结果 (贪心, 按顺序):
  ✅ Block 1: 15,000 → 剩余 51,000
  ✅ Block 2: 25,000 → 剩余 26,000
  ❌ Block 3: 30,000 > 26,000 → 跳过
  ✅ Block 4: 8,000  → 剩余 18,000

装入: Block 1 + Block 2 + Block 4 = 48,000 tokens
排除: Block 3 (保留在 context_refs.json)

--- 10 次 API 调用后 ---

当前对话增长到 60,000 tokens
可用预算: 96,000 - 60,000 = 36,000

重新装填:
  ✅ Block 1: 15,000 → 剩余 21,000
  ❌ Block 2: 25,000 > 21,000 → 跳过
  ❌ Block 3: 30,000 > 21,000 → 跳过
  ✅ Block 4: 8,000  → 剩余 13,000

装入: Block 1 + Block 4 = 23,000 tokens
排除: Block 2, Block 3

--- compressInTaskContext 触发后 ---

当前对话被压缩到 20,000 tokens
可用预算: 96,000 - 20,000 = 76,000

重新装填:
  ✅ Block 1: 15,000 → 剩余 61,000
  ✅ Block 2: 25,000 → 剩余 36,000
  ✅ Block 3: 30,000 → 剩余 6,000
  ❌ Block 4: 8,000 > 6,000 → 跳过

装入: Block 1 + Block 2 + Block 3 = 70,000 tokens
排除: Block 4
```
