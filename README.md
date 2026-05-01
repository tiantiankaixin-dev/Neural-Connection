# Neural-Connection

> 基于 Roo Code 的 AI 编程代理增强分支，聚焦任务细化、多代理并行执行、代码图谱检索与长上下文管理。

<p align="center">
  <a href="https://github.com/tiantiankaixin-dev/Neural-Connection"><img src="https://img.shields.io/badge/GitHub-Neural--Connection-181717?style=flat&logo=github" alt="GitHub"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-20.19.2-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-10.8.1-F69220?style=flat&logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.84.0-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code">
</p>

## 项目定位

Neural-Connection 是一个面向 VS Code 的 AI 编程代理扩展分支。它继承 Roo Code 的编辑器内 AI 开发体验，并在复杂任务执行方向加入更多实验性能力：

- **任务先规划再执行**：通过 Refine 流程把模糊需求拆成架构层级任务、文件级计划和跨任务约定。
- **多代理并行实现**：将独立任务交给隔离上下文的子代理执行，降低大型改动中的上下文污染。
- **代码图谱增强检索**：结合语义检索、稀疏检索、调用/引用关系、类层级与 PageRank 改善代码定位。
- **长上下文可观测**：提供上下文检查、摘要检查、任务历史与调试面板，便于观察 AI 实际看到的内容。
- **本地模型探索**：提供 Neural Agent 入口，用于管理本地 AI 开关与 Ollama 连接状态。

本仓库适合用于研究和改造 AI Coding Agent 的任务规划、执行隔离、上下文压缩、检索增强和 VS Code 插件工程化。

## 目录

