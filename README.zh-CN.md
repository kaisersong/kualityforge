# kualityforge

> KualityForge 是一个 artifact-first 的多智能体质量门禁系统。它把模型评审、人类决策、修复、验证、测试和 eval 证据整理成可审计、可复现、可被 CI / ship 阻断使用的确定性质量门禁。

一个面向多 Agent 软件交付的本地质量门禁核心，而不是又一个单 Agent code review 脚本。

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 当前状态

KualityForge 还在项目启动阶段。当前仓库已经包含第一片 deterministic gate reducer：

- `manifest.json` / policy schema 草案。
- `kualityforge init --artifact-root <path> --run-id <id>` CLI 入口。
- `kualityforge gate --manifest <path>` 和 `kualityforge gate --artifact-root <path>` CLI 入口。
- 通过 `kualityforge write-review` 写入 review artifact。
- 通过 `kualityforge synthesize` 生成 summary。
- human decision、required check、verification 的记录命令。
- 通过 `kualityforge eval` 执行 deterministic eval。
- 通过 `kualityforge run` 串起本地 artifact workflow。
- 通过 `kualityforge init --project-root ... --docs-root ... --quality-principles ...` 冻结 context pack。
- 通过 `kualityforge kswarm-preview` 生成 KSwarm dynamic workflow preview 和 runtime plan。
- 通过 `kualityforge kswarm-run --offline` 执行 KSwarm runtime executor core 的离线 smoke。
- 冻结统一变更集，使所有 reviewer 评审同一份文件集合；通过 `init --diff-base/--diff-head/--diff-max-patch-bytes` 与 `context/changeset.{json,md}` 实现。
- 每个 reviewer 的咨询性评分写入 `scores.json`（确定性，不阻断 gate）。
- 每轮归纳候选质量原则写入 `induced-principles.{json,md}`（咨询；是否纳入由人工决定）。
- 通过 `kualityforge report` 生成人类可读报告（默认 Markdown，`--html` 可选），采用固定的 F#/G#/P# 表格模板。
- 双报告模式：`changeset`（7 个基础章节，适用于 PR/release 评审）和 `full-project`（追加项目概览、R# 评审员详细分析含子维度评分、风险矩阵、行动路线和综合评级，适用于全量代码审计）。
- 通过 `kualityforge report --input <manifest.json>` 从独立 JSON manifest 生成报告，无需完整 artifact root，方便外部项目集成。
- 模板规范新增推荐评审维度表，其中「构建/安装/部署脚本安全」标记为必选维度。
- review artifact 支持 context acknowledgement、context provenance、context gaps 和质量原则违背 finding。
- artifact reference validation 会拒绝绝对路径和 `..` traversal。
- 对证据不完整的质量运行执行 fail-closed reducer。
- 覆盖通过、reviewer 不足、manifest 无效、verifier 不独立、缺 context、缺 reviewer acknowledgement、context confidence low、未解决 must 原则违背等 case 的 unit tests。
- 覆盖 artifact-root 初始化、synthesis 输出、eval 和 clean passing run 的 fixture、golden、CI、E2E tests。
- 通过 `docs -> ../mydocs/kualityforge` 维护项目文档。

真实多 Agent runner dispatch 不属于 deterministic core。当前本地 `run` 命令只消费已经生成的 artifacts，不调用模型。`kswarm-preview` 可以输出 KSwarm `script_generated` preview 和 KualityForge runtime plan。`kswarm-run --offline` 会用 in-memory KSwarm client 执行这份 plan，用于 contract 和 artifact smoke；live KSwarm / Intent Broker adapter 属于后续集成层。

---

## 为什么需要 KualityForge

AI coding workflow 已经能很快生成代码，但 release confidence 仍然容易停留在“某个模型说看过了”或者“一段 chat transcript 看起来没问题”。KualityForge 的前提更严格：

**质量门禁只有在证据完整、结构化、独立可验证、可复现时才能通过。**

它参考 Viking `review-forge` 的 review / synthesize / fix / verify 循环，但目标是把这个思路扩展成通用质量门禁基础设施：

- 多个 reviewer 可以独立检查同一目标。
- synthesis 合并发现，同时保留分歧。
- human decision gate 决定哪些 finding 被批准修复。
- fixer 只能修复已批准 finding。
- independent verification 验证修复是否真的覆盖批准范围。
- 项目 required checks 和 eval baseline 进入 release evidence。
- CI / ship workflow 消费确定性的 gate result，而不是阅读自然语言判断。

KualityForge 不是 xiaok 专用功能。它的 core 通过 CLI、artifact 目录和 policy 文件为任意项目提供质量门禁。

---

## 关键设计思想

### 1. Artifact-First Quality

