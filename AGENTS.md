# Repo Notes

## 语言

- 始终使用中文回复。

## 相关项目

- `kualityforge` 关联项目都在 `/Users/song/projects/` 下：
  - `kswarm`：负责 `kualityforge-flow` dynamic workflow 编排，包括 reviewer fan-out、task retry、resume、cancel、human decision gate、fix / verify 节点调度和 run state 持久化。
  - `intent-broker`：负责本地 agent / runner 注册、participant identity、任务投递、artifact completion event、decision / approval 事件和跨 agent 协作通信。
  - `xiaok-cli`：负责 desktop / CLI 入口、release / ship 集成、KualityForge run 状态展示和用户交互。
  - `mydocs`：负责 `kualityforge` 文档、设计记录、质量记录和 eval 报告。`kualityforge/docs` 必须软链接到 `/Users/song/projects/mydocs/kualityforge`。
- 修改 KualityForge workflow、runner contract、artifact handoff、review/fix/verify 状态机时，优先检查 `kswarm` 是否也需要改。
- 修改 agent 协作、runner dispatch、event correlation、participant identity、approval / decision 流程时，优先检查 `intent-broker` 是否也需要改。
- 修改 xiaok desktop / CLI 入口、release gate、UI 展示、ship 集成时，优先检查 `xiaok-cli` 是否也需要改。
- 提交代码时，相关项目如果有配套改动也要一起提交；如果只提交其中一部分，必须在最终说明里写清楚原因。

## 项目定位

- `kualityforge` 是通用质量门禁核心项目。
- 不把 KSwarm dynamic workflow、xiaok desktop UI、intent-broker runner dispatch 的实现混入 core。
- core 只负责 artifact protocol、schema、parser、gate reducer、CLI、fixtures、eval corpus 和 CI 可调用的确定性判断。
- KualityForge 参考 Viking `review-forge` 的多模型 review / synthesize / fix / verify 思路，但不是项目私有 skill；它要成为跨项目可复用、CI / ship 可调用的质量门禁基础设施。

## 关联项目集成联动

- `xiaok-cli` 通过 CLI 调用 KualityForge：
  - `kualityforge report --input <manifest.json> --html` 生成报告。xiaok 把评审结果序列化为 JSON manifest，调用 KualityForge CLI 输出 HTML，不需要引入 KualityForge 代码。
  - `kualityforge gate --artifact-root <path>` 判断 gate 结果。xiaok desktop 通过 CLI 获取 exit code 和 JSON 输出。
  - 修改 KualityForge CLI 接口（命令、flag、输出格式）时，优先检查 xiaok-cli 的调用方是否需要同步。
- `kswarm` 通过 `kualityforge-flow` contract 集成：
  - KualityForge 生成 `script_generated` workflow preview 和 runtime plan；KSwarm 消费这些结构执行编排。
  - 修改 preview / runtime plan schema 时，优先检查 kswarm 的 `kualityforge-flow` template 是否需要同步。
  - `kswarm-run --offline` 使用 in-memory KSwarm client，只用于 contract smoke；live 集成在 kswarm 侧。
- `intent-broker` 通过 runner identity 和 event 集成：
  - runner identity（`codex:gpt-5`、`claude:sonnet`、`xiaok`）同时是 KualityForge manifest 的 reviewer identity 和 intent-broker 的 participant identity。
  - 修改 runner identity 规则或 verifier independence 判断时，优先检查 intent-broker 的 participant contract。
- 改 KualityForge 后，至少在 `/Users/song/projects/kualityforge` 跑与改动相关的测试：
  ```bash
  npm test
  ```
  如果改了 report rendering 或 full-project 模式，还需要：
  ```bash
  npm run test:kualityforge:unit
  ```
  如果改了 KSwarm preview / runtime plan schema，到 `/Users/song/projects/kswarm` 检查 `kualityforge-flow` template 是否需要同步更新。
- 只要 KualityForge CLI 接口改动会进入 xiaok desktop 的调用路径，回到 `/Users/song/projects/xiaok-cli` 后还要验证 xiaok 的 KualityForge 调用方不受影响。

## 当前重心

- 当前重心是 deterministic core + report rendering：
  - manifest / policy schema。
  - artifact parser。
  - finding reducer。
  - gate reducer。
  - CLI `kualityforge gate`。
  - report rendering engine（`report.mjs`）：纯渲染，无 IO，只依赖 Node 标准库。
  - 双报告模式：`changeset`（7 个基础章节）和 `full-project`（追加项目概览、R# 评审员详细分析、风险矩阵、行动路线、综合评级）。
  - `report --input <manifest.json>` 独立报告生成模式。
  - fixture / golden tests。
  - deterministic eval baseline。
  - 构建/install/部署脚本安全作为推荐评审维度。
