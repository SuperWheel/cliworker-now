# 用 OpenSpec 管理后续开发

本项目从 v0.6.6 渐进接入 OpenSpec，先管理后续变更，保留历史。

## 1. 已接入的范围

- 开发依赖固定为 `@fission-ai/openspec@1.14.1`，由锁文件管理，无需全局安装。
- 已按 `--tools codex --profile core --language Chinese` 初始化，生成六个项目级技能。
- 首个变更 [adopt-openspec-workflow](../openspec/changes/archive/2026-10-07-adopt-openspec-workflow/) 已归档，建立 [development-workflow](../openspec/specs/development-workflow/spec.md) 开发流程规格。
- 此次不补写全部业务规格，不改变业务与 Desktop 安装。

统一用 `pnpm spec` 调用锁定版本，以 `OPENSPEC_TELEMETRY=0` 关闭遥测。
生成技能中的裸 `openspec` 命令均替换为 `pnpm spec` 执行。

| 命令 | 用途 |
| --- | --- |
| `pnpm spec --version` | 查看项目使用的版本 |
| `pnpm spec:list` | 列出活动变更 |
| `pnpm spec list --specs` | 列出主规格 |
| `pnpm spec:check` | 执行 `validate --all --strict --no-interactive` |

## 2. 文档分别放什么

| 位置 | 职责 |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | 开发规则、权限、验证与交付边界 |
| [`../openspec/config.yaml`](../openspec/config.yaml) | 项目上下文及各类产物的编写规则 |
| `openspec/specs/<能力>/spec.md` | 已纳入管理的当前行为契约 |
| `openspec/changes/<变更名>/` | 本次提案、规格增量、设计及任务清单 |
| [`../openspec/changes/archive/`](../openspec/changes/archive/) | 已完成变更及其决策记录 |
| [`design.md`](design.md) | 既有设计和版本演进历史，继续保留 |
| [`tasks.md`](tasks.md) | 实际执行的验证、结果、证据位置和发布记录 |

新步骤放在变更 `tasks.md`，`doc/tasks.md` 记录结果，避免重复维护。
旧设计和待办先对照当前源码、测试及后续记录，再提取主规格。
规格表达预期行为，测试与运行证据说明验证程度，二者不能替代。

## 3. 在 Codex 中使用

Codex CLI／IDE 可用 `$openspec-propose`；Desktop 从 **Skills** 选择技能。
技能未刷新时，可用自然语言要求按 `AGENTS.md` 和 OpenSpec 流程处理。
文件位于 [`.agents/skills`](../.agents/skills/)；技能名不是 CLI 子命令。
如需其他开发助手的专用入口，先用 `pnpm spec init --help` 核对工具 ID，再显式执行
`pnpm spec init --tools <tool-id> --profile core`。插件支持的 CLI 列表不等于必须安装的开发助手列表。

| 技能名 | 适用时机 |
| --- | --- |
| `openspec-explore` | 先调查问题、比较方向和澄清边界，不直接实施代码 |
| `openspec-propose` | 生成提案、规格增量、设计与任务 |
| `openspec-apply-change` | 按已授权范围实施任务并记录实际验证 |
| `openspec-update-change` | 需求改变时同步修订规划产物，不修改业务代码 |
| `openspec-sync-specs` | 将增量合入主规格，暂时保留活动变更 |
| `openspec-archive-change` | 核验完成状态、同步主规格并归档 |

常用表达：

> 用 OpenSpec 研究这个问题，核对实现和规格。

> 生成 OpenSpec 提案，写明范围和验收方式。

> 实施这个变更，完成相应验证后同步规格并归档。

仅要求提案时停在规划阶段；已有实施与归档授权直接沿用，不重复审批。
真实模型调用仍需 CLI／模型选型授权。

## 4. 一个变更的完整流程

以下 `improve-worker-search` 为示例，执行前替换为实际变更名。

```sh
# 确认项目根及现有变更
pnpm spec context --json
pnpm spec list --json

# 创建骨架，并读取产物依赖
pnpm spec new change improve-worker-search
pnpm spec status --change improve-worker-search --json

# 逐项读取要求，再由开发者或 Agent 编写对应文件
pnpm spec instructions proposal --change improve-worker-search --json
pnpm spec instructions specs --change improve-worker-search --json
pnpm spec instructions design --change improve-worker-search --json
pnpm spec instructions tasks --change improve-worker-search --json

# 产物完成后校验
pnpm spec validate improve-worker-search --strict --no-interactive
pnpm spec status --change improve-worker-search
```

