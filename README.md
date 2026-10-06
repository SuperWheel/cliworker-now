# CLI Worker Now

DeepSeek Harness 的多 CLI 实时侧栏插件，支持 Antigravity、Codex、Claude Code、Kimi、小米官方 MiMo Code，以及 ZCode、Grok Build、OMP、Pi、Harness 和 OpenCode。模型先由你选择，之后按项目与 CLI 分别沿用；每个子 Agent 都有独立记录，支持停止与结束后续聊。

兼容基线：macOS、Harness **0.2.0-rc.2**、Antigravity CLI **1.2.16**、Node ≥22.19。

## 智能体预设与命名

- 新建子智能体时，在模型和思考强度之后选择角色预设；已有项目模型默认值仍会沿用，但每个新智能体都会单独询问角色。选择“其他”可直接写临时提示词，选择“不使用角色预设”只执行任务本身。未回答或取消不会启动任务。
- 默认装配 **商业审稿人、逻辑审校员、文风审校员、正文修订师、剧情节点设计师、剧情结构规划师、小说主笔**。来源与保留边界见 [默认小说智能体](doc/role-presets.md)。它们是可编辑的提示词，不会复制原小说项目、安装技能依赖或自动派遣其他 CLI。
- 点击设置中的“智能体预设”，以名称和概述卡片管理角色，可新增、编辑、删除。预设库属于当前 Harness profile，在各 CLI 间共用；每个 worker 保留创建时的独立角色副本，后续编辑或删除预设不会改变已有对话。临时提示词不自动保存进预设库。
- 每个 worker 自动得到唯一名称，也可在派遣时指定名称，或在对话菜单中重命名。例如：“让逻辑审校员-1 继续检查下一章。”主 Agent 可通过 `worker_name` 找到同一主会话中的 worker 并续聊；不会模糊匹配或跨主会话复用。重命名只改变调用名称，保留角色、模型与 CLI 会话。
- 总览第二行显示“智能体名称｜模型 · 强度”，对话页标题显示“智能体名称｜主题”。旧记录显示稳定的临时名称，无需改写旧会话即可查看或重命名。

新增六个 CLI 保留独立原生协议，复用项目偏好、两层任务树、停止与续聊。设置页已接入其账号管理：支持原生终端的 CLI 可在插件内打开账号终端，使用 Harness 凭据引用的 API 路由通过原生模型设置管理。Grok 的真实模型任务/订阅可用性仍未验收；模型目录或本地凭据存在不代表远端账号可用。

新增适配器首版范围：

| CLI | 目录与执行 | 权限与边界 |
| --- | --- | --- |
| ZCode 0.16.9 | 配套本机内置目录中的 GLM-5.3-Flash；原生 headless 与 session ID | plan/edit 显式设置，交互权限请求拒绝；独立原生授权目录 |
| Grok Build 1.0.0 | ACP 动态目录；headless 适配仅离线验证 | 外层只读/项目写入沙箱；未做真实模型测试 |
| OMP 16.4.4 | RPC，已验收智谱 Coding CN GLM-5.3-Flash | 显式 write 审批、禁模型回退；首版读取/搜索/编辑工具 |
| Pi 1.0.2 | RPC，原生 zai-coding-cn/GLM-5.3-Flash | 等待 agent_settled；首版读取/搜索/编辑工具 |
| Harness 0.2.0-rc.2 | ACP 原生目录，headless 执行与原 session ID | 使用自身 read-only/workspace-write 沙箱，避免双层 Seatbelt 冲突 |
| OpenCode 1.18.21 | 原生 models 与 run JSONL；智谱 GLM-5.3-Flash 已实测 | build/plan、额外权限默认拒绝；免费 MiMo 返回403，未绕过限制 |

除 Harness 使用其原生沙箱外，新增适配器当前要求 macOS Seatbelt；规划模式只允许私有运行状态写入，执行模式额外允许当前项目。Pi/OMP 首版不开放 Bash 或子代理。失败工具、权限拒绝和缺失终态均不视为成功，即使 CLI 退出 0。

ZCode 显式禁用原生子代理、Skill、工作流调度、跨会话工具及 node_repl；原生 CLI 仍会加载用户的全局插件/MCP 配置，已获原生规则允许的 MCP 工具可能执行。无头模式只拒绝需要交互的审批请求，不能等同于关闭全部 MCP。插件不改写用户全局或项目配置。

