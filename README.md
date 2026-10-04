# CLI Worker Now

DeepSeek Harness 的多 CLI 实时侧栏插件，支持 Antigravity、Codex、Claude Code、Kimi 和小米官方 MiMo Code。模型先由你选择，之后按项目与 CLI 分别沿用；每个子 Agent 都有独立记录，支持停止与结束后续聊。

兼容基线：macOS、Harness **0.2.0-rc.2**、Antigravity CLI **1.2.16**、Node ≥22.19。

## v0.2.0 多 CLI

| CLI | 核验版本 | 模型与强度 | 当前验收状态 |
| --- | --- | --- | --- |
| Antigravity | 1.2.16 | 动态模型列表、原有强度 | 原功能保留与回归通过 |
| Codex | 0.160.0 | 本机模型缓存及各模型 reasoning levels | 真实首轮和续聊通过 |
| Claude Code | 2.1.176 | sonnet / opus 别名，CLI 支持的 effort | 真实首轮和续聊通过；本机 sonnet 映射到 GLM |
| Kimi Code | 0.42.0 | 本机配置模型；强度沿用 CLI 配置 | 协议回归通过；真实请求被订阅权限 403 阻止 |
| 官方 MiMo Code | 0.1.15 | models --verbose 与模型 variants | 真实首轮和续聊通过 |

主对话可明确点名：`用 Codex 帮我检查测试`、`用 Claude Code 修改这个组件`、`用 Kimi 帮我整理代码`、`用 MiMo 帮我检查项目`。主 Agent 通过同一个 `cliworker_start` 工具的 `cli` 参数选择执行器。CLI 缺失或失败时不会自动换成其他 CLI。

侧栏“默认设置”增加 CLI 选择；每个项目为不同 CLI 单独保存偏好。强度选项随 CLI 和模型变化，Kimi 明确显示“沿用 CLI 配置”。任务树和回复均显示 CLI 名称；Claude 报告的实际模型与选择别名不同时，会额外展示实际模型。

各 CLI 需先在终端安装并登录。Desktop 不读取 `.zshrc`，插件会识别 Codex/Claude 的 `~/.local/bin`、Kimi 的 `~/.kimi-code/bin`、MiMo 的 `~/.mimocode/bin`，也可配置对应可执行文件的绝对路径。MiMo 仅适配 [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)，不是同名社区 CLI。

权限按各 CLI 的原生能力处理：Codex 使用 workspace-write/read-only 且不自动批准提权；Claude 使用 acceptEdits/plan，拒绝授权会显示失败；MiMo 使用 build/plan，保留权限检查；Kimi 的非交互模式原生自动执行，不能附加 plan 或 effort 参数，因此只读派遣会明确拒绝。其他 CLI 的行为不等同于 Antigravity 沙箱。

## v0.1.2 历史与任务查找

- 超出实时显示上限后，点击“查看更早记录”翻阅历史；每页最多 200 条，支持前后翻页和“返回实时”。历史页保持静止，后台任务照常运行。
- 任务树可按标题、模型、强度和状态筛选；筛选不会自动切换、停止任务或清空草稿。
- “复制回复”复制那条消息；“复制最新结果”复制该子 Agent 最新一轮完成结果，保留原始文本。复制失败会提示手动选择文本。
- 任务列表按创建时间保持稳定顺序，重启后不会因磁盘文件顺序改变排列。

## v0.1.1 体验更新

- 切换子 Agent 保留各自未发送的草稿（仅当前面板内存，关闭面板或刷新后不保留）。
- 连接失败保留已收到的记录，点击“重新连接”恢复订阅，不会重新执行任务。
- 向上查看历史时不强制滚动，可点击“回到最新消息”。
- 中断原因持续可见；未建立 CLI 会话时明确提示重新派遣。工具缺少最终状态时显示“本轮已结束/中断”，不伪造工具成功。

## 本地构建

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

开发中可先运行 `pnpm build:preview`，将 `.cache/preview-package` 安装到隔离 profile 验收；这不会替换 Desktop 链接的 `lib`。确认无运行中的任务后，再运行正式构建更新本机版本。

构建自动生成原生 Typert RPC 和浏览器 bundle，不需要 Harness 源码仓库。依赖版本与锁文件随仓库保存。

## 安装到 Desktop