KualityForge 把文件作为质量事实来源。review、synthesis、human decision、fix plan、required checks、verify report 和最终 gate status 都写入一次 run 的 artifact 目录。

这样有三个直接收益：

- 模型 session 结束后仍然可以审计。
- 其他工具可以 resume 或重新 reduce。
- CI 不需要让模型重新解释 chat history。

目标 artifact 结构：

```text
docs/quality/<run-id>/
  manifest.json
  context/
    context-manifest.json
    quality-principles.json
    project-context.json
    project-brief.md
    docs-index.json
    instructions/
  reviews/
    codex.md
    claude.md
    xiaok.md
  summary.md
  decision.md
  fix-plan.md
  checks/
  verify.md
```

### 2. 用户质量原则高于项目目标

KualityForge 可以在 review 开始前冻结用户质量原则和项目上下文。用户质量原则是跨项目约束；项目目标说明当前项目或当前 change 想做什么。

当两者冲突时，用户质量原则优先。reviewer 不能因为局部项目目标说“尽快 ship”，就放过 must 级用户原则要求的独立验证、多 reviewer 证据或 eval 覆盖。

context pack 记录：

- 用户质量原则。
- project root 和 docs roots。
- `AGENTS.md`、`CLAUDE.md`、README 和指定 instruction files。
- design entrypoints 和 docs index。
- change goal、non-goals、相关 repo 和 required checks。
- reviewer acknowledgement 和 context provenance。

### 3. Reviewer 可以不确定，Gate 必须确定

模型 reviewer 可以是概率性的；gate reducer 不可以。

给定同一份 manifest、policy 和 artifacts，`kualityforge gate` 必须总是返回同样的 status、reasons 和 exit code。这样 release automation 才不会因为某次模型输出波动而改变基础门禁判断。

当前 gate status 刻意保守：

- `passed`：所有要求的证据都存在且已验证。
- `incomplete`：证据缺失或 finding 未闭环。
- `failed`：存在终态失败或 blocking condition。
- `invalid_artifact`：manifest 或 artifact shape 不可信。

### 4. Fail Closed

KualityForge 不应该把缺证据解释成通过。release profile 下，以下任一项缺失或无效都不能 passed：

- reviewer 数量。
- human decision artifact。
- required checks。
- verification artifact。
- 独立 verifier identity。
- 合法 manifest shape。
- finding resolution status。
- policy 要求的项目 context 和用户质量原则。
- reviewer 对必读 context 的 acknowledgement。
- policy 要求的 context provenance 匹配。

这是有意的偏置。一个偶尔阻断过多的质量门禁可以调参；一个默默放过不完整证据的门禁不能被信任。

### 5. Human Decision 是修复边界

AI reviewer 可以发现问题，但不应该单方面决定改什么。KualityForge 保持一条硬边界：

- 未勾选 finding 不能进入 fix queue。
- `wont_fix` 和 `risk_accepted` 必须留下明确 decision record。
- fix artifact 不能悄悄覆盖未批准 finding。
- verification 验证的是批准范围，不是笼统地说“都好了”。

这让人类判断保留在关键位置，同时把 review、fix 和 verify 的证据链自动化。

### 6. 独立验证

release profile 下，fixer 和 verifier 必须是不同 runner identity。一个模型或 agent 不应该既修复问题，又作为唯一证据证明自己的修复有效。

第一版在 manifest 层检查这个约束。后续接入 KSwarm 后，会在 workflow scheduling 层也强制执行。

### 7. KSwarm 编排，KualityForge 判门禁

KualityForge 不持有 durable workflow execution。这个职责属于 KSwarm。

边界是：

- KualityForge 负责 schema、artifact parsing、reducer、CLI gate、tests、fixtures 和 eval。
- KualityForge 可以生成 KSwarm `script_generated` workflow preview 和 runtime plan。
- KualityForge 提供可注入 client/provider 的 runtime executor，不把任何模型 runner 写死进 core。
- KSwarm 负责 `kualityforge-flow`：fan-out 状态、retry、resume、cancel、decision gate 和 node scheduling。
- Intent Broker 负责 runner dispatch 和 event correlation。
- xiaok 负责 desktop / CLI 入口和用户可见状态。

这样 gate core 才能在 xiaok 之外、KSwarm 之外也能独立使用。

### 8. Eval 是产品的一部分

KualityForge 自己必须被测试和评估。质量门禁系统不能只靠几次真实项目跑通来证明可靠。

计划中的验证层级包括：

- Unit / contract tests：schema、parser、reducer、状态流转和 exit code。
- Fixture / golden tests：已知 artifact 集合和预期 gate result。
- Workflow tests：KSwarm node 顺序、resume、retry、human decision 阻断。
- Adapter tests：Codex、Claude Code、xiaok runner handoff。
- CI tests：机器可读输出和 release blocking。
- E2E smoke tests：mock reviewer、fixer、verifier 的端到端闭环。
- Deterministic eval：覆盖 seeded bug 和 adversarial artifact corpus。
- Model-assisted eval：作为 release 或 nightly 信号，而不是唯一门禁证据。

