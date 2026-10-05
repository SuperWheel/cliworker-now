# CLI Worker Now

DeepSeek Harness 的多 CLI 实时侧栏插件，支持 Antigravity、Codex、Claude Code、Kimi 和小米官方 MiMo Code。模型先由你选择，之后按项目与 CLI 分别沿用；每个子 Agent 都有独立记录，支持停止与结束后续聊。

兼容基线：macOS、Harness **0.2.0-rc.2**、Antigravity CLI **1.2.16**、Node ≥22.19。

## v0.3.2 对话与输入框原生体验

- 主会话 CLI 入口采用浅色扁平按钮，设置/发送/复制使用 Harness 原生图标；搜索框高 38px，输入聚焦不出现蓝色描边。
- 用户消息与回复的时间、复制操作移到消息下方；Agent 回复使用原生安全 Markdown 渲染。原始复制文本保持不变。
- 续聊框沿用原生 composer 的尺寸、圆角、底栏和蓝色圆形发送按钮；取消手动拖高，内容自动增高至上限后内部滚动。
- 点击模型与强度打开原生菜单，两项入口分别选择模型和思考强度。本轮结束后可修改当前会话模型/强度，下一轮续聊使用新配置并保留会话 ID。
- 输入框下方显示真实任务状态、Token 用量和上下文占用；CLI 未提供的数值不仿造。

## v0.3.1 原生样式同步

- 搜索框直接使用 Harness `Input`，筛选按钮使用标准尺寸 `Button`（当前高 36px），由宿主组件维护字体、描边和交互状态。
- 自定义页面文字引用宿主字号变量；对话正文和续聊框跟随 Harness 的“字号大小”设置。卡片、返回按钮和菜单引用主题圆角、描边与阴影，不另设亮暗颜色。
- 任务标题与元数据统一靠卡片左侧 12px 对齐，CLI 分组标题与任务列表之间增加细分隔线。
- 续聊框复用主对话的输入背景、圆角与阴影参数，发送仍通过 Worker API，避免绑定到主 Agent 会话。

## v0.3.0 桌面侧栏设计

- 父级总览按 CLI 分组为可折叠圆角卡片；话题后紧跟状态圆点与文字，下方显示模型和强度值。
- 点击任务进入独立对话页；左上角圆角返回按钮回到列表，保留筛选、列表位置和未提交草稿。
- 对话页标题下不再显示模型/强度标签；用户消息居右、Agent 回复居左，底部为桌面式续聊框。模型显示在输入框底部，停止按钮在运行时替换发送按钮。
- 使用提供的项目 Logo 与五类 CLI 透明图标，Kimi 图标随 Harness 亮暗主题切换；颜色继承宿主主题。
- “任务选项”（标题右侧省略号）保留复制最新结果、默认设置和 CLI 实际模型信息。

## v0.2.0 多 CLI

| CLI | 核验版本 | 模型与强度 | 当前验收状态 |
| --- | --- | --- | --- |
| Antigravity | 1.2.16 | 动态目录合并模型，强度仅为已存在的变体 | 原功能保留与回归通过 |
| Codex | 0.160.0 | 本机模型缓存及各模型 reasoning levels | 真实首轮和续聊通过 |
| Claude Code | 2.1.176 | sonnet / opus 别名，CLI 支持的 effort | 真实首轮和续聊通过；本机 sonnet 映射到 GLM |
| Kimi Code | 0.42.0 | 本机配置模型；强度沿用 CLI 配置 | 协议回归通过；真实请求被订阅权限 403 阻止 |
| 官方 MiMo Code | 0.1.15 | models --verbose 与模型 variants | 真实首轮和续聊通过 |

主对话可明确点名：`用 Codex 帮我检查测试`、`用 Claude Code 修改这个组件`、`用 Kimi 帮我整理代码`、`用 MiMo 帮我检查项目`。主 Agent 通过同一个 `cliworker_start` 工具的 `cli` 参数选择执行器。CLI 缺失或失败时不会自动换成其他 CLI。

侧栏“默认设置”增加 CLI 选择；每个项目为不同 CLI 单独保存偏好。强度选项随 CLI 和模型变化，Kimi 明确显示“沿用 CLI 配置”。总览按 CLI 名称分组；Claude 报告的实际模型与选择别名不同时，在子级“任务选项”和底部模型提示中展示实际模型。

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

回到 Harness，在主会话标题栏点击 带项目图标的 **CLI** 按钮，或右侧栏新标签页选择 **CLI Worker**。如已打开的窗口未载入插件，重新载入该窗口。

## 使用

在已选项目的主对话中输入：

> 用 Antigravity 帮我检查这个项目的测试失败原因。

主 Agent 根据工具描述与系统提示规则调用 `cliworker_start`。首次出现 Harness 原生问题卡片，先选择该 CLI 模型，再选择模型支持的思考强度，确认后才会启动任务。取消不会启动任务。模型强度仅来自 CLI 实际目录或已公开能力，不提供推测等级。