- 第一阶段不要实现 desktop UI、真实模型 runner、GitHub Actions 发布集成或完整 KSwarm workflow executor。
- 可以先定义与 KSwarm / intent-broker 对接的 contract，但不要把编排实现塞进 core。

## 文档

- 本项目的 `docs` 是软链接，指向 `/Users/song/projects/mydocs/kualityforge`。
- 设计文档、质量记录、eval 报告说明默认写到 `docs/**`，也就是实际写入 `mydocs/kualityforge/**`。
- 不要把项目文档只写在 README 里；README 只放入口和运行说明。
- 设计文档入口：
  - `docs/README.md`
  - `docs/design/2026-06-01-kualityforge-project-bootstrap-design.md`
- KSwarm 集成相关改动还要读取：
  - `docs/design/2026-06-02-kswarm-dynamic-workflow-integration.md`
  - `docs/design/2026-06-02-kswarm-dynamic-workflow-integration-adversarial-review.md`
  - `docs/design/2026-06-02-kswarm-runtime-executor-design.md`
  - `docs/design/2026-06-02-kswarm-runtime-executor-adversarial-review.md`
- 报告模板规范不在 `docs` symlink 下，随仓库追踪：
  - `templates/report-template.md`
- 如果从 `xiaok-cli` 的早期 ReviewForge 设计迁移内容，优先保持语义一致，不要复制 xiaok-cli release profile 作为 core 默认规则。

## 实现门禁

- 新需求或行为变更先写设计文档。
- 实现前先做对抗性评审。
- 评审后先写测试，再写 production code。
- KualityForge 自身必须有 unit、fixture、workflow、adapter、CI、E2E、eval 分层验证。
- 只有 docs、adversarial review、tests 都到位后，才开始修改 production code。
- 核心/高风险改动强制执行方案 + 对抗性评审，不可跳过：
  - manifest / policy schema。
  - artifact parser。
  - gate reducer。
  - finding merge / severity ranking。
  - status transition。
  - runner identity / verifier independence。
  - path validation / artifact root。
  - CI exit code。
  - eval scoring / ground truth corpus。
  - report.mjs 渲染逻辑（纯函数、确定性输出）。
  - buildReportModel 字段形状变更。
  - 报告模式变更（changeset vs full-project 新增章节）。
  - CLI `--input` schema 变更（外部集成依赖此接口稳定）。
- 对抗性评审重点：边界条件、伪造 artifact、path traversal、manifest / markdown drift、未批准 finding 被修复、runner identity 冒用、测试 blocked 被误判通过、live model 波动污染 deterministic gate、报告渲染输出不一致。

## 边界

- `kswarm`：只放 `kualityforge-flow` workflow template、fan-out、retry、resume、cancel 等编排。
- `intent-broker`：只放 runner dispatch、event correlation、participant identity 等协作协议。
- `xiaok-cli`：只放入口、展示、ship/release 集成。
- `kualityforge`：保持可被任意项目独立调用，不硬编码 xiaok-cli release 规则。

## Report 渲染架构

- `src/core/report.mjs` 是纯渲染模块：不读写文件、不访问网络、不调用模型、只依赖 Node 标准库。
- 所有渲染通过 `buildReportModel` 构建数据模型，再经 `renderReportMarkdown` / `renderReportHtml` 输出。
- 双报告模式由 `reviewType` 字段控制：
  - `changeset`（默认）：7 个基础章节，适用于 PR/release 评审。
  - `full-project`：追加项目概览、R# 评审员详细分析、风险矩阵、行动路线、综合评级，适用于全量代码审计。
- 报告结构以 `templates/report-template.md` 为准；`report.mjs` 的渲染输出必须与模板规范一致。
- 新增用户可见文本必须同时提供 zh/en 双语标签。
- `buildReportModel` 接受的字段形状变更视为接口变更，需要同步更新 tests 和 template spec。

## 外部集成模式

- `kualityforge report --input <manifest.json>` 是外部项目集成的推荐方式。
- 外部项目只需提供一份 JSON manifest，KualityForge CLI 生成 HTML/Markdown 报告，无需引入 KualityForge 代码或 artifact workflow。
- JSON manifest 可包含：`manifest`、`summaryMarkdown`、`scores`、`inducedPrinciples`、`changeset`、`gate`、`reviewType`、`projectOverview`、`reviewerDetails`、`riskMatrix`、`actionPlan`、`overallGrade`。
- 这个接口需要保持稳定；字段形状变更视为 breaking change。
- 外部项目如果需要更深集成（artifact workflow、KSwarm 编排），应使用 `kualityforge init` / `gate` / `run` 等 CLI 命令，不走 `--input` 快捷路径。

