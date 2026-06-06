---
name: kualityforge
description: 用 KualityForge 做多 agent 交叉评审。当用户要求评审代码、质量门禁、code review、评审改动时使用。默认多 agent 交叉评审，除非用户明确要求快速单 agent 模式。
---

KualityForge 的核心是多 agent 交叉评审——多个独立 agent 各自评审，再合成共识、打分、归纳质量原则。单 agent 只在用户明确要求速度时使用。

CLI 调用方式：先尝试 `kualityforge`，如果不在 PATH 中，使用 `node /Users/song/projects/kualityforge/src/cli/index.mjs`。

**所有 `--artifact-root` 必须指向项目内 `docs/quality/${RUN_ID}/` 目录。禁止使用 `/tmp/`、绝对路径或其他临时目录。** 评审产物必须持久化在项目目录里，以便后续多 agent 追加评审和生成报告。

## 默认模式：多 Agent 交叉评审（KSwarm）

### 1. 创建 Preview

```bash
RUN_ID="review-$(date +%Y%m%d-%H%M%S)"
kualityforge kswarm-preview \
  --project-id "$(basename $(pwd))" \
  --run-id "${RUN_ID}" \
  --artifact-root "docs/quality/${RUN_ID}" \
  --reviewer codex --reviewer claude \
  --project-root .
```

可选参数：`--advisory-reviewer xiaok` `--quorum-min 2` `--diff-base main --diff-head HEAD` `--lang zh`

将输出的 preview JSON 保存到文件。

### 2. 创建 Runtime Plan

```bash
kualityforge kswarm-run \
  --mode brokered \
  --kswarm-url <broker-url> \
  --preview preview.json \
  --plan runtime-plan.json \
  --reviewer codex --reviewer claude \
  --decision decision.md \
  --check "npm test=passed"
```

或离线模式（无需 broker，agent 手动执行）：

```bash
kualityforge kswarm-run \
  --offline \
  --preview preview.json \
  --plan runtime-plan.json \
  --review codex=reviews/codex.md --review claude=reviews/claude.md \
  --decision decision.md \
  --check "npm test=passed"
```

离线模式下，将评审任务分发给各 agent（Codex CLI、Claude Code、xiaok 等），每个 agent 独立完成评审后，将其评审文件放到指定路径。

### 3. 生成报告

```bash
kualityforge report --artifact-root "docs/quality/${RUN_ID}" --html --lang zh && open "docs/quality/${RUN_ID}/reports/"*.html
```

向用户展示：gate 状态、共识发现、评审员评分排名、归纳质量原则候选。HTML 报告会自动在浏览器中打开。

## 快速模式：单 Agent 评审

用户明确要求快速评审时使用。

### 1. 初始化

```bash
RUN_ID="review-$(date +%Y%m%d-%H%M%S)"
kualityforge init --artifact-root "docs/quality/${RUN_ID}" --run-id "${RUN_ID}" --project-root .
```

### 2. 评审并写入

阅读代码改动，撰写评审文件：

````markdown
# Review

```kualityforge-review
{
  "runnerId": "<agent 标识>",
  "status": "completed",
  "contextRead": { "user_quality_principles": true, "project_brief": true },
  "contextConfidence": "high",
  "contextGaps": [],
  "findings": [
    {
      "id": "QF-001",
      "title": "<标题>",
      "severity": "<blocker|high|warning|info>",
      "status": "open",
      "duplicateKey": "<english-slug>"
    }
  ]
}
```

<每条 finding 的详细说明、代码位置、修复建议>
````

```bash
kualityforge write-review --artifact-root "docs/quality/${RUN_ID}" --input "docs/quality/${RUN_ID}/review.md"
```

### 3. Gate + 报告

```bash
kualityforge gate --artifact-root "docs/quality/${RUN_ID}"
kualityforge report --artifact-root "docs/quality/${RUN_ID}" --html --lang zh && open "docs/quality/${RUN_ID}/reports/"*.html
```

## 规则

- severity 只有 4 级：blocker / high / warning / info
- id 和 duplicateKey 用英文 slug，title 和说明可用中文
- 每条 finding 必须有代码位置和修复建议
