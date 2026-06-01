# kualityfore

> KualityFore 是一个 artifact-first 的多智能体质量门禁系统。它把模型评审、人类决策、修复、验证、测试和 eval 证据整理成可审计、可复现、可被 CI / ship 阻断使用的确定性质量门禁。

一个面向多 Agent 软件交付的本地质量门禁核心，而不是又一个单 Agent code review 脚本。

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 当前状态

KualityFore 还在项目启动阶段。当前仓库已经包含第一片 deterministic gate reducer：

- `manifest.json` / policy schema 草案。
- `kualityfore init --artifact-root <path> --run-id <id>` CLI 入口。
- `kualityfore gate --manifest <path>` 和 `kualityfore gate --artifact-root <path>` CLI 入口。
- 通过 `kualityfore write-review` 写入 review artifact。
- 通过 `kualityfore synthesize` 生成 summary。
- human decision、required check、verification 的记录命令。
- 通过 `kualityfore eval` 执行 deterministic eval。
- 通过 `kualityfore run` 串起本地 artifact workflow。
- artifact reference validation 会拒绝绝对路径和 `..` traversal。
- 对证据不完整的质量运行执行 fail-closed reducer。
- 覆盖通过、reviewer 不足、manifest 无效、verifier 不独立等 case 的 unit tests。
- 覆盖 artifact-root 初始化、synthesis 输出、eval 和 clean passing run 的 fixture、golden、CI、E2E tests。
- 通过 `docs -> ../mydocs/kualityfore` 维护项目文档。

真实多 Agent runner dispatch 和 KSwarm 编排会在 deterministic core 之后接入。当前本地 `run` 命令只消费已经生成的 artifacts，不调用模型。

---

## 为什么需要 KualityFore

AI coding workflow 已经能很快生成代码，但 release confidence 仍然容易停留在“某个模型说看过了”或者“一段 chat transcript 看起来没问题”。KualityFore 的前提更严格：

**质量门禁只有在证据完整、结构化、独立可验证、可复现时才能通过。**

它参考 Viking `review-forge` 的 review / synthesize / fix / verify 循环，但目标是把这个思路扩展成通用质量门禁基础设施：

- 多个 reviewer 可以独立检查同一目标。
- synthesis 合并发现，同时保留分歧。
- human decision gate 决定哪些 finding 被批准修复。
- fixer 只能修复已批准 finding。
- independent verification 验证修复是否真的覆盖批准范围。
- 项目 required checks 和 eval baseline 进入 release evidence。
- CI / ship workflow 消费确定性的 gate result，而不是阅读自然语言判断。

KualityFore 不是 xiaok 专用功能。它的 core 通过 CLI、artifact 目录和 policy 文件为任意项目提供质量门禁。

---

## 关键设计思想

### 1. Artifact-First Quality

KualityFore 把文件作为质量事实来源。review、synthesis、human decision、fix plan、required checks、verify report 和最终 gate status 都写入一次 run 的 artifact 目录。

这样有三个直接收益：

- 模型 session 结束后仍然可以审计。
- 其他工具可以 resume 或重新 reduce。
- CI 不需要让模型重新解释 chat history。

目标 artifact 结构：

```text
docs/quality/<run-id>/
  manifest.json
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

### 2. Reviewer 可以不确定，Gate 必须确定

模型 reviewer 可以是概率性的；gate reducer 不可以。

给定同一份 manifest、policy 和 artifacts，`kualityfore gate` 必须总是返回同样的 status、reasons 和 exit code。这样 release automation 才不会因为某次模型输出波动而改变基础门禁判断。

当前 gate status 刻意保守：

- `passed`：所有要求的证据都存在且已验证。
- `incomplete`：证据缺失或 finding 未闭环。
- `failed`：存在终态失败或 blocking condition。
- `invalid_artifact`：manifest 或 artifact shape 不可信。

### 3. Fail Closed

KualityFore 不应该把缺证据解释成通过。release profile 下，以下任一项缺失或无效都不能 passed：

- reviewer 数量。
- human decision artifact。
- required checks。
- verification artifact。
- 独立 verifier identity。
- 合法 manifest shape。
- finding resolution status。

这是有意的偏置。一个偶尔阻断过多的质量门禁可以调参；一个默默放过不完整证据的门禁不能被信任。

### 4. Human Decision 是修复边界

AI reviewer 可以发现问题，但不应该单方面决定改什么。KualityFore 保持一条硬边界：

- 未勾选 finding 不能进入 fix queue。
- `wont_fix` 和 `risk_accepted` 必须留下明确 decision record。
- fix artifact 不能悄悄覆盖未批准 finding。
- verification 验证的是批准范围，不是笼统地说“都好了”。

这让人类判断保留在关键位置，同时把 review、fix 和 verify 的证据链自动化。

### 5. 独立验证

release profile 下，fixer 和 verifier 必须是不同 runner identity。一个模型或 agent 不应该既修复问题，又作为唯一证据证明自己的修复有效。

第一版在 manifest 层检查这个约束。后续接入 KSwarm 后，会在 workflow scheduling 层也强制执行。

### 6. KSwarm 编排，KualityFore 判门禁

KualityFore 不持有 durable workflow execution。这个职责属于 KSwarm。

边界是：

- KualityFore 负责 schema、artifact parsing、reducer、CLI gate、tests、fixtures 和 eval。
- KSwarm 负责 `kualityfore-flow`：fan-out、retry、resume、cancel、decision gate 和 node scheduling。
- Intent Broker 负责 runner dispatch 和 event correlation。
- xiaok 负责 desktop / CLI 入口和用户可见状态。

这样 gate core 才能在 xiaok 之外、KSwarm 之外也能独立使用。

### 7. Eval 是产品的一部分

KualityFore 自己必须被测试和评估。质量门禁系统不能只靠几次真实项目跑通来证明可靠。

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
kualityfore/
  src/
    cli/
      index.mjs
    core/
      gate-reducer.mjs
    index.mjs
  schemas/
    manifest.schema.json
    policy.schema.json
  tests/
    kualityfore/
      unit/
      fixtures/
      golden/
      workflow/
      adapters/
      ci/
      e2e/
  evals/
    kualityfore/
      corpus/
      reports/
  docs -> ../mydocs/kualityfore
```