## Core 架构规则

- artifact protocol 是事实来源；CLI / CI / KSwarm / xiaok UI 都只能读取或生成符合协议的结构化 artifacts。
- reducer 必须 deterministic：相同 manifest、policy、artifacts 必须得到相同 gate result 和 exit code。
- gate 必须 fail closed：缺 reviewer、缺 human decision、缺 required checks、缺 verification、manifest 无效、artifact 冲突时不得返回 passed。
- human decision 是 fix 的边界：unchecked / deferred / wont_fix / risk_accepted finding 不得进入自动 fix queue。
- verifier 必须独立于 fixer；release profile 不允许同一 runner 自修自验。
- model-assisted eval 是质量信号，不能替代 deterministic unit / fixture / reducer tests。
- CI mode 默认不依赖 live model availability；CI gate 消费已生成 artifacts 或 deterministic fixtures。
- 不把 xiaok-cli 的 release 检查硬编码到 core；项目特定规则通过 policy/profile 注入。

## 跨平台兼容

以下规则适用于 KualityForge CLI 和 report rendering。

- 路径拼接必须用 `path.join` / `path.resolve`，禁止硬编码 `/` 或 `\` 分隔符。
- 禁止对 `os.homedir()`、config dir、temp dir 的结果做字符串拼接 `/`；一律用 `path.join`。
- CLI 必须在 macOS、Windows、Linux 上正常工作；artifact path 和 manifest path 处理不能假设 Unix 语义。
- 文件路径比较和去重必须考虑大小写（Windows 默认 case-insensitive）和盘符（`C:\` vs `/`）。
- report.mjs 的渲染输出不依赖平台；HTML 报告的 CSS 和字符编码必须跨平台一致。
- 已知历史教训：artifact reference validation 必须同时拒绝绝对路径和 `..` traversal，不能只检查 Unix 风格。

## Worktrees

- 当前没有 active worktree。
- 本地验证 `kualityforge` 命令必须使用主工作区 `/Users/song/projects/kualityforge`；不要 `npm link` feature worktree。
- 如果后续确实需要 worktree，只为隔离实现创建，并在集成后移除。

## 测试与 Eval

- 基础验证：
  ```bash
  npm test
  npm run test:kualityforge:unit
  ```
- 后续完整 KualityForge 自身 gate 应包含：
  ```bash
  npm run test:kualityforge:unit
  npm run test:kualityforge:fixtures
  npm run test:kualityforge:workflow
  npm run test:kualityforge:adapters
  npm run test:kualityforge:ci
  npm run test:kualityforge:e2e
  npm run eval:kualityforge
  ```
- `npm run eval:kualityforge:model-assisted` 只能作为 release 前或 nightly 信号；不要让它成为 PR 必跑的唯一质量证据。
- 新增 reducer / parser / schema 行为必须先补 fixture 或 unit test。
- 新增 report rendering 行为必须先补 report.test.mjs。
- 修复 bug 优先补复现 fixture；不要只改 reducer 让当前 case 通过。

## 代码风格

- 默认使用 Node.js ESM。
- 第一阶段尽量使用 Node 标准库，避免过早引入运行时依赖。
- report.mjs 必须保持纯渲染：不读写文件、不访问网络、只依赖 Node 标准库。IO 操作放在 CLI 层（`src/cli/index.mjs`）或 artifact operations 层（`artifact-operations.mjs`）。
- 结构化数据优先使用 schema / parser / reducer，不用 ad hoc string matching 作为核心判断。
- 错误输出要可机器消费；CLI gate 输出 JSON，exit code 表示 gate 结果。
- 注释只解释不明显的协议或 reducer 决策，不写空泛注释。

## Docs Symlink Scope

- `docs` 是软链接，指向 `/Users/song/projects/mydocs/kualityforge`。
- `docs/design/**`、`docs/quality/**`、`docs/evals/**` 都视为本 repo 工作范围内的项目文档。
- 在 `/Users/song/projects/kualityforge` 下执行 `git status` 不会显示 `docs` 真实目标所属 repo 的全部上下文；文档改动实际属于 `mydocs` repo。
- 任务需要时直接更新最小相关文档集；不要因为 design-doc edit 跨 symlink 就额外请求确认。