`new change` **只创建骨架，不生成完整提案**；`instructions` 只输出要求。
按 `status` 的依赖和路径编写 `proposal.md`、`specs/`、`design.md`、`tasks.md`。
正文用中文，保留结构标题及 `SHALL`／`MUST` 关键字。
没有规格级行为变化的纯重构或文档维护，可以在该 change 的 `.openspec.yaml` 声明
`skip_specs: true`，按 CLI instructions 跳过规格；`design.md` 按 instructions 的适用条件处理。
不要为了通过校验编造需求。本次接入定义了新的开发流程行为，因此有实际流程规格。

按当前产物实施代码和测试，完成后才勾选；范围变化时同步修订规划产物。

```sh
pnpm spec instructions apply --change improve-worker-search --json

# 实施完成，检查产物、任务数量及归档要求
pnpm spec status --change improve-worker-search --json
pnpm spec list --json
pnpm spec instructions archive --change improve-worker-search --json
pnpm spec validate improve-worker-search --strict --no-interactive

# 在实施、必要验证及规格同步范围均已明确后执行
pnpm spec archive improve-worker-search --yes
pnpm spec:check
pnpm spec:list
```

归档会更新主规格并移动变更目录，完成后核对结果。
已落实的变更若只同步规格，用 `openspec-sync-specs` 技能；不存在 `pnpm spec sync` 命令。
`status` 的文件存在和任务勾选不证明验收通过；`validate` 检查结构，不证明业务正确。
归档前完成所需验证，`--yes` 不替代任务、证据或冲突处理。

## 5. 现有业务怎样逐步补规格

首次仅建立开发流程规格。七个业务域**只是建议，尚未生成规格**；后续触及时提取现状基线及本次增量。

| 建议能力域 | 提取重点 | 源码与测试入口 |
| --- | --- | --- |
| `worker-dispatch` | 明确指定 CLI、首次选型、角色选择、两层派遣 | [Host](../src/host/index.ts)、[派遣测试](../tests/role-dispatch.test.ts) |
| `worker-lifecycle` | 排队、互斥、停止、进程清理、同会话续聊 | [运行时](../src/host/runtime.ts)、[核心测试](../tests/core.test.ts) |
| `cli-capabilities` | 原生协议、真实模型能力、错误判断、退役兼容 | [共享类型](../src/shared/types.ts)、[适配器](../src/host/adapters.ts)、[运行时测试](../tests/runtime.test.ts) |
| `settings-and-accounts` | 项目偏好、CLI 开关、账号来源和原生终端 | [账号模块](../src/host/accounts.ts)、[设置测试](../tests/cli-settings.test.ts)、[账号测试](../tests/accounts.test.ts) |
| `roles-and-names` | 预设管理、角色快照、命名和同父会话查找 | [角色模块](../src/host/roles.ts)、[角色测试](../tests/roles.test.ts) |
| `history-and-observability` | 私有持久化、恢复、历史分页、真实事件与用量 | [存储](../src/host/storage.ts)、[核心测试](../tests/core.test.ts)、[遥测测试](../tests/telemetry.test.ts) |
| `harness-ui-integration` | Gateway、侧栏、主题、组件及生命周期清理 | [Client](../src/client/index.tsx)、[注册测试](../tests/client-registration.test.ts)、[面板测试](../tests/panel.test.tsx) |

命名与角色预设已实现，见 [角色说明](role-presets.md)。
Kimi 订阅 403、Grok／Hermes 真实任务未验收，参见 [支持范围](../README.md#42-支持范围与验证边界) 和 [实际记录](tasks.md)。本次不新增付费验收任务。

## 6. 验证、交付和升级

业务变更按 `AGENTS.md` 做类型检查、测试、隔离构建；UI 需实际渲染核对。
正式构建前确认无活动任务和账号终端，不覆盖会话、凭据或其他配置。
真实 CLI 验收检查事件、退出状态及产物，不采信完成自述。
纯流程文档做规格和差异检查，不虚报测试。

升级时审阅目标版本说明，并显式固定版本：

```sh
pnpm add -D -E @fission-ai/openspec@<目标版本>
pnpm spec update
pnpm spec:check
```

`update` 刷新技能集成；需求修订用 `openspec-update-change`。
升级检查生成文件、配置及锁文件，不改全局配置。
分阶段提交相关文件，保留其他改动，不自动推送。
