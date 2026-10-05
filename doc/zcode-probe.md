# ZCode 独立执行器：隔离验证

状态：核心真实执行 PoC 已通过，尚未加入插件执行器列表，也未更新 Desktop。真实验收选定 `GLM-5.3-Flash`；官方内置目录列出的强度包含 `low/high/max`，短任务测试使用 `low`。

## 已核验的入口

- 本机桌面 3.14.4 内含 `Contents/Resources/glm/zcode.cjs`，CLI 自报 0.16.9。
- 参数包含 `--prompt`、`--cwd`、`--resume`、`--mode` 与 `--output-format stream-json`。输出格式参数以参数解析器及源码为依据，帮助页未完整列出。
- `app-server` 使用 ZCode 自有 NDJSON：`{id,method,params}`，不是 JSON-RPC 2.0。无需 `initialize`，`runtime/capabilities` 可直接请求。
- 创建空会话需要回应服务端的 `session/requestRuntimePreferences`。忽略该请求会在 15 秒后收到协议错误，即使进程退出码为 0 也不能算成功。
- 当前内置包运行 TUI 会报缺少 `@zcode/tui`。该版本 `login` 的终端入口走 Z.AI；不能假定 `login bigmodel` 可用。

## 探针使用

在插件仓库运行：

```sh
node scripts/probe-zcode.mjs
```

默认仅离线检查帮助、协议、空会话、空闲进程停止与文件写入边界。禁止互联网，只放行本地 Unix socket。脚本不提交 prompt；空会话仍会写入隔离数据库。

`CLIWORKER_ZCODE_ENTRY` 可指定另一个官方 `zcode.cjs`。源码构建入口优先使用相邻 `provider/zcode-builtin.json`；也可用 `CLIWORKER_ZCODE_BUILTIN_CONFIG` 显式指定配套目录。Node 版本须符合该发行物要求。

真实调用必须显式选择 Provider、模型与已核验的强度：

```sh
CLIWORKER_ZCODE_PROVIDER=account:bigmodel-individual-coding-plan \
CLIWORKER_ZCODE_MODEL=GLM-5.3-Flash \
CLIWORKER_ZCODE_EFFORT=low \
node scripts/probe-zcode.mjs --smoke
```

这个 smoke 依次验证短标记回复、同会话续聊、edit 模式 Write 工具创建 JSON 文件及 plan 模式流式输出中的 SIGTERM 取消。每一阶段失败即停止后续模型调用，不换模型、账号或 CLI；实际文件按字段比对并计算 SHA-256。取消必须先观察到真实 text_delta，再确认退出码、进程组清理和没有最终成功结果。ZCode 自行读取原生账号存储，脚本不导出、重写或打印凭据，原生用户目录不可写。

使用同样的环境变量运行 `node scripts/probe-zcode.mjs --permissions`，另行验证 build 模式 Write 权限询问、自动拒绝及目标文件不存在。它只发起这一个模型任务；CLI 退出 0 本身不代表写入成功。

完整官方 CLI 可用 `--login-bigmodel` 发起原生 BigModel 登录，`--login` 打开原生 TUI（桌面内置包缺组件，不适用）。登录只写入新建的测试 profile，终端授权输出不另存。完成后将输出的 profile 路径传给 `CLIWORKER_ZCODE_AUTH_BASE`，再跑 smoke。只有本探针创建的私有 profile 才可额外写入；用户原生目录始终只读。切换到源码 CLI 时还须设置 `CLIWORKER_ZCODE_ENTRY` 并使用 Node 24。

## 隔离与生命周期

- 每次创建 `.test-data/zcode-probe/run-*`，目录 0700、文件 0600，已被 Git 忽略。会话库、个人模型选择和日志单独指定；不改 `HOME`。
- 禁用测试工作区的插件、Hooks、MCP、记忆和子代理；使用参数数组启动进程。
- macOS sandbox 将写入限制在测试数据与专用 socket 目录；plan smoke 额外禁止工作区写入。该脚本目前仅适用于 macOS。
- 默认拒绝网络；只有显式 smoke 或原生登录允许网络。不会用 `yolo` 默认值运行测试任务。
- NDJSON 按 UTF-8 分块处理，限制 2 MiB 输出，分别检查协议响应、退出状态与进程组；停止后检查全部非僵尸组成员已退出。
- 所有 raw、日志、数据库与授权材料都留在被忽略的目录。提交中只保留脚本、说明与脱敏验收结论。

## 2026-10-05 验收记录

