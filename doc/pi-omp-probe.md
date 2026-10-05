# Pi 与 OMP：隔离 CLI 验证

2026-10-05：两项核心真实执行验证通过，尚未加入插件执行器列表、构建或更新 Desktop。用户明确选择使用 Harness 智谱凭据和 GLM-5.3-Flash；短任务使用两项实际支持的 `low`。没有调用原 OMP 默认 OpenAI 模型或自定义 Grok 模型。

## 安装身份

| 项目 | 本次实际执行入口 | 版本与来源 |
| --- | --- | --- |
| OMP | `/Users/leeyl/.local/bin/omp` | 原生 macOS arm64，`omp/16.4.4`；官方 `can1357/oh-my-pi` |
| Pi | `/private/tmp/cliworker-pi-1.0.2/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` | 官方 npm `@earendil-works/pi-coding-agent@1.0.2`，Node 22.23.1 执行 |

OMP 另有 Bun 全局 `@oh-my-pi/pi-coding-agent@17.0.1`，不是上述实际运行版本；不能只凭包目录版本标记运行时能力。其 `pi-*` 依赖也不等于安装了原版 Pi。

Pi 起初在 PATH、常见本地 npm/Bun/Pnpm 入口均未发现。本次从官方 npm 固定安装到临时目录，`--ignore-scripts --no-audit --no-fund --save-exact`，未修改全局安装。旧官方地址 `badlogic/pi-mono` 当前重定向 `earendil-works/pi`，官方安装包已改名。Pi 要求 Node ≥22.19.0；OMP 原生包不需要外部 Node。Bun 17.0.1 包要求 Bun ≥1.3.14，但该入口未实测。

完整性：

- OMP 可执行文件 SHA-256：`86e6c40a889897e5a127e40f01ec14f724df39af8996878239ec10912541ab62`。
- Pi `dist/cli.js` SHA-256：`8189b66abc4f9f431dbb70941dcba690d76d040de1fbfff212886be35a53639d`。
- Pi npm integrity：`sha512-3ZdIghMSELMGV3sKi5iASOb1Jwb696fLjmNu0aezaqDxTLLWWoRpqBYkGxJ1CgAMCbtfqXWEF0lcRrlVXmiEGQ==`。
- 临时安装锁文件 SHA-256：`f70d9089d150f24e00d05d414d030e96bff3a88bc18495cf461de058add54b62`。

Pi 的临时入口不是正式安装方案。正式接入前需固定官方安装版本及稳定路径；不得依赖 `/private/tmp` 长期存在。

## 已验证的模型与凭据路径

Pi 自带目录含 `zai-coding-cn/glm-5.3-flash`，正式名称 GLM-5.3-Flash，强度为 `low/high/max`，接口为 `openai-completions`，端点 `https://open.bigmodel.cn/api/coding/paas/v4`，环境变量 `ZAI_CODING_CN_API_KEY`。

OMP 本机未确认内置同名 CN 模型。探针用其原生自定义 `models.yml` 注册 **`cliworker-zai-cn/glm-5.3-flash`**，明确采用上述已核验端点和模型规格，再转换为 OMP 自己的 `thinking: {mode: effort, efforts: [low, high, max]}` 与兼容字段。此 ID 是探针隔离注册的 Provider，不能冒充 OMP 官方内置 Provider。

用户授权后，脚本先确认 Harness Desktop 配置唯一对应 `config.providers.zai-coding-cn.apiKeyEnv=ZAI_CODING_CN_API_KEY`，再只读取 `~/.dsh/.credentials.yaml` 中这一精确 `refs` 项。依据 Harness 官方 `credentials-local` 的 `parseRefs/resolve`，`refs` 值是非空秘密字符串；`records` 是另一套 Grant 存储，不能将 `refs` 值当成 `records` 的索引。秘密仅保留于内存和对应子进程环境，不写测试配置、argv、报告或终端，不复制完整凭据文件，不修改 Harness 原配置。

OMP 初次发现阶段无凭据会在进入 RPC 前报 `No models available`。默认离线探针因此使用明确标注的非秘密占位值，通过禁止互联网的沙箱测试握手；它不是认证成功或模型可调用的证据。真实阶段删除此占位 OpenAI 环境变量，仅注入用户授权的智谱引用。

## 探针使用

```sh
node scripts/probe-omp.mjs
node scripts/probe-pi.mjs
```

默认不发 prompt、禁止互联网。分别验证版本/help、目录命令、`get_state/get_available_models/abort` 及进程清理。每次新建 `.test-data/pi-omp-probe/omp-*` 或 `pi-*` 私有目录。

真实验证需显式运行：

```sh
CLIWORKER_OMP_PROVIDER=cliworker-zai-cn \
CLIWORKER_OMP_MODEL=glm-5.3-flash CLIWORKER_OMP_EFFORT=low \
node scripts/probe-omp.mjs --smoke-harness-zai

CLIWORKER_PI_PROVIDER=zai-coding-cn \
CLIWORKER_PI_MODEL=glm-5.3-flash CLIWORKER_PI_EFFORT=low \
node scripts/probe-pi.mjs --smoke-harness-zai
```

`CLIWORKER_OMP_ENTRY` / `CLIWORKER_PI_ENTRY` 可指定实际入口，但应重新验证其版本及协议。smoke 依次执行首轮标记、重启进程并恢复原会话、Write 产物、只读沙箱拒写、输出中的取消；前一步失败即停止后续模型请求。文件按 JSON 字段比对并记录 SHA-256。只有实际 text_delta 到达才取消，不用空闲 abort 冒充运行中取消。

## 实际验收证据

证据均位于被 Git 忽略的 `.test-data/pi-omp-probe/`，不提交模型输出、账号或会话数据。

