# CLAUDE.md

## 规则优先级

- 先阅读并遵守 `AGENTS.md`。它包含本项目的通用协作规则：中文回复、设计先行、对抗性评审、测试顺序、相关项目边界、`docs` symlink 规则和 KualityForge core 边界。
- 本文件是 Claude 专用补充。KualityForge 当前重心是 deterministic core + report rendering，不是 KSwarm workflow executor、xiaok desktop UI 或 live model runner。
- 如果规则有重叠：项目级流程以 `AGENTS.md` 为准；KualityForge artifact / reducer / gate / eval / report 渲染边界以本文件和 `docs/design/**` 为准。

## 当前重心

当前优先关注：

- manifest / policy schema。
- artifact parser。
- finding reducer。
- gate reducer。
- CLI gate。
- report rendering engine（`report.mjs`）：纯渲染、无 IO、双模式、双语。
- `report --input` 独立报告生成。
- fixture / golden tests。
- deterministic eval corpus 和 baseline。

不要把 KSwarm dynamic workflow、intent-broker runner dispatch、xiaok desktop UI 当成默认实现路径。那些是集成层，KualityForge core 只定义协议、规则、reducer、CLI 和 eval。

## 设计文档入口

- 设计文档总入口以 `docs/README.md` 为准，不在本文件重复维护完整清单。
- 改动优先搜索并读取 `docs/design/**`、`docs/quality/**`、`docs/evals/**` 中最近、最贴近当前任务的设计和对抗性评审。
- 常见入口包括：
  - `docs/design/2026-06-01-kualityforge-project-bootstrap-design.md`
  - `docs/design/2026-06-02-kswarm-dynamic-workflow-integration.md`
  - `docs/design/2026-06-02-kswarm-dynamic-workflow-integration-adversarial-review.md`
  - `docs/design/2026-06-02-kswarm-runtime-executor-design.md`
  - `docs/design/2026-06-02-kswarm-runtime-executor-adversarial-review.md`
- 如果任务涉及从 xiaok-cli 的早期 ReviewForge 设计迁移，应同时参考：
  - `/Users/song/projects/mydocs/xiaok-cli/design/2026-06-01-kswarm-reviewforge-quality-gates-design.md`
  - `/Users/song/projects/mydocs/xiaok-cli/design/2026-06-01-kswarm-reviewforge-quality-gates-adversarial-review.md`
- 不要依赖 section 编号本身。优先引用文件路径和 heading；section 编号会随文档演进漂移。
- 报告结构以 `templates/report-template.md` 为准，不在设计文档中重复定义章节顺序和编号体系。

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

### Report Rendering

- `report.mjs` 是纯渲染模块：不读写文件、不访问网络、不调用模型、只依赖 Node 标准库。
- 所有渲染通过 `buildReportModel` 构建数据模型，再经 `renderReportMarkdown` / `renderReportHtml` 输出。新增渲染能力必须走这条路径，不要绕过 model 在 renderer 里拼字符串。
- 双报告模式由 `reviewType` 字段控制：
  - `changeset`（默认）：7 个基础章节。
  - `full-project`：追加项目概览、R# 评审员详细分析、风险矩阵、行动路线、综合评级。
- 报告结构以 `templates/report-template.md` 为准；渲染输出必须与模板规范一致。
- 新增用户可见文本必须同时提供 zh/en 双语标签。
- HTML 报告使用内联 CSS，不依赖外部样式表或运行时资源加载。

### CLI

- CLI（`src/cli/index.mjs`）是薄路由层：解析参数、调用 core 模块、输出结果。
- IO 操作（读写文件、目录创建）只在 CLI 层和 `artifact-operations.mjs` 中发生，不进入 `report.mjs` 或 `gate-reducer.mjs`。
- `report --input <manifest.json>` 从独立 JSON 生成报告，不要求完整 artifact root。这是外部集成的推荐入口。
- `report --artifact-root <path>` 从完整 artifact 目录生成报告，消费已存在的 artifacts。
- 两种报告路径的渲染逻辑必须一致；不要为 `--input` 维护单独的渲染分支。

### Eval

- deterministic eval 使用 fixture artifacts 和 golden expected result，是 CI / PR 的可靠基础。
- model-assisted eval 使用真实 Codex / Claude Code / xiaok runner，只作为模型质量和 prompt 质量信号。
- eval corpus 中的 ground truth 不应直接暴露给 reviewer prompt。
- adversarial eval 必须覆盖伪造 manifest、path traversal、status conflict、unchecked fix、runner id 冒用。

## 变更门禁

修改 KualityForge 前，按这个顺序过 gate：

1. **确认改动层级**
   - gate reducer / artifact parser / report rendering / CLI / eval / KSwarm integration / docs。
   - 如果跨越两层以上，按高风险改动处理。

2. **确认事实来源**
   - 哪个模块拥有状态？
   - manifest 是事实来源，还是 `--input` JSON 是事实来源？
   - report rendering 的数据模型是 `buildReportModel` 的返回值。
   - gate 结果是 reducer 的纯函数输出，不依赖运行时状态。