---

## 仓库结构

```text
kualityforge/
  src/
    cli/
      index.mjs
    core/
      gate-reducer.mjs
      context-pack.mjs
      changeset.mjs
      synthesis.mjs
      reviewer-scoring.mjs
      principle-induction.mjs
      report.mjs
      artifact-operations.mjs
      kswarm-workflow.mjs
      kswarm-runtime-executor.mjs
      kswarm-brokered-runtime.mjs
    index.mjs
  schemas/
    manifest.schema.json
    policy.schema.json
    context-manifest.schema.json
    project-context.schema.json
    quality-principles.schema.json
  templates/
    report-template.md
  tests/
    kualityforge/
      unit/
      fixtures/
      golden/
      workflow/
      adapters/
      ci/
      e2e/
  evals/
    kualityforge/
      corpus/
      reports/
  docs -> ../mydocs/kualityforge
```

---

## 快速开始

运行测试：

```bash
cd /Users/song/projects/kualityforge
npm test
```

用当前 CLI 检查一份 manifest：

```bash
node src/cli/index.mjs gate --manifest path/to/manifest.json
```

初始化一个带冻结项目上下文的 run：

```bash
node src/cli/index.mjs init \
  --artifact-root docs/quality/<run-id> \
  --run-id <run-id> \
  --project-root /path/to/project \
  --docs-root /path/to/docs \
  --quality-principles /path/to/quality-principles.json \
  --change-goal "按声明的质量 profile 评审本次 release" \
  --instruction AGENTS.md \
  --instruction CLAUDE.md
```

本地 link 后：

```bash
cd /Users/song/projects/kualityforge
npm link
```

命令形态会变成：

```bash
kualityforge gate --manifest path/to/manifest.json
```

成功输出示例：

```json
{
  "status": "passed",
  "exitCode": 0,
  "reasons": []
}
```

未闭环时返回非 0 exit code：

```json
{
  "status": "incomplete",
  "exitCode": 2,
  "reasons": [
    "reviewer shortage: expected at least 2, got 1",
    "verification artifact is required"
  ]
}
```

---

## 命令

当前已实现：

```bash
kualityforge init --artifact-root <path> --run-id <id> [--profile <name>] [--diff-base <ref>] [--diff-head <ref|WORKTREE>] [--diff-max-patch-bytes <n>]
kualityforge run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id>
kualityforge write-review --artifact-root <path> --input <review.md>
kualityforge synthesize --artifact-root <path>
kualityforge decide --artifact-root <path> --input <decision.md>
kualityforge record-check --artifact-root <path> --name <name> --status <status>
kualityforge verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
kualityforge gate --manifest <path>
kualityforge gate --artifact-root <path>
kualityforge report --artifact-root <path> [--out <dir>|--report-out <dir>] [--html] [--lang <zh|en>]
kualityforge report --input <manifest.json> [--html] [--lang <zh|en>] [--output <file>]
kualityforge kswarm-preview --project-id <id> --run-id <id> --artifact-root <path> --reviewer <runner-id>...
kualityforge kswarm-run --offline --preview <preview.json> --plan <runtime-plan.json> --review <runner-id=review.md>... --decision <decision.md> --check <name=status> [--verify <verify.md> --verifier-runner-id <id>]
kualityforge eval [--corpus <dir>] [--report <path>]
```

`report` 命令渲染人类可读报告，聚合 gate 结果、冻结变更集、findings（F#）、共识 findings（G#）、咨询性 reviewer 评分与归纳候选原则（P#）。支持两种模式：`changeset`（7 个基础章节，适用于 PR/release 评审）和 `full-project`（追加项目概览、R# 评审员详细分析含子维度评分、风险矩阵、行动路线和综合评级，适用于全量代码审计）。输出目录优先级：`--out`/`--report-out` 参数 → `KUALITYFORGE_REPORT_OUT_DIR` 环境变量 → 内置默认值。

`--input <manifest.json>` 形式可从独立 JSON manifest 生成报告，无需完整 artifact root。JSON 文件可包含 `manifest`、`summaryMarkdown`、`scores`、`inducedPrinciples`、`changeset`、`gate`、`reviewType`、`projectOverview`、`reviewerDetails`、`riskMatrix`、`actionPlan` 和 `overallGrade` 字段。这是外部项目使用 KualityForge 报告格式的推荐集成方式，无需采纳完整 artifact workflow。

计划中的公开命令：