- **默认设置**：按项目路径与 CLI 保存，影响之后新建的相同 CLI 子 Agent。
- **子 Agent 总览**：当前主对话下所有直接子 Agent，按 CLI 分组；点击进入对话，用左上角箭头返回。
- **工具记录**：点击展开参数、输出摘要或错误。显示 CLI 实际公开的事件，不展示不存在的内部推理。
- **停止**：等待进程及受管理子进程退出后显示中断。
- **继续**：本轮结束后输入下一项任务，使用当前已保存的模型、强度并沿用原 `conversation_id`。
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

## 页面图标设计素材

五类 CLI 图标见 [图标说明](doc/assets/cli-icons/v1/README.md)，项目使用 [会话可见 Logo v3](doc/assets/project-icon/v3/README.md)。已按用户提供的素材包原样接入 `src/client/assets/`，构建时内联到浏览器包，不依赖外部图片服务。此前方案保留作设计历史。

## v0.3.3 模型菜单与接口修复

- Antigravity 的 `-low/-medium/-high` 变体在界面中合并，选择强度后映射回真实 CLI ID。Flash 当前支持 low/medium/high；Pro 仅 low/high；未公开等级的型号显示“沿用 CLI 配置”，不发送 `--effort`。
- 会话内选择器修改当前空闲 worker；默认设置仍只影响此项目之后的新任务。运行中不能修改配置或切换 CLI。
- 每轮显示真实耗时（含排队与启动时间），可展开 CLI 已公开的工作记录。没有公开的思考内容不会生成或补写。
- 发送按钮使用 Harness 0.2.0-rc.2 InputBar 的同一 SVG 路径、34px 圆形样式和主题 token。模型选择使用原生 Menu，并按 ModelSelect 的两项入口和列表样式适配 CLI 目录；不能直接使用其绑定 Harness 主模型的内部状态。
- **升级本地链接插件后，确认无活动任务，完整退出并重新打开 Desktop。** 插件页“刷新”只刷新目录并不足以重新加载 Host 接口。已定位并验证：旧 Host + 新 Client 会导致 `catalogForCli` HTTP 404，完整重启后模型查询恢复。加载失败时提供中文说明和重试，不把原始 HTTP 堆栈混入对话或模型选项。

## v0.3.4 菜单与按钮微调

模型与思考强度子菜单的“返回”统一位于顶部。插件按钮取消静态描边，鼠标移入/移出采用 180ms 主题色过渡；遵循系统“减少动态效果”，键盘导航保留可见焦点。卡片与输入框仍使用 Harness 原生表面样式。

### v0.3.5 用量与日期

回复信息栏显示 CLI 实际报告的 Token 用量，日期与 Harness 一致：当天为时间，跨天为日期与时间，跨年增加年份。输入框底栏按“任务状态 / Token 用量 / 上下文占用”排列，复用原生数据库图标和主题样式，状态使用彩色圆点。

统计从插件私有原始记录只读恢复，已有对话无需重新运行。Antigravity 区分回复计数与会话累计；Codex 使用 CLI 报告值、不跨轮重复相加；Claude 和 MiMo 使用本轮统计。点击用量可查看统计口径与精确数字。没有真实数据时显示 `—`，不以累计 Token 推测上下文百分比。

### v0.3.6 原生交互与上下文

分隔线使用 Harness 原生 `border-l2`；复制按钮使用原生 Tooltip，模型菜单继续使用原生 Menu。按钮的悬停颜色、区域尺寸、圆角与动效按 Desktop 0.2.0-rc.2 对应控件对齐，用量与上下文弹窗复用原生定位、外部点击关闭能力，支持 Esc。底栏状态恢复为不同颜色的圆点。

Antigravity CLI 1.2.16 的流式输出没有上下文容量，但本地会话元数据提供了最近一次请求的估算占用及容量。插件仅对自己管理的 conversation_id 只读查询对应 SQLite 数据库，校验会话归属后读取这两个数值；详情中明确标注估算来源。这不是累计 Token 用量，也不是对下一条消息的预测。未知版本、缺失或损坏数据仍显示 `—`，不猜测模型容量。


### v0.3.7 暗色卡片与 v8 Logo

暗色 CLI 分组卡片与未选中的筛选按钮使用同一个主题底色。顶部入口移至会话右侧工具栏，仅显示 v8 Logo，悬停提示仍为“打开 CLI Worker”；侧栏标题、空状态和入口统一使用 v8 透明原图，保持宽高比。灰色按钮恢复 180ms 颜色过渡；禁用按钮仅有视觉反馈，不能触发操作，系统减少动态效果设置仍生效。


### v0.3.8 白天模式悬停修复

白天模式的灰色筛选按钮、返回按钮和禁用灰色控件，悬停时改用更深一级的原生 active 主题色，避免默认灰色与 hover-solid 视觉相同；保留 180ms 过渡和减少动态效果支持。