可通过插件配置设置 `zcodeExecutable`、`grokExecutable`、`ompExecutable`、`piExecutable`、`harnessExecutable`、`opencodeExecutable`。ZCode 的 `zcodeAuthDirectory` 可指定独立授权目录，默认在插件私有状态的 `accounts/zcode` 下，由设置页原生登录流程管理；`zcodeBuiltinConfig` 可指向配套内置目录文件。账号目录在任务中只读，需刷新授权时通过账号终端完成。Pi 使用官方包 `@earendil-works/pi-coding-agent`，不依赖临时安装目录；本机已固定在私有 `~/.local/share/cliworker-now/runtimes/pi-1.0.2`。

若明确要复用 Harness 智谱凭据，设置 `zaiCredentialRef: ZAI_CODING_CN_API_KEY`。Host 每次通过原生 credentials 服务解析该引用，只向选定的 Pi/OMP/Harness/OpenCode 子进程注入对应环境变量；不把密钥存入插件偏好、argv 或页面。不会自动复用其他 CLI 的账号；OpenCode 未设置引用时使用下述插件私有原生账号目录。OMP 的 `cliworker-zai-cn` 是插件注册的隔离 Provider，不冒充原生内置 Provider。

验证说明：[ZCode](doc/zcode-probe.md)、[Grok](doc/grok-probe.md)、[Pi/OMP](doc/pi-omp-probe.md)、[Harness](doc/harness-probe.md)、[OpenCode](doc/opencode-probe.md)。`node --import tsx scripts/smoke-extended.ts --help` 查看真实适配器验收入口；`--catalog-only` 不发送模型任务。

## v0.5.1 新增六个 CLI 的账号管理

| CLI | 设置页入口与实际账号来源 |
| --- | --- |
| ZCode | 支持原生登录、退出和 TUI；账号保存在独立 `accounts/zcode` 目录，与 ZCode worker 共用。 |
| Grok Build | 支持原生登录、退出和账号终端；沿用本机 Grok 账号，退出会影响其他使用同一账号的终端。 |
| OMP、Pi | “登录设置”直接在终端打开原生提供商登录界面；OMP 使用 `setup`，Pi 1.0.2 使用其原生登录 UI。无需先配置 API 或拥有订阅。账号保存在插件私有目录，关闭窗口后保留。 |
| Harness | 已安装的 0.2.0-rc.2 不提供终端登录命令或 TUI；按钮禁用并说明版本限制，不再跳转到 Harness 设置。 |
| OpenCode | “登录设置”使用原生 `auth login` 提供商选择器，登录状态保存在私有共享原生账号目录。 |

ZCode 和 Grok 的绿色“已登录”与账号名称来自本地原生登录记录，不代表远程订阅验证。ZCode 0.16.9 的 AES-GCM 记录只在 Host 内解析；Grok 读取原生 OIDC 会话。凭据、令牌和未筛选的账号数据不会传到侧栏。

登录设置不会自动改变已有任务的模型或凭据来源。Pi/OMP/Harness 和配置了 `zaiCredentialRef` 的 OpenCode 任务仍按原先显式选择的智谱 API 路由执行；终端里的 OAuth 登录不自动替代该路由。OpenCode 的“账号终端”仍沿用任务的显式来源，而“登录设置”管理原生提供商凭据。

OpenCode 无引用模式的原生凭据位于 `<stateDirectory>/accounts/opencode/data/opencode/auth.json`，登录终端、worker 和模型目录共用这份账号；各自运行数据库、配置和缓存独立。原生 OAuth 刷新允许写入该共享账号目录，规划模式仍禁止写项目。关闭账号终端后删除该终端的临时运行目录，保留共享凭据和 worker 历史。

未显式指定 `zcodeExecutable` 时，优先使用已安装的完整 CLI：`~/.local/share/cliworker-now/runtimes/zcode/cli/zcode.cjs`；不存在时回落到 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。插件会检查实际 `--help` 能力；若回落版本不支持 `login [zai|bigmodel]`，设置页会明确提示配置完整 CLI，不尝试不存在的登录命令。

账号状态仅投影允许展示的摘要。`已配置` / `verification=local` 表示本地文件或凭据引用存在，不代表已通过远程登录、套餐或额度验证；不展示密钥、令牌或原始错误。账号终端由用户直接操作，与该 CLI 的活动任务互斥，关闭、取消或切换 CLI 会清理受管理的进程。

## v0.4.0 设置与账号管理

