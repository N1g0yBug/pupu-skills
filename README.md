<h1 align="center">pupu-skills</h1>

<p align="center">
  <b>Claude Code 的技能记忆插件</b><br>
  Markdown 技能库 + LLM 自主路由 + 效用评分，让 Claude 拥有持久化技能记忆
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-100%25-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/MCP-Protocol-FF6F00" alt="MCP">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT">
</p>

---

## 这是什么

pupu-skills 让 Claude Code 拥有**技能记忆**。

普通 Claude Code 每次对话都从零开始。装了这个插件后：

1. Claude 学会的东西**存成技能**，下次直接用
2. 遇到任务时，Claude **自己判断**用哪个技能（LLM 路由）
3. 执行失败时**自动分析原因**，Claude 自己修复技能文档
4. 技能越用越熟练（效用评分），长期不用的自动提醒清理
5. 技能之间可以**互相组合**，像乐高积木一样搭

**类比**: 没有它 = 每次搬家扔掉所有工具重新买。有它 = 工具箱带着走，而且越用越好用。

灵感来源: [Memento-Skills](https://github.com/Memento-Teams/Memento-Skills) — 核心理念对齐（技能持久化 + 效用评分 + 自我进化），但不需要 Python/Docker/daemon，纯 Claude Code 插件。

---

## 安装

```
/install-plugin https://github.com/N1g0yBug/pupu-skills
```

完事。唯一前置: Claude Code（自带 Node.js）。

---

## 怎么用

安装后不需要学任何命令。直接跟 Claude 说人话：

```
帮我分析一下这个 APK 的签名校验逻辑
```

Claude 会自动：
1. 调用 `pupu_route` 搜索匹配的技能
2. 如果没有 → 创建新技能 → 执行 → 存档
3. 如果有 → 直接按技能文档执行
4. 失败了 → `pupu_reflect` 分析原因 → 修复技能

下次再说「帮我逆向这个 APK」，Claude 直接调出上次存的技能，不用从头来。

### 主动保存经验 /bugss

任务结束后，输入 `/bugss` 让 Claude 回顾当前对话，自动提取可复用的经验存成技能。

配置方法：在 `~/.claude/commands/bugss.md` 创建文件：

```markdown
你是技能提取器。回顾当前会话的完整上下文，执行以下流程：

## 步骤

### 1. 上下文扫描
回顾本次对话中完成的所有任务，提取：
- 做了什么（任务类型）
- 怎么做的（具体步骤、工具、方法）
- 遇到什么问题、怎么解决的
- 有哪些重复模式或通用经验

### 2. 技能库检查
调用 `pupu_read` 搜索已有技能，判断当前经验是否已被覆盖。

### 3. 生成技能
如果发现可提取的经验，调用 `pupu_write` 创建或更新技能。
技能必须包含：触发条件、执行步骤、注意事项、Evolution History。

### 4. 输出报告
完成后输出：创建了什么、跳过了什么、当前技能库状态。

## 约束
- 不生成纯一次性操作的技能，只提取有复用价值的经验
- 不生成过于宽泛的技能（如"写代码"），要具体到可执行的步骤
```

---

## 工作原理

### 技能 = Markdown 文档

每个技能是一个 `.md` 文件，包含自然语言指令。Claude 读文档、按步骤行动。

```markdown
---
name: analyze_apk
description: 逆向分析 Android APK
triggers:
  - 逆向 apk
  - 反编译
  - jadx
tags: ["android", "security"]
antiTriggers: ["ios", "web"]
scope: global
---

# analyze_apk

## 触发条件
当用户要求逆向分析 APK 文件时使用。

## 适用场景
- Android APK 逆向分析
- 签名校验逻辑提取

## 不适用场景
- iOS 应用分析
- Web 应用调试

## 前置条件
- jadx 已安装

## 执行步骤
1. 确认 APK 文件路径
2. 使用 jadx 反编译
3. 搜索签名校验、加密函数、网络请求模式
4. 汇总分析报告

## 成功判定
- 成功提取目标逻辑并输出分析报告

## 失败分支
- APK 加壳 → 先脱壳再分析
- jadx 失败 → 尝试 apktool

## 示例任务
- 逆向 com.example.app 的签名校验
```

### 闭环流程

```
遇到任务 → pupu_route（选技能）
    ↓
pupu_execute（读技能文档 → Claude 执行）
    ↓
完成 → pupu_after_task（记录结果 + 自动学习判断） → 效用分更新
失败 → pupu_reflect（分析原因） → 修复技能
```

### 技能路由

基于中英文分词 + 触发词匹配 + 效用分加成的启发式评分，自动推荐最合适的技能：

```
pupu_route({ task: "帮我处理这个 Excel 表格" })
→ 推荐: xlsx (92分), filesystem (35分)
```

### 效用评分

每个技能 0~100 分，每次执行后自动更新：

```
分数 = 50 + (成功率 × 50) + 连续成功加成 - 连续失败惩罚 - 时间衰减
```

| 分数 | 含义 |
|---|---|
| 🟢 ≥ 70 | 高效用，优先推荐 |
| 🟡 40~69 | 正常 |
| 🔴 < 40 | 需要关注 |
| 💀 < 15 | 建议淘汰 |

### Prompt 注入

每个 tool 响应末尾自动附带技能库摘要：

```
技能库: 12 个技能 (9 内置)
可用:
  - analyze_apk(92分): 逆向分析 Android APK
  - xlsx(78分): Excel 表格处理
  - filesystem(72分): 文件读写、搜索、批量处理

重要行为规则（每次都必须遵守）：
1. 接到任务时，先查看技能库摘要；不确定时调用 pupu_route
2. 完成任务后，优先调用 pupu_after_task 进行收尾闭环
```

Claude 在任何交互后都能看到可用技能，不需要主动搜索。

---

## 11 个 MCP Tool

| Tool | 功能 |
|---|---|
| `pupu_read` | 搜索技能库 + 自动注入技能摘要 |
| `pupu_write` | 创建/更新技能（markdown 格式） |
| `pupu_execute` | 返回技能文档给 Claude，Claude 读后执行 |
| `pupu_report` | Claude 汇报执行结果，记录到历史 |
| `pupu_reflect` | 分析失败原因，给出修复建议 |
| `pupu_evolve` | 技能进化评估 / 低效技能清理 |
| `pupu_delete` | 删除技能 |
| `pupu_history` | 查看执行历史 |
| `pupu_route` | 根据任务描述推荐技能（分词 + 触发词 + 效用评分） |
| `pupu_learn` | 自动学习，判断是否需要新建或优化技能 |
| `pupu_after_task` | **任务收尾**：记录结果 + 自动判断学习动作（整合 report + learn） |

### Workspace 隔离

技能库支持 workspace 隔离。不同项目可以各自拥有同名技能，互不影响：

- **global 技能**：所有 workspace 可见，适用于通用场景
- **workspace 技能**：仅在指定 workspace 可见，优先于同名 global 技能
- 所有 MCP tool 均支持 `workspaceId` 参数，精确操作当前 workspace 的技能
- 技能路由和摘要只展示当前 workspace 可见的技能（global + 当前 workspace）
- 不传 `workspaceId` 时只命中 global 技能，避免歧义
- 更改技能的 scope（如 workspace→global）会创建同名技能的新作用域版本，不会删除原版本

---

## 9 个内置技能

安装后自动注册，不可删除：

| 技能 | 功能 |
|---|---|
| `filesystem` | 文件读写、搜索、批量处理 |
| `web-search` | 网络搜索和信息收集 |
| `grep` | 代码/文本高级搜索模式 |
| `docx` | Word 文档处理 |
| `pdf` | PDF 读取和创建 |
| `xlsx` | Excel 表格处理 |
| `pptx` | PowerPoint 处理 |
| `image-analysis` | 图片分析和处理 |
| `skill-creator` | 创建新技能的模板和指南 |

---

## 项目结构

```
pupu-skills/
├── .claude-plugin/plugin.json   # Claude Code 插件清单
├── .mcp.json                    # MCP Server 声明
├── skills/                      # 内置技能 (markdown)
│   ├── filesystem.md
│   ├── web-search.md
│   ├── grep.md
│   ├── docx.md
│   ├── pdf.md
│   ├── xlsx.md
│   ├── pptx.md
│   ├── image-analysis.md
│   └── skill-creator.md
├── bin/pupu.js                  # CLI 入口
├── src/
│   ├── index.ts                 # MCP Server — 10 个 Tool
│   ├── cli.ts                   # CLI: start/list/show/history/delete
│   ├── memory/store.ts          # 技能存储 + 效用评分 + workspace 隔离
│   ├── router/router.ts         # LLM 技能路由（workspace 过滤）
│   └── utils/logger.ts
└── package.json
```

---

## 与 Memento-Skills 的对比

| 维度 | Memento-Skills | pupu-skills |
|---|---|---|
| 定位 | 独立 agent 框架 | Claude Code 插件 |
| 技能格式 | Markdown | Markdown ✅ |
| LLM 路由 | stateful prompt | pupu_route + prompt 注入 ✅ |
| 效用评分 | 有 | 0~100 ✅ |
| 技能进化 | reflect + evolve | pupu_reflect + pupu_evolve ✅ |
| 安装 | pip + 手动配置 | `/install-plugin` 一条命令 ✅ |
| 语言 | Python | TypeScript |
| 外部依赖 | Python, uv, litellm... | 仅 @modelcontextprotocol/sdk + zod |
| 运行时 | Docker sandbox + daemon | 无（Claude Code 自身就是执行引擎） |
| 内置技能 | 9 个 | 9 个 ✅ |

---

## 开发

```bash
npm install
npm run build        # tsc 编译
npm test             # 49 个 e2e 测试
npm run dev          # 开发模式启动 MCP server
```

---

## License

MIT
