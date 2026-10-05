# Harness CLI：真实执行与取消验证

状态：`@deepseek-ai/dsh 0.2.0-rc.2` 的无头首轮、原会话续聊、Write 文件、只读写入拒绝、实际 Bash 后代取消均有真实证据。用户后续授权复用 Harness 智谱凭据，明确使用 `zai-coding-cn / glm-5.3-flash / low`。本探针没有修改 Desktop 配置，没有复制密钥，没有集成业务 UI。

## 运行方式

```sh
node scripts/probe-harness.mjs
```

默认断网，只读版本与帮助，检查原生 JSON 用法错误、ACP initialize/new/list/close、空闲 SIGTERM 和文件沙箱边界。不会发 prompt。

下列三个入口均要求明确提供同一组已授权选型变量：

```sh
CLIWORKER_HARNESS_PROVIDER=zai-coding-cn \
CLIWORKER_HARNESS_MODEL=glm-5.3-flash \
CLIWORKER_HARNESS_EFFORT=low \
node scripts/probe-harness.mjs --catalog
```

- `--catalog`：仍断网。通过 ACP 获取原生模型目录，切换到选定模型/low 并读取确认，不发 prompt。
- `--smoke`：四个真实任务：短标记、原会话续聊、write JSON 文件、read-only 下拒绝 write。失败即停止后续模型调用。
- `--stop-native`：仅补一个 `sleep 30` 任务，明确使用 Harness 原生 workspace-write 沙箱，不叠加外层 Seatbelt。工具调用后等 1 秒，必须实际观察到 sleep 后代才可判定取消成功；没有降级到 danger-full-access。

运行数据都在 `.test-data/harness-probe/run-*`，目录 0700、文件 0600。使用独立 `DSH_HOME`、空工作区、精简环境和独立临时目录。除独立原生取消阶段外，外层 Seatbelt 额外限制写入至测试目录；联网仅用于明确的真实阶段。stdout/stderr 上限 2 MiB、UTF-8 增量解码，协议错误不能静默忽略；超时有界并清理进程组及已观察到的后代，以 PID 和启动时间避免误杀复用 PID。

## 验收记录（2026-10-05）

| 项目 | 证据与结果 |
| --- | --- |
| 离线五项与文件边界 | `run-JdoF8b/report.json`，全部通过，0 prompt |
| 原生 JSON 用法错误 | 确认 `type:error`、unknown option 和退出 1；不是把任意退出 1 当作协议成功 |
| 空闲 ACP 停止 | Harness 收到 SIGTERM 后可正常退出 0；只有 stopRequested 与进程范围清空同时成立才接受 |
| 首轮/续聊/write/只读拒绝 | `run-V4rlLW/report.json` 前四个真实任务通过；续聊 session ID 相同，Write 对应 callId 完成且 JSON 字段与 SHA-256 核验，拒绝对应 callId 错误且无文件 |
| 嵌套沙箱 Bash | 同上第五个任务失败，保留报告整体 fail。原生 workspace-write 的 sandbox-exec 被外层 Seatbelt 拒绝，sleep 未启动；未冒充后代取消通过 |
| 原生沙箱实际 Bash 取消 | `run-z5cQXJ/report.json`，仅 1 prompt；观察到 sleep 的 PID/独立 PGID，停止后根进程退出 0、无 completed、原进程组与已跟踪后代退出 |
| 实际模型选择 | 上述两次真实运行的 `selection-verification.json`，本地解压原生持久化事件，确认 zai-coding-cn / glm-5.3-flash / low，不仅检查启动参数 |
| 原凭据未改动 | 两次真实运行的文件前后哈希一致，只保留比较布尔值，不输出密钥或文件哈希 |
| 明确 ACP 模型目录与强度 | `run-eiMnpv/report.json`，断网 0 prompt，GLM-5.3-Flash / low 已由 configOptions 回显确认 |

原生取消阶段的沙箱证据为：运行配置明确 workspace-write，已核验安装源码使用 fail-closed 的 Seatbelt backend，实际 Bash/sleep 成功进入运行并被停止。该单独阶段没有另做原生沙箱越界写入哨兵；不能把前面外层 Seatbelt 的哨兵结果当作这一阶段独立的越界测试。原生模式按其官方策略还允许系统临时目录，不能宣称仅测试根目录可写。