3. **确认 contract**
   - manifest / policy schema 字段是否变化？
   - CLI 命令、flag、输出格式是否变化？
   - report rendering 输出结构是否变化？
   - `--input` JSON schema 是否变化？（外部集成依赖此接口稳定）
   - 旧 manifest、旧 policy、旧 artifact 是否还能正确解析？

4. **确认测试层级**
   - core reducer / parser：`tests/kualityforge/unit/`
   - report rendering：`tests/kualityforge/unit/report.test.mjs`
   - fixture / golden：`tests/kualityforge/fixtures/`、`tests/kualityforge/golden/`
   - KSwarm workflow contract：`tests/kualityforge/workflow/`
   - runner adapter contract：`tests/kualityforge/adapters/`
   - CI gate：`tests/kualityforge/ci/`
   - E2E smoke：`tests/kualityforge/e2e/`
   - deterministic eval：`evals/kualityforge/`

5. **实现并验证**
   - 先补 focused test，再改生产代码。
   - 对高风险改动，设计、对抗性评审、测试、生产代码的顺序不能跳过。

## 硬规则

不要做这些事：

- 不要把 xiaok-cli release profile 硬编码到 KualityForge core。
- 不要让 live model output 成为 gate reducer 的唯一证据。
- 不要用同一个 runner 同时 fix 和 verify 并宣称 release passed。
- 不要让 CI gate 依赖实时模型可用性。
- 不要在没有 fixture 的情况下修改 reducer 判断。
- 不要把 `kswarm` workflow 执行状态混入 manifest reducer 纯逻辑。
- 不要在 `report.mjs` 中引入 IO（文件读写、网络请求、child_process）。
- 不要为 `--input` 和 `--artifact-root` 维护两套渲染逻辑。
- 不要在报告渲染中硬编码 zh 标签而不提供 en 对应。
- 不要修改 `--input` JSON schema 而不标注 breaking change。

必须做这些事：

- 新增状态、schema 字段、exit code 时同步更新 tests 和 docs。
- 新增 artifact 类型时明确 owner、路径、结构化字段和 parser 行为。
- 新增 eval 指标时说明 ground truth 来源和失败阈值。
- 发现单 runner baseline 时明确标注为 baseline，不宣称完成 multi-agent KualityForge gate。
- 新增报告章节或字段时同步更新 `report.mjs`（两个 renderer）和 `templates/report-template.md`。
- 新增用户可见文本时同时提供 zh/en 双语标签。
- 修改 `buildReportModel` 字段形状时先补 `report.test.mjs`。

## Claude 工作方式

当 Claude 在本项目工作时：

1. 先确认任务触及的是 core reducer、report rendering、CLI、KSwarm integration、intent-broker adapter、xiaok integration、docs 还是 eval。
2. core 行为变更先读或更新设计文档。
3. 高风险行为先写对抗性评审。
4. 先写 unit / fixture / golden test，再改 production code。
5. 改完后按风险跑 focused tests。
6. 最终说明要区分已完成验证和未跑验证。

## Report 渲染专项规则

以下规则只适用于 `src/core/report.mjs` 和直接相关的测试文件：

- `report.mjs` 是纯函数模块。所有函数必须是 `export function`，不接受 callback，不返回 Promise，不修改外部状态。
- 所有渲染数据通过 `buildReportModel` 统一构建。renderer 函数只消费 model，不自行组装数据。
- 新增报告章节必须同时更新 `renderReportMarkdown` 和 `renderReportHtml`，并同步更新 `templates/report-template.md`。
- full-project 模式新增的章节通过 `if (model.reviewType === "full-project")` 条件渲染；changeset 模式不得渲染这些章节。
- HTML 输出使用内联 CSS，不依赖外部样式表。新增样式必须在 `renderReportHtml` 的 `<style>` 块中定义。
- full-project 模式的 R# 评审员详细分析在 HTML 中使用 `<details>` 折叠，默认折叠。
- 所有用户可见标签（章节标题、表头、状态文本）必须同时提供 zh/en 版本，通过 `lang` 参数切换。

## 常用验证

按改动范围选择最小但充分的验证：

- core reducer / schema / parser：

```bash
npm test
npm run test:kualityforge:unit
```

- report rendering：

```bash
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

- 手动验证 report 输出：

```bash
node src/cli/index.mjs report --input <manifest.json> --html --lang zh --output /tmp/kf-report.html
open /tmp/kf-report.html
```

## 完成标准

KualityForge core 改动只有在这些条件满足后才能认为完成：

- 设计、对抗性评审、测试顺序没有被跳过。
- manifest / policy / artifact 行为有对应测试。
- gate reducer fail-closed 行为被覆盖。
- report rendering 两个 renderer（Markdown + HTML）都已更新并通过测试。
- `--input` JSON schema 如果变化，已标注 breaking change。
- exit code 和 JSON 输出可被 CI / ship 消费。
- 没有把项目特定规则写死到 core。
- 没有新增 live model 依赖作为 deterministic gate 前提。
- 报告结构变更已同步到 `templates/report-template.md`。
- 已说明跑过哪些验证，没跑的高价值验证必须说明原因。