- [核心能力](#核心能力)
- [工作流概览](#工作流概览)
- [快速开始](#快速开始)
- [常用脚本](#常用脚本)
- [项目结构](#项目结构)
- [配置与能力入口](#配置与能力入口)
- [文档](#文档)
- [贡献](#贡献)
- [安全与免责声明](#安全与免责声明)
- [许可与归属](#许可与归属)

## 核心能力

### AI 开发团队

继承 Roo Code 的核心能力，让 AI 代理直接在编辑器中完成开发任务：

- **代码生成与修改**：根据自然语言需求创建、编辑、重构代码。
- **代码解释与修复**：通过编辑器菜单解释选中代码、修复问题或改进实现。
- **终端协作**：分析终端输出、解释命令、辅助修复命令错误。
- **多模式工作流**：支持 Code、Architect、Ask、Debug 和自定义模式。
- **MCP 扩展能力**：可接入 Model Context Protocol 服务扩展工具能力。
- **自动批准策略**：可配置允许/拒绝命令和执行超时，平衡效率与安全。

### Refine 任务细化

Neural-Connection 强化了复杂任务的规划阶段：

- **架构层拆分**：将需求拆成 Backend、Frontend、Shared 等粗粒度任务，而不是零散文件任务。
- **文件级计划**：为每个目标文件记录完整实现蓝图、依赖关系、调用关系和修改策略。
- **跨任务约定**：把 API、类型、存储、环境变量、错误响应等共享契约写入任务上下文。
- **计划持久化**：Refine 结果会保存到任务目录，后续构建阶段可自动注入。
- **顺序规划约束**：每个 todo 的计划生成后再进入下一个，确保后续任务能看到最新约定。

参考：[Refine 工具完整参考文档](./docs/refine-tools-reference.md)

### 多代理并行执行

Refine 完成后，系统可以把已规划任务交给子代理执行：

- **独立子任务上下文**：每个子代理只接收自己的任务包、计划和约定。
- **隔离执行历史**：避免父任务和兄弟任务上下文互相污染。
- **执行状态持久化**：支持中断后的子代理恢复检查。
- **面向实现的系统提示**：子代理专注执行已规划任务，而不是重新规划 todo。

### 代码库索引与图谱扩展

项目内置代码库索引能力，用于提升大项目检索效果：

- **语义检索**：基于向量搜索定位与需求相关的代码块。
- **稀疏关键词检索**：对标识符、路径、引用和定义做关键词增强。
- **代码关系扩展**：沿调用、引用、继承、类层级等关系扩展搜索结果。
- **PageRank 排序**：优先返回全局更重要、引用密度更高的代码块。
- **可调参数**：可配置图谱扩展开关、深度、结果数量与评分权重。

### 长上下文管理与可观测性

为了让复杂任务更可控，本分支增加了多种上下文管理和检查入口：

- **任务上下文保留**：可配置保留最近若干 todo 的完整上下文。
- **上下文压缩与摘要**：长对话中通过摘要和上下文块降低 token 压力。
- **Context Inspector**：查看 API 请求上下文，理解模型实际收到的历史和系统提示。
- **Summary Inspector**：查看任务摘要与上下文摘要结果。
- **Debug Proxy**：调试模式下可将网络请求转发到本地代理进行检查。

### 多模型与本地 AI

项目支持多类模型供应商和本地模型工作流：

- **云端模型**：OpenAI、Anthropic、Google Gemini、Vertex AI、AWS Bedrock、DeepSeek、Mistral、xAI 等。
- **聚合与兼容接口**：OpenRouter、OpenAI-compatible Provider 等。
- **本地模型**：Ollama、LM Studio 等本地推理服务。
- **概要模型选择**：可单独选择用于上下文压缩/摘要的 API Profile。

## 工作流概览

```text
用户需求
  ↓
Refine：理解需求、读取代码、拆分架构任务
  ↓
write_todo_plan：写入任务上下文、文件计划、跨任务约定
  ↓
Build：自动进入实现阶段
  ↓
Parallel Subagents：按任务隔离并行执行
  ↓
Completion：汇总结果、更新摘要、保留任务历史
```

## 快速开始

### 环境要求

- **Node.js**：`20.19.2`
- **pnpm**：`10.8.1`
- **VS Code**：`^1.84.0`
- **Git**
- **可选**：Ollama、LM Studio、Qdrant 或你使用的模型服务 API Key

### 克隆仓库

```sh
git clone https://github.com/tiantiankaixin-dev/Neural-Connection.git
```

### 安装依赖

```sh
pnpm install
```

### 开发模式运行

在 VS Code 中打开仓库，按 `F5`，会启动一个新的 Extension Development Host 窗口。

- **Webview 改动**：通常可以快速热更新。
- **扩展核心改动**：通过 watch/bundle 流程更新。

### 构建并安装 VSIX

自动构建并安装：

```sh
pnpm install:vsix
```

可选参数：

```sh
pnpm install:vsix -y --editor=cursor
```

手动构建：

```sh
pnpm vsix
code --install-extension bin/roo-cline-<version>.vsix
```

## 常用脚本

| 命令                | 说明                     |
| ------------------- | ------------------------ |
| `pnpm install`      | 安装依赖并执行 bootstrap |
| `pnpm build`        | 构建所有 workspace 包    |
| `pnpm bundle`       | 打包扩展运行时代码       |
| `pnpm check-types`  | TypeScript 类型检查      |
| `pnpm lint`         | 运行 ESLint              |
| `pnpm test`         | 运行测试                 |
| `pnpm vsix`         | 生成 VS Code 扩展安装包  |
| `pnpm install:vsix` | 构建并安装 VSIX          |
| `pnpm clean`        | 清理构建产物             |

## 项目结构

```text
.
├── src/                 # VS Code 扩展核心、任务循环、工具、模型 Provider、代码索引
├── webview-ui/          # 扩展侧边栏和设置页 UI
├── packages/            # 共享类型、核心包、IPC、云服务、构建配置
├── apps/                # CLI、Web、E2E 和评估相关应用
├── docs/                # Neural-Connection 相关设计与工具文档
├── locales/             # 多语言 README 和贡献文档
├── scripts/             # 构建、安装和辅助脚本
└── .github/             # GitHub Actions、Issue 模板和 PR 模板
```

## 配置与能力入口

### 扩展设置

可在 VS Code 设置中配置：

- **API Profile**：选择模型供应商、密钥、模型和请求参数。
- **Codebase Index**：启用代码库索引、调整 embedding 批大小和图谱扩展参数。
- **Condensing Model**：为上下文压缩/摘要单独选择模型配置。
- **Neural Agent**：管理本地 AI 开关和 Ollama 连接状态。
- **Debug Proxy**：调试模式下代理网络请求，便于排查 Provider 通信。

### 代码动作

编辑器右键菜单和终端菜单提供常见入口：

- **Add To Context**
- **Explain Code**
- **Improve Code**
- **Fix This Command**
- **Explain This Command**

### 调试入口

扩展命令中包含：

- **Open Context Inspector**
- **Open Summary Inspector**
- **Toggle Auto-Approve**
- **Task History**

## 文档

- [Refine 工具完整参考文档](./docs/refine-tools-reference.md)
- [上下文管理架构重构计划](./docs/context-architecture-plan.md)
- [贡献指南](./CONTRIBUTING.md)
- [更新日志](./CHANGELOG.md)
- [安全策略](./SECURITY.md)
- [隐私说明](./PRIVACY.md)

## 贡献

欢迎通过 Issue 和 Pull Request 参与改进。

建议提交前关注：

- **任务边界**：改动尽量聚焦，避免同时修改无关模块。
- **类型安全**：涉及 TypeScript 代码时保持类型检查通过。
- **工具一致性**：新增工具需遵循现有工具定义、参数校验和错误处理模式。
- **文档同步**：行为变化应同步更新 README、docs 或相关说明。

更多规范请阅读：[CONTRIBUTING.md](./CONTRIBUTING.md)

## 安全与免责声明

AI 代理可能会生成、修改、执行代码或命令。使用前请确认：

- **敏感信息**：不要把 API Key、密码、私钥提交到仓库。
- **命令执行**：谨慎开启自动批准，必要时配置 allowed/denied commands。
- **模型输出**：AI 生成内容需要人工审查，尤其是安全、权限、数据处理和生产环境改动。
- **本地调试**：Debug Proxy 仅建议在本地调试时使用。

## 许可与归属

本项目基于 [Roo Code](https://github.com/RooCodeInc/Roo-Code) 进行二次开发，保留上游项目的核心架构、扩展能力与许可信息。

许可证：[Apache License 2.0](./LICENSE)
