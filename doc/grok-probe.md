# Grok Build：离线接入验证

状态：已核验本机官方 Grok Build 的 CLI 入口、ACP 握手、会话列表与隔离进程生命周期。用户明确表示没有订阅，要求 Grok 不做真实模型验证；未发送 prompt、未登录，未集成到插件或更新 Desktop。

## 本机入口与实际能力

| 项目 | 已核验结果 |
| --- | --- |
| 入口 | `~/.grok/bin/grok` → `~/.grok/downloads/grok-1.0.0-macos-aarch64` |
| 版本 | `grok 1.0.0 (3cd0d0cbcebe)` |
| 二进制 SHA-256 | `13c7f4f0b9abb00bf38216302ea4bab31f03e13555e3576620eca1de572a8d21` |
| 无头执行 | 原生 help 确认 `-p/--single`、`-m/--model`、`--reasoning-effort`、`--cwd`、`--resume` |
| 输出格式 | `plain`、`json`、`streaming-json`、`streaming-messages-json` |
| 双向协议 | `grok agent --no-leader stdio`，JSON-RPC 2.0 / NDJSON，`initialize` 使用数值 `protocolVersion: 1` |
| 会话能力 | initialize 宣告 loadSession、list/resume/close；实际 `session/list` 返回空列表 |
| 内置模型目录 | `grok-4.5`，Grok 4.5；强度 `high`（默认）、`medium`、`low` |
| 认证与目录边界 | 未认证时 `grok models` 也退出 0 并显示内置目录；这不能证明账号额度或模型可调用 |

安装目录的 README 与当前二进制有差异：README 曾把 `--session-id` 写成“创建或续聊任意命名会话”，但当前 help 明确要求新 UUID 且不能重复；续聊必须使用 `--resume`，分叉才组合 `--fork-session`。实现时应以受控版本的实际 help、协议和运行证据为准。

## 探针

```sh
node scripts/probe-grok.mjs
```

默认禁用互联网，只允许本机 Unix socket。探针核验版本、帮助、内置模型目录、ACP 初始化、空会话列表、空闲进程停止和文件写入边界，不发起模型任务。`CLIWORKER_GROK_ENTRY` 可以指定另一个已安装的官方入口。

`node scripts/probe-grok.mjs --catalog` 是可选的原生在线目录查询：仅让 Grok 通过只读链接读取原账号文件，运行数据仍隔离，不复制或输出凭据。它不登录、不刷新原目录、不发送 prompt；即使列出模型也不把账户标为可用。用户要求跳过真实测试后，没有再运行此模式。脚本不提供 `--smoke` 或其他可意外开始计费任务的开关。

隔离措施：

- 每次生成 `.test-data/grok-probe/run-*`；目录 0700、文件 0600，全部被 Git 忽略；不遍历账号符号链接修改权限。
- `GROK_HOME` 指向独立 profile，`HOME` 保持原值，使用新的空工作区；不复制原 config、会话或扩展。
- 禁用自动更新、leader、子代理、记忆、工作流、遥测、trace upload、代码索引和 `.envrc` 加载；进程环境仅保留基础系统变量。
- 外层 macOS sandbox 限制写入仅在测试根目录和专用短路径临时目录；额外核验只读策略对工作区拒写。
- 使用参数数组，UTF-8 增量解码，输出上限 2 MiB；协议行解析失败单独计数，未知反向请求明确拒绝。
- 离线调用 20 秒超时，在线目录 90 秒；再等 5 秒强制终止。空闲停止以收到协议响应后 SIGTERM、退出 143 和无剩余非僵尸进程组成员共同判断。

## 2026-10-05 验收记录

证据根目录为 `.test-data/grok-probe/`，不提交原始日志。

| 项目 | 结果与证据 |
| --- | --- |
| 版本、帮助、内置目录 | 通过，最终离线复测 `run-b32d7z/report.json` |
| ACP initialize | 通过，protocolVersion=1；原生 capabilities 与 modelState 已落盘 |
| ACP session/list | 通过，实际返回空 sessions；未创建或执行模型任务 |
| SIGTERM 与进程组退出 | 两个 ACP 进程均退出 143，进程组已清空 |
| 文件隔离 | 测试目录可写、目录外哨兵拒写且保持原值、只读工作区拒写，三项通过 |
| 在线模型目录（用户后续排除真实执行前） | `run-cEhAT7`；原生明确报告未认证，仍退出 0 并列出 grok-4.5；未查询推理、未重新授权 |
| 首轮、续聊、文件产物、流式任务中取消、权限批准/拒绝 | 按用户要求跳过；不能以离线握手、目录或空闲停止代替 |
| 脚本检查 | `node --check`、Prettier 检查和 `git diff --check` 通过 |
| 插件/UI/正式构建 | 未执行 |

本轮仅检查原生认证文件是否存在及过期元数据；此前记录的到期时间为 2026-07-21，在线目录未报告有效登录。用户明确无订阅后停止推进账号授权。这里不把本地过期时间推断为远端套餐结论。

## 统一接入时的约束

**技术接口足够，真实可用性未验收。** 可采用独立 headless adapter，或 ACP bridge；两者都应保留 Grok 自有语义，不复用 ZCode 的 NDJSON 协议。

- 首版若用 headless，应以 `streaming-json` 的 `type` 分支处理 `text`、`tool_call`、`tool_call_update`、`usage`、`end` 和 `error`；本机安装文档还列出 `max_turns_reached` 等扩展事件，应保留未知事件并限制大小。真实流形态待有订阅后实证。
- `end`、退出 0 和模型文本均不是文件任务验收。实际接入后仍要结合工具状态、权限事件、实际文件内容与会话 ID 判定结果。
- `--permission-mode` 实际支持 `default/acceptEdits/auto/dontAsk/bypassPermissions/plan`。其中 `plan` 在安装文档中只是兼容值，不能据此证明真实规划状态已激活。
- 原生规划文档明确：规划编辑门禁不能覆盖 Bash 写入和写权限子代理。原生 sandbox 默认 off，macOS 内置只读/strict 的子进程网络限制也不可假定生效；Host 必须独立实施沙箱和规划写入限制。
- ACP 的 `session/request_permission` 等交互审批，以及运行中取消、同会话续聊、实际子进程取消，均需后续真实验收；本轮只验证空闲停止。
- 模型目录来自 initialize 的 `modelState`；不要把目录存在当成订阅可用，也不要在失败时切换其他模型、Provider 或 CLI。

来源：[官方概览](https://docs.x.ai/build/overview)、[官方配置与 GROK_HOME](https://docs.x.ai/build/settings)、[官方无头与 ACP 文档](https://docs.x.ai/build/cli/headless-scripting)、[官方仓库](https://github.com/xai-org/grok-build)。版本差异与规划/沙箱边界另以本机 `~/.grok/docs/user-guide/14-headless-mode.md`、`18-sandbox.md`、`19-plan-mode.md`、`22-permissions-and-safety.md` 和实际 help 交叉核验。
