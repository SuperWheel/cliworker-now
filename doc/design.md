# CLI Worker Now — 设计与版本演进

## 1. 基线与范围

- 本机 macOS；DeepSeek Harness 0.2.0-rc.2（官方标签 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`）；Antigravity CLI 1.2.16。
- 独立包 `dsh-cliworker-now`，包含 Host、React Client、共享类型及 bundle patch。
- 主对话下可有多个 CLI 子 Agent，各自多轮续聊。孙 Agent、其他 CLI、运行中插话及自动 worktree 合并不在首版内。

## 2. 用户流程

1. 用户明确要求使用 Antigravity；主 Agent 调用插件工具。
2. 首次按项目及 CLI 选择真实模型 ID 与思考强度；选择完成前不启动子进程。
3. 后台运行并打开右侧栏；显示任务树、模型与强度、CLI 实际事件、工具结果和状态。
4. 同项目新任务继承默认值；更改默认值仅影响新建子 Agent。
5. 用户可停止；当前轮结束后使用原 conversation_id 续聊。

## 3. 结构与接口

- Host：项目偏好、会话索引、运行调度、Antigravity 适配器和持久化。
- Client：原生右侧栏注册、两层任务树、实时记录、配置入口、停止和续聊。
- 通信：Harness Gateway/Typert RPC；查询配置、快照、事件流和执行操作。
- 模型工具：`cliworker_start`、`cliworker_status`、`cliworker_followup`、`cliworker_stop`。
- 独立保存 workerId、Harness parentSessionId 和外部 conversation_id。每轮运行独立记录，事件带单调递增序号。
- 自然语言路由通过工具描述及作用域内提示规则完成。只管理通过插件启动的进程。

## 4. 生命周期与边界

- 状态：等待配置、排队、运行、停止中、完成、失败、中断。
- 默认最多两个并发；同会话单轮互斥，同目录写任务串行。
- argv 显式传递 model/effort；解析 stream-json；stderr 与对话区分。失效模型或参数提示重选，不静默回退。
- 沿用旧 skill 的目录校验、默认沙箱、私有文件权限；遵循宿主权限及规划模式。
- 关闭侧栏不取消任务；断线重连恢复记录；宿主重启将遗留运行标为中断。
- 停止等待受管理进程范围清理；认证或权限失败不自动重试。
- 后台任务完成向父 Agent 返回结果摘要；全部过程保留在插件存储。

## 5. 视觉设计

v0.3.0 采用用户确认的 B 桌面侧栏方案：父级为按 CLI 分组的任务总览，子级为独立对话页。圆角矩形、轻透明表面、扁平层级与 Harness 明暗主题同步。话题后显示状态圆点和文字，下行显示模型与强度值（无“思考”前缀）。子级标题左侧是仅箭头的圆角返回按钮，标题下不显示模型/强度标签；底部续聊框保留模型，用户消息居右，Agent 文字居左。工具输出折叠显示。运行时禁用续聊；向上阅读时不强制滚到底部。空态、等待、异常和中断提供明确动作。

## 6. 验收

首次选择、跨项目隔离、流式分片、错误退出、会话 ID 不一致、并发与重复调用、取消清理、续聊、重连、主题及窄屏均需测试。真实 Antigravity 运行、停止、续聊分别留证。模拟验证不得记作真实运行成功。

## 7. 参考

- 官方插件安装：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/basic/publish.md
- 右侧栏：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-sidebar-right/README.md
- Remote API：https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/cookbook/adding-a-remote-api.md
- 旧 skill：`~/.agents/skills/cliworker-agy/`，仅参考，不改写其状态或文件。

## 8. 实现决策

- Host API：`catalog(parentSessionId)`、`configure(parentSessionId, JSON preference)`、`watch(parentSessionId, workerId)`、`followup(parentSessionId, workerId, prompt)`、`stop(parentSessionId, workerId)`。Gateway 传输采用官方生成器提供的校验契约；模型/配置和快照为 JSON 字符串。恢复父 Agent 使用与原生 Remote Agent 参数相同的 Typert lookup resolver。
- 流每次提供权威快照，客户端整体替换并确认消费，避免断线重连重复追加。事件在磁盘按 worker 内 seq 累加、每轮 runId 隔离。客户端默认保留最近 1000 个逻辑行，原始事件在磁盘完整保存。
- `agy 1.2.16` 使用 `init`、`step_update` 和 `result`；工具输出可能只有 CLI 提供的摘要，不扩写为未收到的详细内容。文本增量合并，最终回答校准最后一条 assistant 消息。
- 独立插件构建时将 npm 已发布的协议声明临时放入 `.cache/typert/packages`，满足官方生成器的 workspace inventory 约定；不修改 Harness，也不依赖上游源码 checkout。
- 所有进程走 `ctx.subprocess`。任务使用原生 terminal 进程树管理，Node bridge 保持 stdout/stderr 独立并转发真实字节；周期观察保留 PID 与启动身份，覆盖 CLI 工具另建进程组的情况。停止和异常均执行 terminate + waitForExit；无法确认清理时拒绝后续派遣，避免同目录写进程重叠。每轮输出和超时有限制。
- `--disable-slash-commands` 会让 Antigravity 的 `--mode plan` 失效，因此不使用该组合；任务文本加普通前缀，防止首行直接成为 slash command。
- 宿主处于规划或只读模式时拒绝派遣。这是 MVP 的显式限制：Antigravity 需写自身状态，原生终端沙箱无法等价实现 Harness 的全进程只读约束。
- 本版界面文案为中文，模型 ID 与强度保留 CLI 原值；颜色、字体和按钮复用宿主主题。对话按纯文本安全展示，工具内容默认折叠。

## 9. v0.1.1 体验与稳定性

- 视图生命周期按父会话隔离；切换 worker 时只保留同父会话任务树，清空旧 worker 内容直到新快照到达。异步提交按原 worker 清理已提交草稿，错误归属原任务，旧请求不能覆盖当前任务输入。
- 草稿仅在面板内存按 worker ID 保存；不写 localStorage，也不包含于服务器日志。关闭面板/刷新页面会丢弃未发送内容。
- 连接失败保留最后快照、禁用续聊并提供重新连接；重新订阅只读快照，绝不自动重发任务。底层 Gateway 的正常自动重连继续由 Harness 管理。
- 用户离开记录底部时保持滚动位置并显示“回到最新消息”。加载中的界面不误显示为空任务。
- 终止事件记录明确的状态；启动恢复会追加一次 interrupted 事件。工具保持 CLI 原始状态，同时标记轮次已结束，未收到最终工具结果不推断成功。旧版当前轮通过 worker 持久化状态兼容显示。
- `build:preview` 创建隔离的包快照供验收，正式构建与 Desktop 升级在验收后完成。

- 每轮完成结果为独立快照，续聊不能改变上一轮的 status/runId/response；后台结果包含 workerId、runId 和任务摘要，续聊通知标签区分新任务，提示父 Agent 读取本轮输出。此机制提供准确上下文，不保证上游模型一定正确复述。

## 10. v0.1.2 历史浏览与任务查找

- `history(parentSessionId, workerId, anchor, direction)` 是只读 Gateway API；Host 校验父任务所有权和 worker 内的逻辑行 ID。anchor 排除在结果之外，direction 仅 before/after，每页最多 200 条；无效、跨任务的 anchor 明确报错。
- 返回 HistoryPage（workerId、items、start/end、total、hasOlder/hasNewer）；区间及总数是读取当时的值。按稳定逻辑 ID 翻页，不使用会被实时新增事件移动的倒数偏移量。
- 历史阅读仅保存当前页，不无限累积 DOM；后台订阅持续更新任务状态和最新记录，旧页冻结且滚动不受影响。返回实时切回当前快照；提交新续聊后回到实时。切换任务忽略旧的异步页响应。
- 列表按 createdAt、id 排序；筛选只改变父级可见行，允许清除筛选，保留各任务草稿；子级返回时恢复列表状态。
- 复制复用 Harness writeClipboard，只有宿主接受写入才显示成功；失败提供手动复制提示。历史消息复制和最新完成结果复制分开，不读取或上传用户剪贴板内容。

## 11. v0.2.0 多 CLI Worker

- 用户要求本轮扩展 Codex、Claude Code、Kimi、MiMo。共享任务树、生命周期、分页、停止和续聊；CLI 专属行为集中在 `host/adapters.ts` 与 `host/cli-protocol.ts`。
- Preference 增加可选 cli。旧记录缺少 cli 时明确解释为 antigravity，旧偏好文件路径保持不变；其他 CLI 使用项目路径与 cli 的组合哈希。已有 worker 的 CLI、模型、强度固定，续聊不能切换执行器。
- 四个工具保持不变，start 增加 cli 参数，提示规则按用户明确点名路由。主对话首次先选模型，再选择该模型支持的强度；仅一个值时明确沿用该值。配置校验发生在派遣前，不静默替换模型。
- Codex：本机 models_cache.json 提供模型和 reasoning levels；缓存不是远端可用性保证。exec --json，续聊精确 resume ID；read-only/workspace-write 与 approval_policy=never 显式覆盖，不使用全权限 bypass。
- Claude Code：官方 sonnet/opus 别名，强度来自本机 --help。-p --verbose --output-format stream-json，acceptEdits/plan，--resume 精确 ID。保留权限检查，permission_denials 使运行失败。CLI init 报告的实际模型另行展示，防止本机别名映射掩盖真实提供商模型。
- Kimi Code：provider list --json 只提取模型字段，不存储 providers 凭据。当前 0.42.0 的 -p 不接受强度或 plan 参数，强度展示“沿用 CLI 配置”，只读请求在创建 worker 前拒绝。非交互原生 auto 工具策略在选择卡片和设置中说明。仅依据 stream-json 的 session.resume_hint 保存会话 ID，绝不通过“最新会话”猜测；干净退出、回复和会话凭据共同构成完成条件。
- MiMo 指 XiaomiMiMo/MiMo-Code 官方 CLI；不适配同名社区实现。models --verbose 读取模型 variants，run --format json，--agent build/plan，--variant 与 --session。保留权限检查，不添加 --yolo；stop step + EOF + 零退出码才标记成功。CLI 未安装时明确失败，不改为其他 CLI。
- 所有输出按各 CLI 实际公开粒度显示，不承诺逐 token；不展示 reasoning 事件。子 CLI 自行产生的孙 Agent 不纳入任务树。未知协议、非零退出或缺少会话标识不会标记为成功。
- 可分别设置 codexExecutable、claudeExecutable、kimiExecutable、mimoExecutable；原 executable 继续仅指 Antigravity，所有 CLI 共用进程上限和同目录写任务互斥。

协议参考（核验于 2026-10-04）：本机 CLI --help；Claude https://code.claude.com/docs/en/headless；Kimi https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/cli/prompt-render.ts；MiMo https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/cli/src/cli/cmd/run.ts。

## 12. CLI 卡片图标（v0.3.0 已接入）

- 父级 CLI 分组名称左侧使用统一 24px／32px 图标槽，等比显示并做光学居中，名称间距 8px；不增加独立不透明底板。
- 基于官方参考素材制作 Antigravity、Codex、Claude Code、Kimi、MiMo Code 的透明扁平 PNG。Kimi 按宿主亮暗主题切换深浅 K 字，其余共用单图。
- MiMo 使用官方像素字标提炼的 M 适配图，不宣称为官方独立图标。素材设计阶段未改变运行界面；v0.3.0 按用户提供的素材包原样接入。
- 素材、原始来源、生成提示词和实际尺寸预览见 [图标说明](assets/cli-icons/v1/README.md)。

项目独立图标：v1 的主终端与子会话块被用户否定，原因是过于接近 Codex。第二轮移除终端符号，提供会话气泡、任务分派、Worker W 三种扁平透明方向，见 [第二轮候选](assets/project-icon/v2/README.md)。第二轮方案未采用；当前采用下述 v3。

项目 Logo 新设计稿 v3：以打开的会话窗口、三条并列会话和状态圆点表达“让每个 Agent 的工作过程可见”。使用蓝色双调、圆角扁平形状及透明背景；同一 PNG 已检查亮暗背景和 24px／32px／48px 展示。见 [会话可见 Logo](assets/project-icon/v3/README.md)，已在 v0.3.0 用作总览标题、侧栏入口和新标签页引导图标。

## 13. v0.3.0 桌面父子页面

- 页面状态由当前 parentSessionId 内的 selected workerId 控制；空值为总览。返回恢复列表滚动位置与键盘焦点，进入子级聚焦返回按钮；草稿仍只在面板内存中保存。
- 总览保留搜索与状态筛选，CLI 分组可折叠；列表保留稳定创建顺序。标题、元数据左侧对齐，长标题/模型省略，完整文本可悬停查看。
- 子级通过原 Gateway watch/history/followup/stop 接口工作；不改 Host、会话协议或进程权限。历史页、断线重连、持久化错误和无法续聊提示继续保留。
- 标题右侧原生 details 菜单展示 CLI、任务模式、实际模型差异、复制最新结果和默认设置。输入框固定显示会话模型，不提供不能兑现的模型切换、附件或新增动作。
- 样式使用 Harness 的语义主题 token 与原生 Button；不保存独立主题。Kimi 根据宿主 body[data-ds-dark-theme] 切换原图，全部七张 PNG 构建时内联，卸载仍清理注册和样式。
- 根容器与对话内容分别限制滚动；屏幕阅读器标签在消息内定位，避免输入框聚焦时引发宿主面板外层滚动。

## 14. v0.3.1 原生参数与控件

- 搜索使用 `@deepseek-ai/dsh-client-ui-primitives` 的 Input，状态筛选使用 Button size=md。字体、行高、按钮高度、描边、焦点样式由原生组件维护，不用插件 CSS 覆盖。
- 自定义页面使用 `--dsw-font-s-14-font-size/line-height` 与 `--dsw-font-xxs-12-font-size`；对话/续聊使用 `--dsh-content-font-size` 与 `--dsh-content-font-delta`。前者遵循宿主 UI 字体尺度，后者响应宿主会话字号偏好。
- 圆角使用 `--dsw-radius-md/lg/panel`；自定义边框沿用原生 0.5px 描边与 `--dsw-alias-border-l2/l3`，续聊外壳使用主 composer 的 `--dsw-elevation-soft`、`--dsw-elevation-stroke-color` 与 `--dsw-specific-input-major`。
- 主对话 composer 在该版本没有可独立绑定 Worker 发送回调的公开组件出口，它的输入接口由 Harness session 作用域持有；因此复用外观参数与原生基础控件，保留 Worker 的 followup/stop 语义，不引用私有哈希类名、不读取主会话草稿。
- 任务行取消为 CLI 图标预留的 43px 缩进，标题和元数据以 12px 边距左对齐；展开分组标题底部显示全宽细线。窄侧栏不再缩小字体。

## 15. v0.3.2 原生消息、输入框与菜单

- 源码核验：primitives 的 IconSettingsOutlineRegular / IconSendOutlineRegular / IconCopyOutlineRegular / Menu / MarkdownText；ui-chat 的 userStack/bubble/actions；ui-conversation 的 composer card/input/row/primary；ui-sidebar 的 newSession。
- 直接使用上述公开基础组件；自定义 composer 按原生几何：8px 顶内边距、36px 最小正文区、12px 间隙、42px 操作行，空态总高 98px；发送按钮 34px 圆形 info-fill，面板圆角/柔和阴影由宿主参数控制。禁用手动 resize，随输入自动增高，上限 336px。
- 原生 Menu 向上弹出并通过 portal 避免侧栏裁切；取消/切页清理模型目录查询的迟到响应。选择模型下的强度只调用 configure 更新项目/CLI 默认，不改变已存在 worker，不派发任务。
- 当前会话模型/强度与 CLI 实际模型明确展示；模型目录不会根据快照对象更新反复请求，仅在菜单打开或执行器改变时读取。
- 消息气泡采用 native xl 圆角、10px/16px 内边距、82% 最大宽度；时间固定中文 24 小时制，复制控件在下方。助手文本交给原生 MarkdownText，禁用原始 HTML 的宿主渲染器承担转义；复制仍使用原文。
- 搜索框高 38px，保持 border-l3 的半像素中性描边，聚焦不加蓝色光圈。卡片和搜索描边与新会话按钮使用同一语义色。底部信息行只显示可核查状态，缺失的 token/速度/上下文不补造。