先确保准备使用的 CLI 已安装且认证可用；Antigravity 可用 `agy models` 检查。源码目录必须保持原位：本地安装会链接此目录。

```sh
DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH" plugin --profile desktop add "$PWD"
```

安装后可在插件页点击“刷新”，确认 `dsh-cliworker-now` 显示已启用、组件运行中。

回到 Harness，在主会话标题栏点击 **↗ CLI**，或右侧栏新标签页选择 **CLI Worker**。如已打开的窗口未载入插件，重新载入该窗口。

## 使用

在已选项目的主对话中输入：

> 用 Antigravity 帮我检查这个项目的测试失败原因。

主 Agent 根据工具描述与系统提示规则调用 `cliworker_start`。首次出现 Harness 原生问题卡片，先选择该 CLI 模型，再选择模型支持的思考强度，确认后才会启动任务。取消不会启动任务。模型是否支持所选强度由 CLI 验证，不会静默替换参数。

- **默认设置**：按项目路径与 CLI 保存，影响之后新建的相同 CLI 子 Agent。
- **任务树**：主对话下所有直接子 Agent；点击切换记录。
- **工具记录**：点击展开参数、输出摘要或错误。显示 CLI 实际公开的事件，不展示不存在的内部推理。
- **停止**：等待进程及受管理子进程退出后显示中断。
- **继续**：本轮结束后输入下一项任务，沿用原模型、强度和 `conversation_id`。
- 关闭侧栏不会停止后台任务。完成结果通过 Harness Jobs 返回父 Agent。

四个主 Agent 工具：`cliworker_start`、`cliworker_status`、`cliworker_followup`、`cliworker_stop`。自然语言识别由主 Agent 完成；插件不拦截任意 shell 调用，也不接管外部启动的 CLI。

## 边界与数据

默认两个并发，同一目录有写任务时串行，同一 CLI 会话始终单轮互斥。仅两层任务树，不支持孙 Agent 或运行中插话。

Harness 规划模式或只读权限下拒绝启动；在允许执行的会话中，`read_only` 工具参数使用支持该能力的 CLI 的原生只读/plan 模式，Kimi 会拒绝此参数。Antigravity 原生沙箱与自动执行参数沿用参考 skill 的行为，它不等同于 Harness 的完整进程沙箱。

私有状态默认在 `$DSH_HOME/cliworker-now`（通常 `~/.dsh/cliworker-now`），目录 0700，文件 0600。包括项目默认值、任务索引、顺序事件和各轮原始 stdout/stderr；日志可能含项目内容，不应提交到 Git。实时界面默认展示最近 1000 条逻辑记录，较早记录可按页翻阅；原始数据保留在本机。宿主重启后，遗留运行标记为中断；不会自动重跑。相同状态目录不允许两个宿主同时拥有。

可通过配置覆盖 `executable`（Antigravity）、`codexExecutable`、`claudeExecutable`、`kimiExecutable`、`mimoExecutable`、`stateDirectory`、`maxConcurrent`、`timeoutMs`、`graceMs`、`maxLineBytes`、`maxRunBytes`、`maxTimelineItems`。默认单轮 30 分钟、16 MiB 输出；超过限制终止并明确报错。

## 卸载

```sh
DSH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH" plugin --profile desktop remove dsh-cliworker-now
```

卸载会移除插件层，保留历史状态；需要清理时可在确认不再使用后自行删除私有状态目录。

## 验收与开发

- [设计说明](doc/design.md)
- [任务与实际验证记录](doc/tasks.md)
- `pnpm smoke:real`：在 `.test-data/real-smoke` 中实际调用 Antigravity，消耗 CLI 额度，验证运行、续聊、停止。默认 `gemini-3.8-flash-low` / `low`；可通过 `CLIWORKER_SMOKE_MODEL` 选择其他已可用模型。
- `tests/fixtures/harness-command.mjs` 是仅用于隔离 Harness 验收的测试驱动，不包含在发布包中。通过正常创建的父会话调用真实工具，不手工写入父会话日志。

- `pnpm smoke:stop`：真实 CLI 启动带 PID 标记的 Node 工具子进程，停止后验证该 PID 已退出。消耗 CLI 额度。

- `node --import tsx scripts/smoke-multi.ts`：需事先确认模型和额度，验证新增 CLI 首轮/续聊。证据与运行数据仅保存在 `.test-data/`；不会自动修复账户或更改订阅。
