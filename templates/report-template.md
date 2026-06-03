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

## 编号约定

- **F#**：单条 finding（含未达共识的）。
- **G#**：达成共识（≥2 reviewer）的 finding。
- **P#**：本轮归纳出的候选质量原则。

机器报告由 `src/core/report.mjs` 的 `renderReportMarkdown` / `renderReportHtml` 自动生成并遵循同一结构；人工中文报告应保持相同章节与编号，便于对照。