```bash
kualityforge run --workflow kswarm
kualityforge adapter codex
kualityforge adapter claude
kualityforge adapter xiaok
```

计划中的测试命令：

```bash
npm run test:kualityforge:unit
npm run test:kualityforge:fixtures
npm run test:kualityforge:golden
npm run test:kualityforge:workflow
npm run test:kualityforge:adapters
npm run test:kualityforge:ci
npm run test:kualityforge:e2e
npm run eval:kualityforge
```

---

## 从 Codex 中调用

今天 Codex 可以直接调用 deterministic gate：

```bash
node /Users/song/projects/kualityforge/src/cli/index.mjs gate \
  --manifest docs/quality/<run-id>/manifest.json
```

长期目标形态是：

```bash
kualityforge run \
  --target . \
  --artifact-root docs/quality/<run-id> \
  --profile release \
  --workflow kswarm
```

Codex 不能在只有单 runner 的情况下宣称完整 KualityForge gate passed。只有独立 reviews、synthesis、human decision、approved-only fix、required checks 和 independent verification 都闭环，才能算完整 gate。

单次 Codex 运行可以记录为 baseline，但不是完成的 multi-agent gate。

如果本地 artifacts 已经存在，Codex 今天可以直接跑 deterministic local workflow：

```bash
kualityforge run \
  --artifact-root docs/quality/<run-id> \
  --run-id <run-id> \
  --profile release \
  --review codex-review.md \
  --review claude-review.md \
  --decision decision.md \
  --check "npm test=passed" \
  --verify verify.md \
  --verifier-runner-id claude:verifier
```

要把编排交给 KSwarm dynamic workflow，Codex 可以先生成 script preview 和 runtime plan：

```bash
kualityforge kswarm-preview \
  --project-id <kswarm-project-id> \
  --run-id <run-id> \
  --artifact-root docs/quality/<run-id> \
  --reviewer codex:gpt-5 \
  --reviewer claude:sonnet \
  --project-root /path/to/project \
  --docs-root /path/to/project/docs \
  --quality-principles /path/to/quality-principles.json \
  --change-goal "按声明的质量 profile 评审本次 release"
```

输出包含：

- `preview`：KSwarm `script_generated` workflow preview，包含稳定的 `scriptHash`、phases、scope 和 fan-out analysis。
- `runtimePlan`：给外部 runtime 使用的 KualityForge 执行计划。它说明如何初始化 artifacts、启动 KSwarm parallel reviewer group、派发 reviewer node、写入 review artifact、synthesize、verify、运行 deterministic gate，并把 gate result 映射回 KSwarm terminal status。

runtime plan 本身不是 gate evidence。reviewer node output 仍然必须写成 KualityForge review artifact，并登记到 `manifest.json`。

如果只想在本地验证 runtime executor，不连接真实 KSwarm service：

```bash
kualityforge kswarm-run --offline \
  --preview preview.json \
  --plan runtime-plan.json \
  --review codex:gpt-5=codex-review.md \
  --review claude:sonnet=claude-review.md \
  --decision decision.md \
  --check "npm test=passed" \
  --verify verify.md \
  --verifier-runner-id claude:verifier
```

`--offline` 使用 in-memory KSwarm client，只用于 contract smoke，不会派发真实 agent。

---

## 文档

项目文档通过软链接放在 `mydocs`：

```text
/Users/song/projects/kualityforge/docs -> ../mydocs/kualityforge
```

主要入口：

- [文档首页](docs/README.md)
- [Artifact Protocol](docs/protocol.md)
- [项目启动设计](docs/design/2026-06-01-kualityforge-project-bootstrap-design.md)
- [KSwarm dynamic workflow integration](docs/design/2026-06-02-kswarm-dynamic-workflow-integration.md)
- [KSwarm dynamic workflow adversarial review](docs/design/2026-06-02-kswarm-dynamic-workflow-integration-adversarial-review.md)
- [KSwarm runtime executor design](docs/design/2026-06-02-kswarm-runtime-executor-design.md)
- [KSwarm runtime executor adversarial review](docs/design/2026-06-02-kswarm-runtime-executor-adversarial-review.md)
- [质量记录](docs/quality/README.md)
- [Eval 记录](docs/evals/README.md)

报告模板规范随仓库一起追踪（不在 `docs` symlink 下），用户可据此撰写报告：

- [报告模板规范](templates/report-template.md)

---

## 开发规则

见：

- [AGENTS.md](AGENTS.md)
- [CLAUDE.md](CLAUDE.md)

关键规则：

- 新行为先写设计文档。
- 高风险 core 行为需要对抗性评审。
- 先写测试，再改 production code。
- KualityForge core 必须保持项目无关。
- 项目特定 release policy 放在 policy/profile 文件里，不硬编码进 reducer。