---

## 快速开始

运行测试：

```bash
cd /Users/song/projects/kualityfore
npm test
```

用当前 CLI 检查一份 manifest：

```bash
node src/cli/index.mjs gate --manifest path/to/manifest.json
```

本地 link 后：

```bash
cd /Users/song/projects/kualityfore
npm link
```

命令形态会变成：

```bash
kualityfore gate --manifest path/to/manifest.json
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
kualityfore init --artifact-root <path> --run-id <id> [--profile <name>]
kualityfore run --artifact-root <path> --run-id <id> --review <review.md>... --decision <decision.md> --check <name=status> --verify <verify.md> --verifier-runner-id <id>
kualityfore write-review --artifact-root <path> --input <review.md>
kualityfore synthesize --artifact-root <path>
kualityfore decide --artifact-root <path> --input <decision.md>
kualityfore record-check --artifact-root <path> --name <name> --status <status>
kualityfore verify --artifact-root <path> --runner-id <id> --status <status> --input <verify.md>
kualityfore gate --manifest <path>
kualityfore gate --artifact-root <path>
kualityfore eval [--corpus <dir>] [--report <path>]
```

计划中的公开命令：

```bash
kualityfore run --workflow kswarm
kualityfore adapter codex
kualityfore adapter claude
kualityfore adapter xiaok
```

计划中的测试命令：

```bash
npm run test:kualityfore:unit
npm run test:kualityfore:fixtures
npm run test:kualityfore:golden
npm run test:kualityfore:workflow
npm run test:kualityfore:adapters
npm run test:kualityfore:ci
npm run test:kualityfore:e2e
npm run eval:kualityfore
```

---

## 从 Codex 中调用

今天 Codex 可以直接调用 deterministic gate：

```bash
node /Users/song/projects/kualityfore/src/cli/index.mjs gate \
  --manifest docs/quality/<run-id>/manifest.json
```

长期目标形态是：

```bash
kualityfore run \
  --target . \
  --artifact-root docs/quality/<run-id> \
  --profile release \
  --workflow kswarm
```

Codex 不能在只有单 runner 的情况下宣称完整 KualityFore gate passed。只有独立 reviews、synthesis、human decision、approved-only fix、required checks 和 independent verification 都闭环，才能算完整 gate。

单次 Codex 运行可以记录为 baseline，但不是完成的 multi-agent gate。

如果本地 artifacts 已经存在，Codex 今天可以直接跑 deterministic local workflow：

```bash
kualityfore run \
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

---

## 文档

项目文档通过软链接放在 `mydocs`：

```text
/Users/song/projects/kualityfore/docs -> ../mydocs/kualityfore
```

主要入口：

- [文档首页](docs/README.md)
- [项目启动设计](docs/design/2026-06-01-kualityfore-project-bootstrap-design.md)
- [质量记录](docs/quality/README.md)
- [Eval 记录](docs/evals/README.md)

---

## 开发规则

见：

- [AGENTS.md](AGENTS.md)
- [CLAUDE.md](CLAUDE.md)

关键规则：

- 新行为先写设计文档。
- 高风险 core 行为需要对抗性评审。
- 先写测试，再改 production code。
- KualityFore core 必须保持项目无关。
- 项目特定 release policy 放在 policy/profile 文件里，不硬编码进 reducer。