- 标题栏入口是 Finder 左侧的 24px Logo 小按钮；侧栏标题下取消分隔线。
- 设置使用 Harness 原生 Modal，按 CLI 管理账号和项目默认模型。模型、账号状态和保存分别加载，显示原生转圈提示；关闭与切 CLI 不被查询锁住。
- 登录、切换账号、退出通过独立弹窗中的 CLI 原生账号终端操作。插件只显示安全的认证摘要与账号标识，不向页面传输或另存密钥；Antigravity 的账号标识从本地登录元数据投影，终端输出仅保留于有界内存。Antigravity 与 Kimi 的部分操作需要按提示手动输入原生斜杠命令。
- 关闭设置或断开终端连接会清理账号进程；同一个 CLI 的任务与账号操作互斥。仅有配置但没有登录证据时显示未知或已配置；本地保存的登录会话明确注明未进行远程验证。

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

各 CLI 需先安装；可在插件设置中登录或继续使用独立终端登录。Desktop 不读取 `.zshrc`，插件会识别 Codex/Claude 的 `~/.local/bin`、Kimi 的 `~/.kimi-code/bin`、MiMo 的 `~/.mimocode/bin`，也可配置对应可执行文件的绝对路径。MiMo 仅适配 [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)，不是同名社区 CLI。

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

回到 Harness，在主会话标题栏点击 Finder 左侧的 **项目 Logo** 小按钮，或右侧栏新标签页选择 **CLI Worker**。如已打开的窗口未载入插件，重新载入该窗口。

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

五类 CLI 图标见 [图标说明](doc/assets/cli-icons/v1/README.md)，项目使用 [正式 Logo v1](doc/assets/project-icon/official-v1/README.md)。已按用户提供的素材包原样接入 `src/client/assets/`，构建时内联到浏览器包，不依赖外部图片服务。此前方案保留作设计历史。

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


### v0.4.1 每个 CLI 独立开关与稳定设置布局

设置页顶部显示当前 CLI 图标、名称和 Harness 原生开关。开关按当前 Harness 运行配置持久化，默认全部开启；关闭后保留历史记录，阻止新的派遣、续聊、模型查询和账号终端操作。正在运行或排队的任务、打开的账号终端会阻止关闭，避免意外中断。

左侧状态点：确认已登录为绿色，未登录、不可用或查询失败为红色，未核验状态为灰色。Antigravity 实际模型目录读取成功可显示绿色，提示中明确区分目录可用与账号验证；本地凭据存在不等于登录有效。关闭的 CLI 图标与文字置灰，本次操作不改变位置，刷新页面或重新打开设置后排到末尾。

弹窗使用固定高度并随较小窗口限制最大高度，右侧内容独立滚动。加载期间保留账号按钮、模型与强度选择器、保存按钮的位置，只在区域标题旁显示原生旋转指示。设置操作按钮采用原生 md 高度 36px，模型和强度选择框宽 300px、窄窗口自动收缩，继续保留灰色按钮的 180ms 悬停颜色过渡。


### v0.4.2 原生设置排版与账号身份

设置页采用更醒目的 40px 品牌图标与 24px CLI 标题，配合原生设置页的左侧说明、右侧控件和细分隔线。弹窗维持固定高度与内部滚动；模型/强度控件缩至 240px 内，按钮继续使用原生 36px 高度及灰色悬停过渡。

登录区使用绿色圆点与“已登录”，并显示 CLI 提供的账号邮箱；API 方式统一显示“API 登录”，不显示密钥或其片段。Antigravity 读取本地保存的会话邮箱，注明“本地登录信息，未进行远程验证”；Codex 通过自身 account/read 查询实际使用的账号，兼容文件和钥匙串存储；Claude 使用原生 auth status。CLI 没有提供账号标识时明确提示，Kimi 仅有 provider 配置时仍显示“已配置”。刷新、切换、禁用或查询失败时不会残留旧账号。


### v0.4.3 正式 Logo 与账号操作

侧栏标题使用最新选定的正式 Logo 原图、紧凑的 `cli worker` 字标和 `NOW` 标识，工具栏入口与空状态同步。账号行保留绿色登录状态与账号，红色“退出”紧邻账号；“切换账号”和“账号终端”采用原生浅描边按钮。账号/模型刷新使用原生刷新图标。账号来源说明移入登录状态的悬停提示，移除两条静态模型备注。

点击账号操作立即打开 Harness 原生弹窗，终端不会落在设置页滚动区域底部。初始化失败或超过 20 秒会显示可重试反馈；Host 的终端分配受 30 秒上限约束，取消后晚到的进程仍会清理。清理完成前保持同 CLI 互斥。Antigravity 登录需要按弹窗提示，在原生终端输入 `/login`；插件不会自动输入账号命令或代替用户授权。