| 项目 | 结果 |
| --- | --- |
| 本机内置 CLI 帮助、协议握手、空会话创建 | 通过；最终复测 `run-o2uMDT/report.json` |
| 测试目录可写、目录外拒写、plan 工作区拒写 | 三项通过，外部哨兵保持原值；同上最终复测 |
| 空闲 app-server 停止 | 收到 SIGTERM，退出码 143，进程组退出确认通过 |
| 桌面账号直接用于 headless | 失败；补齐模型与 low 后仍报 `Select a model before continuing`；`run-KI7TFT/report.json` |
| 新的独立 BigModel 授权 | 已成功，写入隔离 profile；文件权限 0600，未修改桌面账号 |
| 首轮、同会话续聊、实际 JSON 文件产物 | 通过；`run-4XC18i/report.json`，Write 工具事件及文件内容均核验 |
| 运行中任务取消 | 收到真实 text_delta 后 SIGTERM；退出 143、进程组清理通过，无最终 result；同上 |
| 原生模型与规划状态 | CLI 数据库确认 GLM-5.3-Flash / low、planEnabled=true；`run-4XC18i/runtime-verification.json` |
| build 模式权限拒绝 | 通过；permission.requested → permission.resolved(deny)，文件不存在；`run-r9wKpm/report.json` |
| 正式插件、UI、Desktop 构建与发布 | 未执行，尚未达到接入门槛 |

账号诊断：桌面配置选择 BigModel Individual Coding Plan；此前检查的桌面账号存储中没有独立 CLI 所读取的 Provider identity 项；本轮新授权已在测试 profile 内按官方流程生成所需记录。这个本地格式差异不等于账户套餐无效，也不能通过伪造身份项或强制设置 entitled 来绕过。另一个早期探针曾尝试 `--prompt '/model list'`，实际进入模型创建路径并在选择模型前失败；不可将它作为可靠的只读目录命令。

规划状态核验已补齐：legacy snapshot 及 model_usage 中的 `mode` 可显示 build，但运行态将规划单独存为 `runtime/execution_state.planEnabled`。真实 headless plan 会话持久化为 `mode=build, planEnabled=true`，edit 文件任务为 `mode=edit, planEnabled=false`；模型选择和实际 usage 均为 GLM-5.3-Flash。不能仅根据 `mode` 判断是否处于规划状态。外层 sandbox 继续独立保障 plan 工作区不可写。

探针最终版本通过 `node --check`、Prettier 检查和 `git diff --check`；离线复测未发送 prompt。

## 完整官方 CLI 构建

为获得可用 BigModel 登录入口，在临时目录构建官方源码，没有修改或替换桌面安装：

- 官方源码树：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`（tree SHA，非冒充 commit SHA）。
- 源码压缩包 SHA-256：`2b603e95dd36c5d238a0ee75a9e52c61194ca2ace4a82fde92eb0b2391e7fdbb`。
- 使用独立 Node 24.14.0 / pnpm 10.33.2，按锁文件安装并跳过安装脚本，缓存与依赖在临时目录。
- `pnpm --filter '@zcode/cli...' build`：17 个相关 workspace 构建通过；完整 CLI 离线探针通过，证据 `run-RLKmUo/report.json`。
- 上游 freshness 脚本调用系统 Git，被本机 Xcode license 阻止；源码为带哈希的公开压缩包，不宣称该检查通过。
- 第一次原生登录等待超时，迟到的网页回调未写入凭据。续接时重新生成链接，用户完成授权后 CLI 退出 0，成功保存在独立 profile；后续真实任务均使用该 profile。登录默认选择 GLM-5.3，但探针明确使用用户指定的 GLM-5.3-Flash，不默默沿用默认值。

## 正式接入门槛

优先使用版本受控的官方 CLI，无头执行适合首轮 PoC；完整体验采用 Host 双向 stdio Bridge。Client 继续只经 Harness Gateway。复用任务树、项目锁、会话互斥和历史，单独实现 ZCode 参数、目录、权限与事件解析。

已完成单进程 CLI 核心门槛：原生授权、明确模型与强度、持久化 plan 状态、真实首轮与原会话续聊、真实文件比对、流式输出中停止与进程组清理、权限询问与拒绝。

正式集成仍须完成：版本受控的完整 CLI 安装路径、真实账号模型目录查询、Host 按项目/CLI 持久化和互斥、宿主沙箱与审批映射、包含实际子进程的停止场景、隔离插件构建及 UI 验收。当前源码构建位于临时目录，不能直接作为正式安装依赖。

建议首版采用 headless 参数数组启动与 NDJSON 事件解析：plan/accept-edits 分别映射 plan/edit，额外授权保持拒绝并明确显示；需要可交互审批时再增加双向 app-server Bridge。Host 接口可复用现有 dispatch/inspect/stop/follow-up 结构，适配器独立实现模型配置和会话恢复。

权限测试特别证明：发生 Write 拒绝时仍可得到 `turn.completed`、最终 result 和退出码 0。适配器必须记录 permission.resolved(deny) 及失败的工具结果，不能把退出 0 等同于成功执行用户要求。此测试只验证无头自动拒绝；未验证插件中的人工批准路径，也未以无子进程任务冒充全部后代取消验收。

来源：[官方仓库](https://github.com/zai-org/ZCode)、[CLI 参数](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/arguments.ts)、[协议](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol/index.ts)、[执行边界](https://github.com/zai-org/ZCode/blob/main/NOTICE.md)。