| 验收 | OMP 16.4.4 | Pi 1.0.2 |
| --- | --- | --- |
| 离线 RPC 与协议响应 | `omp-Npi3xL/report.json` 通过，占位凭据夹具 | `pi-DrBeNN/report.json` 通过，无凭据 |
| 真实首轮 | `omp-rwRH41/report.json` 通过 | `pi-rzNlOX/report.json` 通过 |
| 新进程、原会话 ID、标记记忆续聊 | 同上通过 | 同上通过 |
| Write 事件及实际 JSON 文件 | 同上通过，`artifactMatches=true` | 同上通过，`artifactMatches=true` |
| 禁止写入的工作区 | tool_execution_end.isError=true，文件不存在 | 同左 |
| 输出中取消 | text_delta 后 SIGTERM，退出 143，进程组清空，无 agent_end | text_delta 后 SIGTERM，退出 143，进程组清空，无 agent_settled |
| 实际模型与强度 | 初始/最终状态及 assistant 消息为隔离 CN Provider / glm-5.3-flash / low | 初始/最终状态及 assistant 消息为 zai-coding-cn / glm-5.3-flash / low |
| 沙箱三项 | `omp-rwRH41/report.json`：私有目录可写、目录外拒写、只读工作区拒写均通过 | `pi-uEU3OP/report.json` 三项通过，无模型复测 |
| 原生凭据/配置 | 未改动 | 未改动 |

OMP 最终实测显式设置 `--approval-mode write` 并关闭 `retry.modelFallback`。原生默认审批模式为 `yolo`，不能直接沿用。本轮工具仅开放 `write` 或全部关闭，没有批准 exec 类工具。Pi 官方没有内置文件、进程、网络或凭据沙箱；本轮拒写是 **macOS 外层 sandbox 的证据**，不是 Pi 内置审批的证据。

Pi 第一次续聊使用 `--resume <path>` 时进入终端选择器并超时，未发续聊模型任务，进程已清理。按本机 help 修正为 `--session <path>` 后整条链路通过，历史失败记录保留在 `pi-X7hyas`。

两项拒写后仍能正常结束并退出 0；Host 必须读取失败工具事件及实际产物，不能将退出码 0 当成用户任务成功。

## 统一接入的精确接口摘要

| 方面 | OMP | Pi |
| --- | --- | --- |
| 启动 | 原生二进制，参数数组 `--mode rpc --provider <id> --model <id> --thinking <level>` | `node <cli.js> --mode rpc --provider <id> --model <id> --thinking <level>` |
| 指定原会话 | `--resume <sessionFile>` | `--session <sessionFile>`；`--resume` 是交互选择器 |
| 会话身份 | `get_state.data.sessionId/sessionFile`，以真实返回值保存；路径下 JSONL 持久化 | 同左，路径布局不同，不能自行从 ID 拼路径 |
| 协议 | NDJSON `{id,type,...}`，启动有 `ready`，不是 JSON-RPC 2.0 | NDJSON `{id,type,...}`，本版无 ready；主动 get_state 即可 |
| 提交 | `{id,type:prompt,message}`；success 仅表示受理 | 同左；response.data.disposition 还可区分 started/handled/queued |
| 事件 | `message_update.assistantMessageEvent.type=text_delta`，`tool_execution_end.isError` | 同左 |
| 完成 | 本次 `agent_end` 后读取 get_state 确认非 streaming、核对工具和进程退出；队列/重试等完整场景还需验收 | 等 `agent_settled`；agent_end 后可能仍有重试/整理等工作 |
| 查询目录 | `omp models --json`、`models <provider>`；help 已实测。RPC `get_available_models` 可用。无任何凭据时 RPC 启动失败 | `pi --list-models [search]`、RPC `get_available_models`；无凭据仍可启动，但可用模型集合受认证状态限制 |
| 规划与权限 | `--plan <value>` 是模型参数，不能当成只读沙箱。审批 `always-ask/write/yolo`；本轮只验收 write 模式和外层拒写，未验人工审批 | 官方无内置 plan 模式/安全沙箱，Host 需工具白名单及外层只读沙箱；不能套用 OMP 权限 flag |
| 资源关闭 | 关闭 stdin 后退出；超时/取消发送进程组 SIGTERM，必要时 SIGKILL，并检查非僵尸成员消失 | 同左 |
| 隔离目录 | `PI_CODING_AGENT_DIR` 只改部分目录；还需 `PI_CONFIG_DIR` 覆盖日志等根目录。本探针使用相对 home 的独立目录值，不改 HOME | `PI_CODING_AGENT_DIR` 指向私有目录，禁用扩展、skills、prompt templates、themes、context files |

正式 Host 应保持两套独立参数与终态规则，关闭自动模型回退，模型选择与会话按项目/CLI 保存。RPC 是长期子进程，插件仍通过原生 Gateway；不能让 Client 直接 spawn，也不需要修改 Harness 核心。

当前只证明上述两版本在短任务中的 CLI 核心可行性；真实 exec 子进程取消、并发/恢复、人工审批、安装升级、任务树与 UI 仍是集成验收事项。本轮没有运行插件 typecheck/test/build:preview/build，不宣称插件已经接入。

脚本最终通过 `node --check`、Prettier 检查和 `git diff --check`；另行重读两份最终真实报告，核对每个阶段的实际 Provider/模型/强度、文件比对、退出结果与私有文件权限。

来源：[Pi 官方仓库](https://github.com/earendil-works/pi)、[Pi RPC 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[OMP 官方仓库](https://github.com/can1357/oh-my-pi)、[OMP RPC 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)。线上文档可能较已安装版本更新；表中实测结论以本机版本/help/原始事件为准。
