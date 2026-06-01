# CLAUDE.md

## 规则优先级

- 先阅读并遵守 `AGENTS.md`。它包含本项目的通用协作规则：中文回复、设计先行、对抗性评审、测试顺序、相关项目边界、`docs` symlink 规则和 KualityForge core 边界。
- 本文件是 Claude 专用补充。KualityForge 当前重心是 deterministic core，不是 KSwarm workflow executor、xiaok desktop UI 或 live model runner。
- 如果规则有重叠：项目级流程以 `AGENTS.md` 为准；KualityForge artifact / reducer / gate / eval 边界以本文件和 `docs/design/**` 为准。

## 当前重心

当前优先关注：

- manifest / policy schema。
- artifact parser。
- finding reducer。
- gate reducer。
- CLI gate。
- fixture / golden tests。
- deterministic eval corpus 和 baseline。

不要把 KSwarm dynamic workflow、intent-broker runner dispatch、xiaok desktop UI 当成默认实现路径。那些是集成层，KualityForge core 只定义协议、规则、reducer、CLI 和 eval。

## 设计文档入口

- 设计文档总入口以 `docs/README.md` 为准。
- 当前启动设计：
  - `docs/design/2026-06-01-kualityforge-project-bootstrap-design.md`
- 如果任务涉及从 xiaok-cli 的早期 ReviewForge 设计迁移，应同时参考：
  - `/Users/song/projects/mydocs/xiaok-cli/design/2026-06-01-kswarm-reviewforge-quality-gates-design.md`
  - `/Users/song/projects/mydocs/xiaok-cli/design/2026-06-01-kswarm-reviewforge-quality-gates-adversarial-review.md`
- 不要依赖 section 编号本身。优先引用文件路径和 heading；section 编号会随文档演进漂移。

## Core 架构边界

### Artifact Protocol

- artifact protocol 是 KualityForge 的核心事实来源。
- `manifest.json`、review artifacts、summary、human decision、fix plan、verify report 必须能被 deterministic parser / reducer 消费。
- markdown 可以面向人读，但 gate 不能只靠脆弱文本片段判断状态；关键字段必须进入结构化 manifest 或可验证的结构化块。
- artifact path 必须限制在 artifact root 内，禁止 absolute path escape、`..` traversal 和 symlink escape。

### Gate Reducer

- reducer 必须是纯 deterministic 逻辑：相同 manifest / policy / artifacts 得到相同 result。
- reducer 不调用模型、不访问网络、不读写 product code。
- gate result 必须包含 machine-readable status、exit code、reasons。
- release profile 默认 fail closed。缺 reviewer、缺 human decision、缺 verification、required checks 未通过、manifest 无效、runner identity 不满足隔离时，不得 passed。
- reviewer agreement 只能提升 confidence，不能替代 severity 判断。单 reviewer high severity finding 也必须进入 human decision。

### Human Decision

- human decision 是 fix 的授权边界。
- 未 checked 的 finding 不能进入 fix queue。
- `wont_fix` / `risk_accepted` 必须保留 owner、rationale、必要时 expiry 或 linked decision。
- 自动 fixer 不得修改 reviewer artifacts、summary 原始证据或 unchecked finding 对应范围。

### Verification

- verifier 必须独立于 fixer。
- release profile 不允许同一 runner 自修自验。
- verification artifact 必须说明验证范围、证据和未覆盖风险。
- `test_blocked` 必须区分 host limitation、product bug suspected、packaging limitation，不能被当作 passed。

### Eval

- deterministic eval 使用 fixture artifacts 和 golden expected result，是 CI / PR 的可靠基础。
- model-assisted eval 使用真实 Codex / Claude Code / xiaok runner，只作为模型质量和 prompt 质量信号。
- eval corpus 中的 ground truth 不应直接暴露给 reviewer prompt。
- adversarial eval 必须覆盖伪造 manifest、path traversal、status conflict、unchecked fix、runner id 冒用。

## Claude 工作方式

当 Claude 在本项目工作时：

1. 先确认任务触及的是 core、KSwarm integration、intent-broker adapter、xiaok integration、docs 还是 eval。
2. core 行为变更先读或更新设计文档。
3. 高风险行为先写对抗性评审。
4. 先写 unit / fixture / golden test，再改 production code。
5. 改完后按风险跑 focused tests。
6. 最终说明要区分已完成验证和未跑验证。

不要做这些事：

- 不要把 xiaok-cli release profile 硬编码到 KualityForge core。
- 不要让 live model output 成为 gate reducer 的唯一证据。
- 不要用同一个 runner 同时 fix 和 verify 并宣称 release passed。
- 不要让 CI gate 依赖实时模型可用性。
- 不要在没有 fixture 的情况下修改 reducer 判断。
- 不要把 `kswarm` workflow 执行状态混入 manifest reducer 纯逻辑。

必须做这些事：

- 新增状态、schema 字段、exit code 时同步更新 tests 和 docs。
- 新增 artifact 类型时明确 owner、路径、结构化字段和 parser 行为。
- 新增 eval 指标时说明 ground truth 来源和失败阈值。
- 发现单 runner baseline 时明确标注为 baseline，不宣称完成 multi-agent KualityForge gate。

## 常用验证

按改动范围选择最小但充分的验证：

- core reducer / schema / parser：

```bash
npm test
npm run test:kualityforge:unit
```

- fixture / golden：

```bash
npm run test:kualityforge:fixtures
```

- KSwarm workflow contract：

```bash
npm run test:kualityforge:workflow
```

- runner adapter contract：

```bash
npm run test:kualityforge:adapters
```

- CI gate：

```bash
npm run test:kualityforge:ci
```

- E2E smoke：

```bash
npm run test:kualityforge:e2e
```

- deterministic eval：

```bash
npm run eval:kualityforge
```

`model-assisted eval` 不作为普通 PR 必跑项：

```bash
npm run eval:kualityforge:model-assisted
```

## 完成标准

KualityForge core 改动只有在这些条件满足后才能认为完成：

- 设计、对抗性评审、测试顺序没有被跳过。
- manifest / policy / artifact 行为有对应测试。
- gate reducer fail-closed 行为被覆盖。
- exit code 和 JSON 输出可被 CI / ship 消费。
- 没有把项目特定规则写死到 core。
- 没有新增 live model 依赖作为 deterministic gate 前提。
- 已说明跑过哪些验证，没跑的高价值验证必须说明原因。