## 可用于接入的精确接口

### 无头执行

参数数组：`[dsh, '--profile', 'headless', '--patch', overlay, '--json', prompt]`；续聊增加 `['--session-id', id]`。旧会话必须存在，未知 ID 会报错。`DSH_HOME` 固定到插件自己的持久化状态目录，不能每轮更换而丢失会话。环境设 `DSH_PERMISSION_MODE=workspace-write` 或 `read-only`。

最小 overlay 是 JSON 数组（合法 YAML），不含密钥值：

```json
[
  {"id":"credentials","config":{"path":"/Users/leeyl/.dsh/.credentials.yaml","watch":false}},
  {"id":"llm-pi-ai","config":{"providers":{"zai-coding-cn":{"apiKeyEnv":"ZAI_CODING_CN_API_KEY"}}}},
  {"id":"agent-default-model","config":{"provider":"zai-coding-cn","model":"glm-5.3-flash","reasoningEffort":"low"}},
  {"id":"session-title-llm","disabled":true}
]
```

NDJSON：

- `session` 提供 `sessionId/cwd`，必须绑定真实身份。
- `text` 提供公开文本，`thinking` 不作为对话正文展示。
- `tool_call` 提供 `tool/input/callId`；工具名实际为小写 `write/bash`。
- `tool_result` 使用相同 `callId`，`status=completed/error`。
- `status` 的 `phase=turn_end`，`reason` 是对象，只有 `reason.kind=completed` 是正常完成。
- `final` 提供最终 `text`；即使取消，仍可能出现空 `final` 与退出 0。必须同时检查身份、终态、工具失败及进程结果，不能把 final/退出 0 单独当作成功。

### 无 prompt 的模型目录

运行 `dsh --profile acp --patch overlay-acp.yml`，使用 JSON-RPC 2.0 / NDJSON：

1. `initialize {protocolVersion:1,clientCapabilities:{}}`。
2. `session/new {cwd,mcpServers:[]}`；读取返回的 `configOptions`。
3. `model` 选项按 Provider 分组，选项 `value` 是 `JSON.stringify([provider,model])`，应原样保留；不能当普通斜杠文本反向猜测。
4. 用 `session/set_config_option {sessionId,configId:'model',value}` 切换后，返回该模型实际 `reasoning_effort` 选项；再以相同方法显式设置选定强度。
5. `session/close` 后关闭 stdin，确认范围退出。

ACP 的默认选型属于独立插件 `id:acp`，应在其 config 中设置 provider/model；无头入口的 `agent-default-model` 不会改变 ACP 默认选择。探针已发现并修正这一差异。ACP 不支持在 config 里直接猜一个 reasoningEffort 字段，强度应经原生配置协议设置。

本机 SDK 也提供 `ctx.llm.listProviders()`、`listModels(provider)`、`resolveModelInfo(provider,model)`；pi-ai adapter 的 listModels 从已安装原生目录读取，无须发推理请求。ACP 是独立 CLI 接入时更合适的进程边界。

### 权限与停止边界

macOS 不可给 Harness 原生 sandbox-exec 再套一层 Seatbelt，否则 Bash 会按 fail-closed 策略拒绝启动。正式适配应使用 Harness 原生沙箱并保持默认权限语义，不能通过 danger-full-access 绕过。平台文件策略与人工审批是独立机制；本轮验证了拒写，没有验证 UI 人工批准路径。

真实取消已覆盖一个另起 PGID 的 sleep 子进程；进程追踪不等于保证捕获任何瞬时自脱离/双 fork 后代。正式 Host 仍须按照进程后端的生命周期协议清理，而不是只 kill 根 PID。

来源：[官方仓库](https://github.com/deepseek-ai/deepseek-harness)；接口已对照本机 0.2.0-rc.2 的 `dsh-headless`、`dsh-acp`、`dsh-agent-default-model`、`dsh-llm-pi-ai`、`dsh-sandbox-local`、`dsh-base/cordis.patch.yml` 实际源码核验。
