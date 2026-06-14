# KualityForge 评审报告模板规范

本规范定义 `kualityforge report` 生成的报告结构，以及人工撰写中文评审报告时必须遵循的统一格式。编号体系（F# / G# / P#）使评审、共识、归纳原则之间可以稳定交叉引用。

## 适用与语言

- 报告语言跟随发起评审所用语言：中文指令产出中文报告。
- 报告写入被评审项目自身的 `docs/` 目录（如 `docs/reviews/`），而非全局目录。
- 多 agent 评审：实际完成评审的 reviewer 少于 2 个时，**中止出具报告**，仅说明评审未达成。

## 章节结构（固定顺序）

正文尽量使用**表格**呈现，便于横向对照；动态文本中的 `|` 须转义，换行用 `<br>`。

### 1. 运行头（Run Header）
键值表（Field | Value）：

| Field | Value |
| --- | --- |
| Profile | profile 名 |
| Gate status | passed / blocked 等 |
| Gate reasons | 多条用 `<br>` 分隔 |
| Gate warnings | 多条用 `<br>` 分隔 |

### 2. Changeset
键值表 + 文件表两张表：

| Field | Value |
| --- | --- |
| Base | base (短 sha) |
| Head | head (短 sha) |
| Files changed | 文件数 |
| Patch truncated | yes/no |

| Status | Path |
| --- | --- |
| M | path/to/file |

### 3. Findings（F#）
表格，编号 F1、F2……

| # | Title | Severity | Status | Reviewers | Count |
| --- | --- | --- | --- | --- | --- |
| F1 | 标题 | blocker/warning/info | open 等 | 来源 runnerId 列表 | reviewer 数 |

每条 finding 下方，若 description 或 suggestion 非空，Markdown 输出使用纯 Markdown 小节，避免在不支持 raw HTML 的渲染器里直接显示标签：

### F1: 详情与建议

**Description:** 问题详情

**Suggestion:** 修复建议

HTML 输出可以使用 `<details>` 折叠展示同一内容。

### 4. Consensus Findings（G#）
仅列 `reviewerCount >= 2`，编号 G1、G2……无共识时写明“无共识问题（>= 2 reviewers）”。

| # | Title | Severity | Reviewers | Count |
| --- | --- | --- | --- | --- |
| G1 | 标题 | warning | a, b | 2 |

### 5. Reviewer Scores
表格 + 其后 Ranking 行。评分为**咨询性**，不影响 gate 判定。

| Reviewer | Score | Findings | Consensus | Role |
| --- | --- | --- | --- | --- |
| runnerId | 分值 | finding 数 | 共识率% | 角色 |

### 6. Induced Principle Candidates（P#，咨询）
**必含段落**，表格编号 P1、P2……无候选时写明“未归纳出候选原则”。该段为咨询产物，是否纳入由人工决定。

| # | Priority | Statement | Id |
| --- | --- | --- | --- |
| P1 | must/should/prefer | 原则陈述 | 候选 id |

### 7. Decisions & Verification
键值表 + 人工结论与后续动作。

| Field | Value |
| --- | --- |
| Gate decision | passed 等 |
| Findings | N total, M at consensus |
| Induced candidates | N（咨询；采纳由人工决定） |

## 评审模式

报告支持两种评审模式，由 `reviewType` 字段控制：

| reviewType | 适用场景 | 渲染章节 |
|---|---|---|
| `changeset`（默认） | PR/MR review、release gate、增量评审 | 1-7（基础章节） |
| `full-project` | 技术债务评估、架构审计、全量代码评审 | 0 + 1-7 + A-D（基础 + 扩展章节） |

当 `reviewType` 为 `full-project` 时，渲染以下扩展章节（按顺序插入在 3 和 4 之间，或在 7 之后）。

### 推荐评审维度（full-project 模式）

全量评审应至少覆盖以下维度，每个维度分配一位评审员：

