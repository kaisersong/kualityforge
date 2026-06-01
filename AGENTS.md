# Repo Notes

## 语言

- 始终使用中文回复。

## 相关项目

- `kualityfore` 关联项目都在 `/Users/song/projects/` 下：
  - `kswarm`：负责 `kualityfore-flow` dynamic workflow 编排，包括 reviewer fan-out、task retry、resume、cancel、human decision gate、fix / verify 节点调度和 run state 持久化。
  - `intent-broker`：负责本地 agent / runner 注册、participant identity、任务投递、artifact completion event、decision / approval 事件和跨 agent 协作通信。
  - `xiaok-cli`：负责 desktop / CLI 入口、release / ship 集成、KualityFore run 状态展示和用户交互。
  - `mydocs`：负责 `kualityfore` 文档、设计记录、质量记录和 eval 报告。`kualityfore/docs` 必须软链接到 `/Users/song/projects/mydocs/kualityfore`。
- 修改 KualityFore workflow、runner contract、artifact handoff、review/fix/verify 状态机时，优先检查 `kswarm` 是否也需要改。
- 修改 agent 协作、runner dispatch、event correlation、participant identity、approval / decision 流程时，优先检查 `intent-broker` 是否也需要改。
- 修改 xiaok desktop / CLI 入口、release gate、UI 展示、ship 集成时，优先检查 `xiaok-cli` 是否也需要改。
- 提交代码时，相关项目如果有配套改动也要一起提交；如果只提交其中一部分，必须在最终说明里写清楚原因。

## 项目定位

- `kualityfore` 是通用质量门禁核心项目。
- 不把 KSwarm dynamic workflow、xiaok desktop UI、intent-broker runner dispatch 的实现混入 core。
- core 只负责 artifact protocol、schema、parser、gate reducer、CLI、fixtures、eval corpus 和 CI 可调用的确定性判断。
- KualityFore 参考 Viking `review-forge` 的多模型 review / synthesize / fix / verify 思路，但不是项目私有 skill；它要成为跨项目可复用、CI / ship 可调用的质量门禁基础设施。

## 当前重心

- 当前重心是 deterministic core：
  - manifest / policy schema。
  - artifact parser。
  - finding reducer。
  - gate reducer。
  - CLI `kualityfore gate`。
  - fixture / golden tests。
  - deterministic eval baseline。
- 第一阶段不要实现 desktop UI、真实模型 runner、GitHub Actions 发布集成或完整 KSwarm workflow executor。
- 可以先定义与 KSwarm / intent-broker 对接的 contract，但不要把编排实现塞进 core。

## 文档

- 本项目的 `docs` 是软链接，指向 `/Users/song/projects/mydocs/kualityfore`。
- 设计文档、质量记录、eval 报告说明默认写到 `docs/**`，也就是实际写入 `mydocs/kualityfore/**`。
- 不要把项目文档只写在 README 里；README 只放入口和运行说明。
- 设计文档入口：
  - `docs/README.md`
  - `docs/design/2026-06-01-kualityfore-project-bootstrap-design.md`
- 如果从 `xiaok-cli` 的早期 ReviewForge 设计迁移内容，优先保持语义一致，不要复制 xiaok-cli release profile 作为 core 默认规则。

## 实现门禁

- 新需求或行为变更先写设计文档。
- 实现前先做对抗性评审。
- 评审后先写测试，再写 production code。
- KualityFore 自身必须有 unit、fixture、workflow、adapter、CI、E2E、eval 分层验证。
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
- 对抗性评审重点：边界条件、伪造 artifact、path traversal、manifest / markdown drift、未批准 finding 被修复、runner identity 冒用、测试 blocked 被误判通过、live model 波动污染 deterministic gate。

## 边界

- `kswarm`：只放 `kualityfore-flow` workflow template、fan-out、retry、resume、cancel 等编排。
- `intent-broker`：只放 runner dispatch、event correlation、participant identity 等协作协议。
- `xiaok-cli`：只放入口、展示、ship/release 集成。
- `kualityfore`：保持可被任意项目独立调用，不硬编码 xiaok-cli release 规则。

## Core 架构规则

- artifact protocol 是事实来源；CLI / CI / KSwarm / xiaok UI 都只能读取或生成符合协议的结构化 artifacts。
- reducer 必须 deterministic：相同 manifest、policy、artifacts 必须得到相同 gate result 和 exit code。
- gate 必须 fail closed：缺 reviewer、缺 human decision、缺 required checks、缺 verification、manifest 无效、artifact 冲突时不得返回 passed。
- human decision 是 fix 的边界：unchecked / deferred / wont_fix / risk_accepted finding 不得进入自动 fix queue。
- verifier 必须独立于 fixer；release profile 不允许同一 runner 自修自验。
- model-assisted eval 是质量信号，不能替代 deterministic unit / fixture / reducer tests。
- CI mode 默认不依赖 live model availability；CI gate 消费已生成 artifacts 或 deterministic fixtures。
- 不把 xiaok-cli 的 release 检查硬编码到 core；项目特定规则通过 policy/profile 注入。

## 测试与 Eval

- 基础验证：
  ```bash
  npm test
  npm run test:kualityfore:unit
  ```
- 后续完整 KualityFore 自身 gate 应包含：
  ```bash
  npm run test:kualityfore:unit
  npm run test:kualityfore:fixtures
  npm run test:kualityfore:workflow
  npm run test:kualityfore:adapters
  npm run test:kualityfore:ci
  npm run test:kualityfore:e2e
  npm run eval:kualityfore
  ```
- `npm run eval:kualityfore:model-assisted` 只能作为 release 前或 nightly 信号；不要让它成为 PR 必跑的唯一质量证据。
- 新增 reducer / parser / schema 行为必须先补 fixture 或 unit test。
- 修复 bug 优先补复现 fixture；不要只改 reducer 让当前 case 通过。

## 代码风格

- 默认使用 Node.js ESM。
- 第一阶段尽量使用 Node 标准库，避免过早引入运行时依赖。
- 结构化数据优先使用 schema / parser / reducer，不用 ad hoc string matching 作为核心判断。
- 错误输出要可机器消费；CLI gate 输出 JSON，exit code 表示 gate 结果。
- 注释只解释不明显的协议或 reducer 决策，不写空泛注释。

## Docs Symlink Scope

- `docs` 是软链接，指向 `/Users/song/projects/mydocs/kualityfore`。
- `docs/design/**`、`docs/quality/**`、`docs/evals/**` 都视为本 repo 工作范围内的项目文档。
- 在 `/Users/song/projects/kualityfore` 下执行 `git status` 不会显示 `docs` 真实目标所属 repo 的全部上下文；文档改动实际属于 `mydocs` repo。
- 任务需要时直接更新最小相关文档集；不要因为 design-doc edit 跨 symlink 就额外请求确认。