| 维度 | 评审范围 | 关键检查项 |
|---|---|---|
| 代码质量与架构 | 应用源码（src/、components/、hooks/） | 架构模式、类型安全、代码复杂度、依赖管理 |
| 安全与性能 | 主进程、IPC、网络请求、认证 | 注入漏洞、SSRF、密钥泄露、内存泄漏 |
| UI/UX 与可维护性 | 组件、样式、国际化 | CSS 变量使用、无障碍性、i18n 覆盖率 |
| 业务逻辑与迁移完整性 | 业务模块、状态管理 | 功能回归、双框架一致性、数据流正确性 |
| **构建/安装/部署脚本** | 打包脚本、安装器（Inno Setup/NSIS/DMG）、CI/CD、shell 脚本 | 路径注入、`rm -rf` 安全、变量校验、权限提升、注册表操作 |

**构建/安装/部署脚本**维度为必选。该维度重点关注：
- `DelTree` / `rm -rf` / `rmdir` 等破坏性操作是否有 `DirExists` / 路径非空校验
- 模板变量（如 `{#MyPackageName}`）为空时路径是否退化为父目录
- shell 脚本中 `$curdir` 等外部变量是否在使用前校验
- `find ... | xargs rm` 是否有 `-maxdepth` 限制
- Inno Setup / NSIS 中从注册表读取并执行命令的注入风险
- 签名/证书操作是否验证来源完整性

### 0. 项目概览（Project Overview）— 仅 full-project 模式

渲染在运行头之前。键值表 + 评审范围表：

| Field | Value |
| --- | --- |
| 项目名称 | 项目名 |
| 版本 | 版本号 |
| 评审范围 | 评审的目录或模块范围 |
| 技术栈 | 主要技术栈 |
| 代码规模 | 文件数 / 行数（按语言分） |
| 评审员数 | N 个 |

### A. 评审员详细分析（R#）— 仅 full-project 模式

插入在 **3. Findings (F#)** 和 **4. Consensus Findings (G#)** 之间。每个 reviewer 对应一个 R# 节，编号 R1、R2……

**HTML 输出**：使用 `<details>` 折叠展开，默认折叠，summary 显示评审员名称 + 综合评分 + 评级。

**Markdown 输出**：使用三级标题 `### R{n}: {reviewerId}` + 折叠标记。

每个 R# 节包含：

**R{n} 子维度评分表：**

| 子维度 | 评分 | 关键发现 |
| --- | --- | --- |
| 子维度名 | N/10 | 发现摘要 |

**R{n} Top 问题（按严重度排序）：**

| # | 严重度 | 问题 | 位置 |
| --- | --- | --- | --- |
| 1 | P0 | 问题描述 | 文件路径 |

**R{n} 改进建议（按优先级排序）：**

| # | 优先级 | 建议 | 预期收益 |
| --- | --- | --- | --- |
| 1 | P0 | 建议描述 | 收益描述 |

### B. 风险矩阵（Risk Matrix）— 仅 full-project 模式

插入在 **7. Decisions & Verification** 之后。

| # | 风险 | 概率(1-5) | 影响(1-5) | 风险分(P×I) | 类别 | 关联 Finding |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 风险描述 | 5 | 5 | 25 | 类别 | F1, F2 |

### C. 行动路线（Action Plan）— 仅 full-project 模式

插入在风险矩阵之后。

| 优先级 | 行动 | 预估投入 | 关联 Finding |
| --- | --- | --- | --- |
| P0 | 行动描述 | N 人天 | F1-F3, G1, P1 |

### D. 综合评级（Overall Grade）— 仅 full-project 模式

插入在行动路线之后，作为报告末尾。

| 维度 | 评分 | 评审员 |
| --- | --- | --- |
| 维度名 | N/10 | reviewerId |

综合评级：**字母**（A/B/C/D/F）

评级理由：一段文字描述。

升级路径：描述从当前评级提升到下一级的条件。

## 编号约定

- **F#**：单条 finding（含未达共识的）。
- **G#**：达成共识（≥2 reviewer）的 finding。
- **P#**：本轮归纳出的候选质量原则。
- **R#**：评审员详细分析（仅 full-project 模式）。

机器报告由 `src/core/report.mjs` 的 `renderReportMarkdown` / `renderReportHtml` 自动生成并遵循同一结构；人工中文报告应保持相同章节与编号，便于对照。
