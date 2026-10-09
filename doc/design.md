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
- Preference 增加可选 cli。旧记录缺少 cli 时明确解释为 antigravity，旧偏好文件路径保持不变；其他 CLI 使用项目路径与 cli 的组合哈希。已有 worker 的 CLI 固定；v0.3.3 起空闲时可修改模型/强度，续聊仍沿用原会话 ID，不能切换执行器。
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
- 标题右侧原生 details 菜单展示 CLI、任务模式、实际模型差异、复制最新结果和默认设置。输入框显示会话模型；v0.3.3 起允许空闲时切换已验证型号，不提供 CLI 不支持的附件或权限按钮。
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

## v0.3.3 配置与呈现修订

- `ModelChoice.variants` 保存各强度到真实 CLI ID 的映射；Antigravity 只依据 `agy models` 的 ID 后缀及名称括号共同识别变体，不凭模型名称猜测支持等级。存储与执行保留真实 ID，界面展示去重的家族 ID。
- `configureWorker(parentSessionId, workerId, selection)` 查询真实目录、校验归属与 CLI，最后同步检查空闲状态并持久化；运行中拒绝。配置修改不修改过往事件、结果或会话 ID，不修改项目默认值，不启动进程。续聊执行新配置。
- 原生 ModelSelect 内部绑定主 Agent 的模型服务，不可拿来改 CLI 会话；复用原生 Menu/Input 与其布局 token 实现“模型 / 思考强度”入口、模型检索和等级列表。
- 从完整事件序列计算每轮起止时间，在历史分页前附着到逻辑行；耗时为任务提交到终态，含队列与 CLI 启动。运行中按秒更新；终态固定。过程折叠位于回复之前，只展示 CLI 实际公开的工具/状态/诊断，不推断内部思考。
- Desktop 的本地链接更新必须完整重启宿主，不能以插件目录的版本号或刷新按钮代替 Host API 验收。验收必须实际加载目录、保存当前 worker 配置并观察恢复结果。

项目 Logo v4 按用户标注去掉内部三条横条和原圆点，保留 C 形对话框，在右侧紧贴加入小写 li 并加粗，形成 Cli 字形。见 [v4 设计稿](assets/project-icon/v4/README.md)，尚未接入插件。

项目 Logo v5 将 C 主体、l 与 i（含圆点）上下对齐，缩窄 C 并减少内部空白，保留小对话尾部。见 [紧凑等高版](assets/project-icon/v5/README.md)。

用户认可 v5 基本样式后，v6 沿用 Cli 构形，以柔和的曲线、尾部、笔画变化和浅蓝圆点增加人文感，并调整字母间隔。已查看明暗背景中的 24／32／48px 展示，页面标题建议 32px，见 [柔和人文版](assets/project-icon/v6/README.md)。仍为设计稿，尚未接入插件。

## v0.3.4 菜单导航一致性

两个子菜单都将共享返回项放在原生 Menu 的 items 第一项，避免 items 与 children 的渲染先后造成位置不一致。插件内按钮、Portal 菜单按钮及主会话 CLI 入口去除静态边框；hover 使用宿主主题色并以 180ms 缓出曲线过渡，不影响尺寸。禁用按钮不触发 hover；prefers-reduced-motion 下取消过渡，键盘 focus-visible 保留。CLI 分组标题与任务之间的分隔线继续独立绘制。

项目 Logo v7 按用户要求，以 v6 第二张为基础调整为近正方形构形。主体外接框为 1000 × 996px，宽高比约 1.004:1，保留双蓝色、人文曲线及透明背景，见 [v7 设计稿](assets/project-icon/v7/README.md)。

用户随后要求宽度大于高度、比例更舒展；v8 从 v7 继续调整，主体实测 1189 × 862px，约 1.379:1，保留双蓝色、圆角与透明背景。已查看亮暗背景和 24／32／48px 展示，见 [v8 推荐稿](assets/project-icon/v8/README.md)。

## v0.3.5 真实遥测与日期

- Host `TelemetryReader` 从已归属 worker/run 的私有 raw.jsonl 增量读取公开统计字段，内存缓存按文件大小/mtime 刷新；只投影数据，不重写历史记录。文件丢失、未完成行或坏 JSON 不阻塞对话。单文件读取上限 64MiB，缓存最多 128 个运行；超限显示不可用，不伪造不完整总量。
- Antigravity `step_update.usage` 按 step_index 覆盖而非累加，绑定对应回复；`result.usage` 是 CLI 会话累计，独立放在底栏。Codex `turn.completed.usage` 明确标记 CLI 报告值，不把恢复会话的计数跨轮相加；Claude result 包含独立缓存桶；MiMo step_finish 按 part.id 去重后在当前运行内求和。Kimi 未提供可核验计数时留空。
- 统计在历史分页前绑定，底栏取当前运行，不能跟随历史分页跳到旧运行。上下文要求独立的占用与容量；不从模型名字猜容量，不使用累计输入/输出代替占用。Antigravity 的流式输出无这两项数据，v0.3.6 增加以下可选的本地元数据适配。
- 回复栏用量与时间使用宿主次级字号，复用数据库图标。日期遵循 Harness 的本地日历切分：同日 HH:mm、同年 M月D日 HH:mm、跨年 YYYY年M月D日 HH:mm。底栏依次状态、Token、上下文圆环，窄栏截断及换行保护。
- 灰色按钮、可折叠 summary 和统计项提供 180ms 悬停变色；禁用按钮仅外观反馈，原生 disabled 语义保留；减少动态效果偏好关闭过渡。


## v0.3.6 原生交互与上下文元数据

- 替代 v0.3.5 通用 180ms hover：按 Harness 对应控件分别使用原生颜色和时间，WorkStatus 为 100ms 颜色过渡、复制/统计按钮为原生 hover；不统一叠加自定义高亮。复制提示复用 Tooltip，模型列表复用 Menu。分隔线使用 border-l2，复制操作区 28px，圆角及字体增量来自主题。
- 用量和上下文详情使用 useAnchoredPosition / useDismissOnOutsidePointer，顶部间距 8px、视口边距 12px、Esc 关闭；原生背景、阴影、圆角。上下文面板宽 264px。底栏状态改回彩色圆点。
- Host 的 AgyContextReader 仅接收插件 worker 的 UUID conversation_id，只读打开 ~/.gemini/antigravity-cli/conversations/<id>.db，先核对 trajectory_meta.cascade_id，再读取最新 gen_metadata 的 data。8 MiB 上限，文件与 WAL 修改戳缓存最多 128 会话。失败不影响主快照。
- 依据 CLI 1.2.16 嵌入的 protobuf 描述核验字段路径：chat_model(1) → chat_start_metadata(9) → context_window_metadata(10) → estimated_tokens_used(1)、max_context_tokens(4)。只传递数值与来源标识；不解码或展示该元数据中的提示词内容。非负安全整数占用、正安全整数容量才可显示，未知或损坏数据回退未知。
- 本地上下文是最近一次请求的 CLI 估算，详情标注来源与精确数值；与日志中的本轮/回复/累计 Token 用量独立，不将累计用量当成上下文。


## v0.3.7 暗色卡片与品牌入口

- 用户再次明确要求平滑悬停，按钮及 summary 的颜色/背景/透明度统一采用 180ms ease；保留原生圆角、尺寸和主题颜色，减少动态效果偏好关闭过渡。禁用控件允许指针反馈，保留 disabled 语义。
- 暗色卡片改用 interactive-bg-hover，与未选中筛选按钮完全相同；亮色卡片保留现有底色。
- 顶部入口从 header.actions 移至原生 header.utilities 的尾部，只显示 v8 Logo；保留 aria-label 和原生 Tooltip。项目图标复用 doc/assets/project-icon/v8/cliworker-now.png 原文件，object-fit:contain，不拉伸。侧栏标题 32px 图标槽，工具栏入口 28px 图标槽；各 CLI 品牌图不改变。


## v0.3.8 白天模式悬停

亮色 neutral resting fill 与 hover-solid 视觉近似，灰色筛选/返回按钮及禁用灰色控件的 hover 使用 interactive-bg-active。仅作用于 body:not([data-ds-dark-theme])；已选筛选按钮、发送按钮及暗色样式不变。实测未选中按钮默认 rgba(38,49,72,0.06)，真实 :hover 为 rgba(38,49,72,0.1)，180ms 过渡期间存在中间色。

项目 Logo v9 按用户反馈放大左下对话尾部，大幅收缩 C 内部留白，调整三字母重量和柔和轮廓，保留双蓝色与透明背景，见 [饱满对话版](assets/project-icon/v9/README.md)。

项目 Logo v10 在 v9 基础上适当收窄，重新协调 C、l、i 比例，保留大尾部与小留白，见 [收窄协调版](assets/project-icon/v10/README.md)。

用户已选定第二张收窄版 Logo（v10）。以此结合 B 方案制作[整体效果图](assets/overall-preview/logo-v10/overview.png)，展示父级总览／子级对话和亮暗主题。图中内容为设计示例，尚不代表已安装界面的变更。

## v0.4.0 原生设置弹窗与账号终端

- 入口使用 header.utilities 的 order=-20（原生 Finder=-10），24px 按钮、16px Logo；取消侧栏标题分隔线。Modal、Button、StateDot、主题 token 来自 Harness 0.2.0-rc.2；亮色灰按钮继续使用可见的 180ms 过渡。
- 设置按 CLI 切分；模型查询、账号状态、保存独立异步，取消与请求世代防止旧请求污染新选择。主 Panel 不再因模型目录加载而设置全局 busy；对话和停止操作不受模型查询锁定。
- Gateway 专用 accountStatus/start/watch/write/resize/stop；只供人操作，不注册账号管理模型工具。Host 校验父会话和项目，启动遵循规划及只读权限；账号终端与该 CLI 的活动 worker 双向互斥。
- 状态核验：Codex login status；Claude auth status --json；Kimi provider list（不使用含配置凭据的 JSON）；MiMo auth whoami。只投影固定白名单摘要，错误原文和凭据不返回。Antigravity 不提供独立认证状态命令，显示可在原生终端管理。
- 已核验启动参数：Codex login/logout；Claude auth login/logout；Kimi login；MiMo auth login/logout。Antigravity 和 Kimi 退出采用空 argv 启动 TUI，由用户手动输入 /login 或 /logout。manage 打开原生 TUI，插件不自动输入指令。
- 账号终端通过 subprocess.spawnTerminal 参数数组管理；xterm 6.0.0 / fit 0.11.0 渲染 ANSI，禁用自动链接导航，不加载剪贴板写入附加组件。不持久化账号终端输入或输出，CLI 自身按其原生流程保管凭据。
- 状态查询 10 秒/64KiB 上限，终端内存 256KiB/512帧、输入单包16KiB、最多30分钟，30秒未订阅自动清理；关闭/断流/卸载清理，确认进程组退出才释放 CLI 锁。清理失败保留锁并可重试，不报告成功。


## v0.4.1 CLI 开关与设置布局

- 每个 CLI 的 enabled 保存到插件私有 cli-settings.json（目录0700、文件0600、原子替换），当前 Harness 运行配置共享，独立于项目模型偏好。旧安装缺少该文件时全开。Gateway cliSettings/setCliEnabled 校验父会话、CLI、布尔值及取消信号。
- 禁用在模型询问前、异步查询后及最终任务提交层检查；拒绝该 CLI 的新任务、续聊、配置变更和账号终端启动及账号探测。已有记录、任务状态与停止仍可用。有活动 worker 或账号终端时拒绝关闭，不隐式杀进程。
- 设置复用原生 Modal、Switch、Button、Menu、StateDot、Tooltip。Modal 固定700px并受原生可用窗口高度限制，内部 pane 独立滚动；操作Button md=36px，Switch 保持原生36×20px及动效，选择器300px。通用hover规则排除switch和主按钮，避免覆盖其原生颜色。
- 左侧导航根据打开弹窗时的 enabled 快照稳定排序；本次toggle保留顺序，下次打开或页面刷新再将关闭项移到末尾。关闭项名称和品牌图灰化，当前CLI顶部始终显示品牌、名称及开关。
- 账号连接检测按CLI独立取消和缓存，每个CLI最多一个在途请求，不阻塞导航。authenticated绿色，unauthenticated/unavailable/查询失败红色，configured/unknown灰色且不伪称已登录；仅Antigravity真实模型目录返回后可标绿色目录已连接。
- 首次加载与刷新均保留账号摘要、操作位、模型/强度、说明与保存区域；区域标题旁的固定槽显示spinner。切CLI和关闭弹窗取消旧请求；禁用时关闭菜单并停止该CLI的发现请求，恢复开启不会重弹旧菜单。


## v0.4.2 设置页层次与登录身份

- 保留原生 Modal/Menu/Button/Switch/Tooltip；弹窗宽800px、导航188px，固定高度700px且受宿主可用高度限制。CLI页首40px图标与24px/32px标题，副标题说明用途。设置行采用原生14px/22px标签、12px/18px说明、16px上下间距及0.5px border-l2分隔；240px以内的控件右对齐，md按钮仍为36px。
- 账号摘要固定预留52px。authenticated显示绿色点与绿色“已登录”，白名单邮箱跟随其后；api仅显示“API 登录”，即使响应携带账号字段也不展示。载入/错误/关闭状态不显示旧邮箱或旧绿色状态。来源及限制显示在次行。
- AccountStatus增添可选authMethod、accountLabel、verification；只传认证方式、邮箱及来源，不传token、API key、原始CLI输出，不持久化账号身份。
- Antigravity无独立状态命令：按已安装CLI格式有界读取其本地OAuth元数据，仅投影ID token中的邮箱。有效访问凭据或可刷新会话显示本地已登录，明确未远程验证；过期且不可刷新显示未登录，未知格式/读取失败显示待确认。读取上限64KiB，结束清空Buffer并关闭文件，不修改凭据。
- Codex先用login status；ChatGPT方式通过app-server的initialize/initialized/account/read(refreshToken:false)读取CLI有效账号源，支持其file/keyring/auto策略，不直接读取auth.json。explicitGatewayOauth:true阻止隐式Gateway登录，不发任务/登录请求；4秒/64KiB限制，完成或取消后等待进程范围清理。不支持查询时省略邮箱。
- Claude的auth status --json只投影已登录claude.ai邮箱；API与helper方式只显示API。MiMo auth whoami的API分支只显示API，不投影UID/密钥；Kimi配置不冒充已认证。以上覆盖此前仅显示状态摘要的行为。


## ZCode 实验性接入（2026-10-05）

- 探针阶段已完成；正式 Host/Client 集成及实际交付状态见下方“多 CLI 扩展”与 doc/tasks.md。
- 无头入口必须显式指定模式，避免默认 yolo。完整交互采用 Host 双向 stdio Bridge，处理 ZCode 自有 NDJSON 与反向 runtime preferences 请求；Client 仍只经 Harness Gateway。
- Provider、模型、强度及会话 ID 取自真实能力；用户已选 GLM-5.3-Flash，探针使用目录支持的 low。独立 CLI 授权与桌面授权不能混同，不伪造 identity 或套餐 entitlement。
- 规划模式须验证实际返回状态，不能仅凭请求参数判断。legacy snapshot 的 mode=build 不代表未规划：真实 headless 会话持久化 planEnabled=true；正式适配须读取独立 plan 状态，探针另以 macOS sandbox 限制工作区写入。
- 个人模型配置、会话库、日志与 socket 均隔离；原生登录写入独立测试 profile。事件与凭据留在忽略目录，停止需确认进程组退出。正式实现继续遵守宿主权限、项目锁和账号操作互斥。
- 入口、能力差异、官方源码构建与待验收项见 [ZCode 验证记录](zcode-probe.md)。
- 真实权限拒绝测试表明，permission.resolved(deny) 后仍可能输出最终 result 并退出 0。首版 headless 适配器必须将权限拒绝/工具失败投影为未完成任务，不能单凭 result 和退出状态报告成功。可交互批准需要后续双向 Bridge。


## v0.4.3 品牌标题与账号操作（2026-10-05）

- 侧栏、工具栏和空状态采用用户选定的 `doc/assets/project-icon/official-v1/cliworker-now.png` 原图；侧栏以 36px 标志、22px `cli worker` 字标和 `NOW` 标记构成标题，继续继承宿主字体和主题，不重绘原图。
- 账号摘要与操作合并为紧凑一行：绿色状态、账号、红色“退出”；右侧为原生 outline/md 的“切换账号”和“账号终端”按钮。两处刷新使用原生刷新图标与 Tooltip。登录来源说明放在状态 Tooltip，明确区分本地登录证据与远程核验；移除模型来源及默认值作用范围的静态正文，行为仍保持项目/CLI 配置继承。
- 账号操作使用独立 Harness Modal，立即展示加载状态与终端，避免终端挂载在设置页滚动区底部。关闭账号弹窗回到设置，关闭/切 CLI/断流清理对应进程。终端初始化异常与启动超过20秒显示重试；关闭清理超过12秒显示未完成反馈而不宣称已停止。
- Host 对 PTY 分配设置30秒上限；请求取消后仍保留迟到分配的所有权与互斥，取得迟到终端后清理，清理确认前不重复启动。渲染/订阅清理与进程停止独立进行，避免停止RPC阻塞订阅释放。成功创建的账号终端不受启动计时器误终止。
- AGY目前没有独立login子命令，登录入口进入其原生TUI并显示手动 `/login` 提示；插件不猜测参数、不自动输入、不保存终端记录。


## 多 CLI 扩展：ZCode、Grok、OMP、Pi、Harness、OpenCode（v0.5.0 历史）

新增六个独立适配器复用 WorkerRuntime 的项目写锁、会话互斥、Host 持久化和原生 Gateway。Pi/OMP RPC 通过长期 stdio bridge 转成插件内部事件；其余保留各自 JSONL 解析器，Harness/Grok 模型发现使用只创建空会话的 ACP bridge。禁止用 MiMo 或 ZCode 的相似字段替代其他 CLI 原生协议。

目录与账号事实分开：ZCode app-server 不会读取独立 CLI 账号模型目录，首版使用配套 builtin 的已验收 GLM-5.3-Flash 条目，并明确不是实时账号目录。Grok 未进行付费模型验收；OMP/Pi 首版仅支持已经核验的智谱路由。新增账号区不提供未经核验的 auth/login 命令，也不把凭据存在标为远端已登录。

新增执行状态在插件 stateDirectory/native/workerId 下隔离。目录0700、子进程umask077；确认进程范围退出后对原生拷贝资源再次收敛文件0600，软链不跟随、硬链接拒绝修改。目录查询每次使用独立 query 目录，避免并发配置互相覆盖。ZCode使用单独短路径临时目录以满足Unix socket限制，范围退出后清理。Pi/OMP保存原生返回的sessionFile映射，拒绝路径越界，不从会话ID猜路径。Host只在显式配置zaiCredentialRef时经原生credentials服务解析并注入对应子进程env，不将密钥保存到请求参数。

macOS外层沙箱限制项目/运行状态写入；Harness例外使用自身工具文件门禁和进程沙箱，禁止danger-full-access，因双层Seatbelt会让原生Bash沙箱失败。Pi/OMP首版工具限读取/搜索/文件编辑。所有解析器检查会话身份、完整终态和失败工具；退出0不足以证明完成。清理继续由Harness原生terminal descendant ownership负责，未达到进程范围静止不报告已停止。

ZCode 使用原生精确工具名 denylist 禁止子代理、Skill、工作流及跨会话调度和 node_repl，不硬编码个人 MCP 名单。该版本 CLI 没有独立 runtime 配置入口，仍会加载全局插件/MCP；原生允许的 MCP 可以执行（plan 甚至可能直接允许未标注破坏性的工具），无头 broker 仅拒绝 ask 分支。不能把外层文件沙箱描述为网络/MCP隔离，亦不修改用户配置来伪造隔离。

## v0.5.1 六个扩展 CLI 的账号来源与原生设置

账号管理按已安装 CLI 的真实能力分流。ZCode、Grok、OMP、Pi、OpenCode 可打开用户操作的原生终端；Harness 0.2.0-rc.2 未提供原生 TUI，空参数不是账号终端，因此不伪造该入口。Host 返回的账号动作可带 `target: models`；Client 对此关闭插件设置弹窗，再经适配 Harness 0.2.0-rc.2 的共享 Store 桥打开原生“模型”页，不调用 `accountStart`。桥组件通过框架在根作用域复用原生设置的同一 Store handle，由框架绑定 actions 和管理生命周期；不自行创建 Store 实例，不使用 DOM 点击或不可用的 shortcuts.invoke。此桥依赖该版本的 openSection 能力，能力不匹配时明确提示，不伪装为通用公开导航 API。`settings.section` 的唯一所有者是宿主原生设置组件，插件不能重新声明或跨所有者渲染该插槽；两种加载顺序都必须保持原生设置与插件入口正常。

当前 Pi/OMP/Harness 任务使用智谱 CN API 路由；有 `zaiCredentialRef` 的 OpenCode 同样使用该显式 Harness 引用。登录配置与切换账号在上述原生模型页面完成，同一引用对应的修改影响所有复用它的 CLI。Host 每次经 credentials 服务解析后，仅向选定子进程的环境注入密钥，不写入 argv、插件模型偏好或账号状态响应。这些路由不提供独立原生退出操作，避免删除某份原生账号后仍自动沿用引用造成误解。Pi/OMP 的管理终端不将原生 OAuth 当成当前 API 路由的替代来源；其临时运行目录与任务数据独立，结束后清理。

OpenCode 的两种来源严格区分：有引用时设置 `OPENCODE_AUTH_CONTENT={}`，屏蔽无关原生凭据回落；引用读取失败即失败。其管理终端的 `model` 与 `small_model` 为 `zhipuai-coding-plan/glm-5.3-flash`，`enabled_providers` 限定为 `zhipuai-coding-plan`，避免默认进入国际 Z.AI 路由。无引用时，登录、退出、管理终端、目录查询与 worker 共用 `<stateDirectory>/accounts/opencode/data` 作为 `XDG_DATA_HOME`，原生账号文件为其下的 `opencode/auth.json`；不复制或覆盖用户全局 OpenCode 账号。数据库、配置、缓存和临时目录仍按运行隔离。该模式允许原生内置 OAuth 钩子刷新账号，外部插件继续禁用；沙箱仅额外允许私有共享账号目录写入，不开放规划模式的项目写权限。

OpenCode 账号准备在分配临时运行目录前执行可取消的凭据解析；准备失败、启动取消或账号进程范围退出后，清理本次终端目录。清理验证目录身份，不跟随内部软链接，不删除共享账号目录或其他 worker 数据。共享 OAuth 状态可能由原生进程刷新，不在另一个会话运行时对共享树执行权限遍历。原生账号文件的读取有 64KiB 上限、拒绝软链接及硬链接文件，仅投影本地 API/OAuth 配置类型，不能据此声称远程认证成功。

ZCode 未显式配置 executable 时，优先采用已安装的完整入口 `~/.local/share/cliworker-now/runtimes/zcode/cli/zcode.cjs`，否则回落到桌面内置 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。相同版本号不能证明能力一致，账号终端启动前读取实际 `--help` 检查 `login [zai|bigmodel]`；缺少该能力时返回固定中文安装提示。完整 CLI 的登录使用 `login bigmodel`、退出使用 `logout`、管理使用 `tui`，不向终端自动输入斜杠指令。默认授权目录为 `<stateDirectory>/accounts/zcode`，也可由 `zcodeAuthDirectory` 指定；设置与 worker/catalog 共用此来源，避免登录成功但任务读取另一份账号。Grok 沿用本机 `~/.grok` 账号，原生退出影响其他共享该账号的使用方。

六个 CLI 的状态查询只投影允许展示的摘要；本地文件存在、引用可解析或 `configured` / `verification=local` 不等于远程登录、订阅权益或额度有效。该说明通过状态来源提示呈现，不返回凭据内容、API key 前缀或原始异常。账号任务仍遵循 CLI 启用状态、宿主执行权限、取消、同 CLI worker/账号互斥和进程范围清理；本小节描述实现契约，实际验收记录单独写入 `doc/tasks.md`。

## v0.5.2 原生终端登录与账号身份

- OMP、Pi、OpenCode 的登录按钮统一为「登录设置」，直接打开 AccountTerminal，不依赖 Host API 凭据解析，也不导航到宿主模型设置。OMP 使用实际安装版本支持的 `setup`；Pi 固定 1.0.2，通过其导出的 runtime/InteractiveMode 打开原生认证菜单，无提示词或按键注入；OpenCode 使用 `auth login`。Pi UI 接口不匹配时明确失败，不退回模型任务。
- Pi/OMP 的 `accounts/<cli>/agent` 保留原生登录记录；临时 cwd/tmp 仍位于 account-runtime 并在退出后清理。任务选型和既有 API 路由保持显式，不把新登录的 OAuth 静默套用于旧会话。
- Harness 0.2.0-rc.2 没有内置终端登录页，禁用登录与终端操作并显示版本能力限制，不伪造登录界面或跳转设置。
- ZCode 读取其指定账号目录中经原生 AES-256-GCM 加密的活动提供商、登录凭据存在性及 user-info；Grok 识别 auth.x.ai OIDC 记录、过期与可刷新状态。文件读取限64KiB，拒绝软链接/硬链接/非普通文件；返回仅包含状态、允许的邮箱/显示名称与本地来源，异常不包含密钥或原始输出。
- 六个扩展 CLI 使用用户制作的 `doc/assets/cli-icons/v2-extended` 原始PNG和光学居中参数；ZCode/Harness/OpenCode/Grok 随原生暗色主题反色，OMP/Pi 保留原色。登录区域移除重复的宿主 API 设置备注，保留浅边框原生按钮。

OMP 原生登录向导的顶部标志与说明占用较多终端行；账号弹窗为其保留520px终端高度，小窗口通过弹窗正文滚动，避免CLI按行数裁切提供商列表。其他CLI保持原生紧凑弹窗。

## 智能体角色预设与稳定名称（2026-10-06）

- 角色库由 Host 存在当前 profile 的私有 `role-presets.json`（0600），供所有 CLI 共用。首次初始化从用户提供的七份小说技能装配；之后编辑与删除持久化，不在重启时重新覆盖。每项包含稳定 id、名称、概述和提示词，名称去重，提示词最多 30000 字符。来源调整见 `doc/role-presets.md`。
- `cliworker_start` 仍按项目＋CLI 取得真实模型和强度，之后每次新建都通过原生 userQuestions 询问角色。选择预设、无角色或 Other 自定义；取消、空答案或无效答案不发布任务。临时提示词仅保存到当前 worker，不自动加入库。问题展示时冻结选项，避免期间编辑模板改变用户实际选择的含义。
- Worker 新增可选 `agentName` 与 `role` 快照（presetId/name/summary/prompt）。首轮在发送给 CLI 的任务前附加角色，页面中的用户任务保持原文；原 CLI 会话续聊依靠原生历史保留角色，不重复添加整份提示词。模板变更不会改变既有快照。角色不能扩大宿主权限或开启孙智能体。
- 名称在同一父会话内唯一，默认由角色名或 CLI 助手名加序号生成。工具可接受用户指定的 `agent_name`；续聊、状态和停止可用 `worker_id` 或精确 `worker_name`，两个字段同时传入时必须指向同一 worker，跨父会话和模糊匹配均拒绝。旧记录使用确定的 `智能体-<id前6位>` 展示名，不批量改写历史。
- 新增 Gateway RPC：`rolePresets`、`saveRolePreset`、`deleteRolePreset`、`renameWorker`。调用先验证父会话；修改取消后不写入，写盘成功后才发布新状态。预设库 CRUD 与角色选择不启动 CLI 或查询模型。
- 设置导航增加“智能体预设”：两列名称＋概述卡片，窄屏单列；搜索、新增、编辑、确认删除使用宿主 Input/Button、主题色、圆角与悬停参数，角色正文以纯文本编辑。对话菜单可重命名。总览显示“名称｜模型 · 强度”，详情标题显示“名称｜主题”；标题改为 Cli Worker，NOW 居中并缩小标题区留白。
- 七份默认角色仅装配可复用提示词；未复制来源技能的工具、共享规范或原小说正文。依赖缺失时提示词要求说明缺口，不声称已完成不存在的脚本或独立审查。


## v0.6.0 Hermes Agent 与旧 Harness CLI 退役

活跃 CLI ID 用 `hermes` 代替外部 `harness`，接受自然语言 harmes 别名。宿主 DeepSeek Harness 的 SDK、原生主题、Gateway 和权限机制保持原状。用户 `doc/assets/cli-icons/v3-hermes/hermes.png` 原图进入运行时，按 manifest 缩放与光学居中，暗色反相。

共享协议将活跃 ID 与历史 ID 分离；Storage 兼容旧 Harness 开关、偏好和 worker 文件，但不向设置页暴露旧开关，不迁移到 Hermes。历史行标注已移除，仅支持查看；Host 在新建、续聊、改模型及开启操作前拒绝旧 ID。Hermes 首次独立选型。

Hermes 账号与模型使用原生 home，不注入共享智谱引用。账号终端分别打开 model/auth 原生菜单，状态仅返回安全本地摘要。目录只读取原生明确选择的 provider/model；能力缓存不明确则只提供 default。任务通过原生 stream-json，session_id 独立校验，最终结果结合退出码；工具错误可被后续成功恢复，真实 tokens 进入回复和底栏，不伪造 context。所有进程复用宿主管理与清理机制、macOS 外层写入沙箱。原生 launcher 需要安装锁与运行租约；任务和目录读取仅对白名单日志、会话、数据库、锁与租约授予写入，账号/config/.env/源码保持只读；首次初始化或凭据刷新需通过原生账号终端。详细协议与真实/模拟证据区分见 `doc/hermes-probe.md`。

Hermes 与角色功能共享同一 WorkerRuntime；名称、角色快照与原生 CLI 会话分别持久化，退役 Harness 的保护条件先于执行派遣，不影响现有角色编辑及名称查找。


## v0.6.1 字标与设置导航细节（2026-10-06）

- 标题使用宿主 `--dsw-font-family-brand`，回退到原生界面字体；移除紧缩负字距，使用 500 字重、0.005em 字距。Logo、NOW 与设置图标同轴居中。Worker 元信息中模型只占所需宽度，点分隔与强度紧随模型，长名称仍可截断。
- 设置页“智能体设置”与“CLI 连接”为同级导航，分别使用宿主联系人、链接图标；CLI 项缩进一层。点击连接组标题仅折叠导航，不重建当前配置或账号终端，不追加目录查询。展开/折叠使用 220ms 高度与箭头过渡；收起后子项 inert、不可键盘聚焦，兼容减少动态效果偏好。
- Harness rc.2 的原生 MD Button 高度为 36px；Input 无尺寸变体，插件仅将单行搜索、角色名称/概述与重命名输入框的 wrapper 对齐至此高度。开关、多行提示词和聊天工具按钮保持对应原生组件尺寸。
- 返回、取消和保留预设使用原生 outline；删除与确认删除使用宿主错误色及白字，沿用既有确认流程。取消广泛的按钮去描边规则，仅对菜单项维持去描边，保留现有亮暗悬停过渡。


### 2026-10-06：v0.6.2 默认字体与卡片收展

- 总览标题使用 Harness 默认界面字体 token `--dsw-font-family` 与自然字距，NOW 保持居中并降为 18px 高。仅标题 Logo 采用随主题变化的黑白显示，其他 CLI 图标和工具栏入口保留原图。
- 浅色 CLI 卡片以宿主背景和悬停底色混合得到淡灰底；深色继续使用未选中按钮的背景 token。
- CLI 分组保留内容节点，通过网格高度、透明度、分隔线与箭头实现收展，沿用宿主 200ms 时长和缓动。收起内容设置 inert、隐藏语义和不可聚焦状态；开启系统减弱动态效果时取消过渡。


### 2026-10-06：v0.6.3 悬浮卡片与紧凑字标

- 总览标题统一为 `CLI Worker`，Logo 与字标间距从 12px 收紧为 6px，保留宿主默认字体、18px NOW 与黑白图标。
- 分组卡片恢复宿主 `bg-base` 底面，浅色为白色、深色与页面同色。浅色直接使用 `elevation-soft` 柔和阴影和原生细轮廓，深色加强向下投影以形成悬浮层次；不再使用上一版灰底。
- 收展动效、箭头转动、悬停反馈及折叠内容的交互约束保持不变。


### 2026-10-06：v0.6.4 三色正式 Logo

- 用户提供的白色、蓝色与黑色透明 PNG 原样归档到 `doc/assets/project-icon/official-v2/`，同时进入运行时资源；manifest 记录来源文件名、用途与 SHA256。保留原始尺寸和透明度，不重绘、裁切、改色或使用图像滤镜。
- 总览标题用原生主题标记在黑色与白色图片之间切换；工具栏、空状态和新标签页引导使用蓝色版。移除旧标题 Logo 的黑白滤镜，其他 CLI 图标不变。
- 注册标签页与引导标题统一为 `CLI Worker`，沿用现有默认字体、6px 标题间距、18px NOW 和悬浮卡片。


### 2026-10-06：v0.6.5 指定定稿与同轮廓配色

- 用户选定 `exec-c36aab95-deae-46a1-a896-f650a5bed8f7.png` 为唯一造型源，原图归档 official-v3，并逐字节复制到运行资源。
- 所有项目 Logo 使用同一 PNG alpha 蒙版；标题随主题黑/白，入口蓝色并在右上胶囊范围叠加天蓝色。配色层始终被相同 alpha 裁切，形状、间距与圆角不会因不同生成稿变化。其他 CLI 图标保持原状。
- 两张 imagegen 换色探索有轮廓偏差，单独归档为未采用；移除旧运行时蓝/白 PNG，避免误用。


### 2026-10-07：v0.6.6 天蓝平切 Logo 定稿

- 用户最终选择 `exec-1f96a1dc-5099-4e6e-949c-6b37a295db1d.png`，归档 `official-v4` 并逐字节复制到运行资源；后续生成的精修稿不作为定稿。
- 彩色入口直接显示原图，浅色标题黑色、深色标题白色，共享原图 alpha 蒙版，三版轮廓、间隙、圆角和透明度完全相同。删除旧配色层的固定位置天蓝矩形，原图颜色直接保留。
- 保持标题、NOW、卡片与其他 CLI 图标现有布局，未调整插件业务行为。


## 2026-10-07：OpenSpec 开发流程接入

- 通过项目开发依赖固定 OpenSpec 1.14.1，使用官方 spec-driven schema 与 Codex core 项目技能。日常命令统一为 `pnpm spec`，项目约束写入 `openspec/config.yaml`；定制不写入官方生成技能。
- 新增能力、行为/协议/权限调整及跨模块重构通过 change 管理提案、增量规格、设计和任务。已落实规格存 `openspec/specs/`，完成并核对证据后归档；无行为变化的拼写排版修正可直接完成。
- 本文继续保存架构及版本演进；`doc/tasks.md` 继续记录实际验证结果。后续修改依据当前源码、测试与最新有效决策提取相关规格，不机械迁移旧版本未完成清单。
- 首次仅建立 development-workflow 规格，业务能力域在实际变更触及时逐步补充。命名角色及预设已实现，Grok/Hermes/Kimi 的真实验收边界继续以现有证据为准。
- 本次不改 Host/Client/共享协议，不更新 Desktop 或真实运行 CLI。使用方法、候选能力域与升级方式见 [OpenSpec 开发指南](openspec.md)。

## 2026-10-07：v0.6.7 明确调用、原生目录与状态证据

- 名称表统一驱动 Host 派遣工具和中文调用提示。规范 ID 与常用别名可直接解析，agy 对应 antigravity，glm／zhipu／智谱对应 zcode，harmes 对应 hermes。较长名称只接受唯一轻微拼写误差，短名称、歧义与 retired harness 不作模糊替换；省略 cli 的旧 Antigravity 工具调用保持兼容。
- 通过 Harness 原生 agent/pre-step 观察本步用户消息，在 systemPrompt 动态 section 增加明确调用的规范路由提示；不扫描旧会话来猜本轮请求，不注入原始用户文本，不直接启动任务。讨论、否定与引用不产生派遣提示。所有调用继续经过项目／CLI 偏好、首次选型、角色问题及宿主规划／只读／子 Agent 拒绝门槛；现有名称续聊仍使用 followup。
- ZCode 按原生规则合并 builtin 与 personal 服务商／模型配置，保留完整 ID、隐藏与禁用覆盖以及原生推理能力；不再把 PoC 的 GLM-5.3-Flash 作为唯一模型。私有副本保留原生个人规则，只覆盖本次选型。headless resume 原生忽略默认选型，因此续聊先通过受同一沙箱及进程组约束的 app-server metadata wrapper 改选并读回，close 完整退出后才启动 headless；取消、拒绝与观察不匹配不会继续任务。Pi／OMP 同会话改选使用原生 RPC 并核验；原生目录、账号读取与任务 bridge 使用相同来源，不给其他 provider 注入 CN 智谱引用。
- Pi／OMP 从全局原生配置和插件持久账号目录安全读取允许的认证／模型输入；同 provider 的有效插件账号优先，空插件配置不遮蔽全局账号。worker 的会话与运行状态继续隔离，原生全局配置保持只读；仅复制所需账号和模型数据，不复制历史会话。Host 智谱引用仅作为显式兼容来源。
- AccountState 增加 unconfigured 以区分未配置与已知失效。默认缺安装、无账号、空配置灰色；unauthenticated 表示明确失效，unavailable 表示读取／配置错误，二者红色。显式坏 executable 配置红色。未知信息保持灰色并说明原因；Client 导航与账号摘要共用投影，未配置优先于空目录失败。
- 原生目录和本地账号记录仅证明相应本地事实，不证明远端模型或订阅可用。此次变更通过 OpenSpec 的 worker-dispatch、cli-model-discovery 和 cli-connection-health 管理；自动回归、非模型本机查询、实际界面和未做真实任务的边界见 doc/tasks.md。

## 2026-10-07：v0.6.8 账号可用模型与精简名称（重开）

- 用户反馈后重新取出 `fix-cli-routing-model-catalog-health`。v0.6.7 的原生 available 只证明候选目录，不再作为账号权益验收；保留历史记录，当前任务单独追踪。
- Pi、OMP、OpenCode 先安全读取原生账号及配置，再将候选与当前账号模型范围相交。过期 OAuth、无账号、账号范围未知、仅公共目录存在的模型隐藏；Codex OAuth 还检查 API 支持和当前额度是否允许。多账号池仅保留各可能执行账号共同支持的模型，避免把另一账号的权限借给当前请求。
- 查询不发模型任务、不刷新 OAuth、不执行 shell 密钥解析命令。同一私有快照先在单层断网沙箱读取原生候选，再单独做有界只读 HTTP 账号查询，避免 macOS 不允许重复 sandbox_apply；账号阶段不启动原生 CLI。取消同时覆盖进程和请求，无法确认元数据进程退出时阻塞后续任务并保留状态。任务准备使用同样查询，再通过确认目录和原生 setModel／observed 核验；原生全局账号、配置与会话只读。发现和执行共用原生账号优先级与私有副本，Host CN 引用只绑定对应路由，不扩大模型清单。
- OpenRouter 使用账号模型端点，公共 `/models` 不充当账号清单。OpenCode 匿名公共免费目录不作为登录账号证据；官方 Zen 的公共零价格路由没有当前 Worker 兼容证据时隐藏，自定义端点按真实账号范围核对。404/405 不代表认证或模型权限成功；自定义配置和未绑定当前账号的旧 Host 成功记录均不能替代当前账号范围。缺少证据的候选隐藏，旧偏好和完整 ID 保留，不请求新模型输出来填补证明。
- 新共享展示层只用于清洗模型名称：去除首段 provider/account 前缀和括号附注，保留模型自身合法 ID；设置、首次询问、Worker 菜单和历史卡片统一使用。按确切原生型号去重，不合并不同版本或各路由的强度能力；保存与执行完整 ID 不变。有效旧选择固定其原路由，不可用时要求重选。
- `ModelChoice.cost` 为 free/paid/unknown。只有明确价格/免费额度且可用的模型在新选择中优先；缺省零成本、未知价格和付费订阅包含额度不当免费。多账号池全部可能身份均免费才标 free；附加费用和冲突价格不算免费。免费排序不自动选择、不覆盖偏好，失败不转付费路由。
- 本轮验证区分隔离账号夹具、真实本机只读元数据、实际 Desktop 呈现和模型生成；结果与无法确认的范围见 `doc/tasks.md`。接口公布的账号清单不能保证未来余额、服务可用性或每次模型任务成功。


## 2026-10-08：v0.6.9 六款 CLI 设置加载、身份与账号证据

- 设置统一先完成账号检查再加载对应模型。账号刷新、登录终端结束或关闭都会使旧目录失效；查询取消、失败、返回 CLI 不符时禁用旧模型与保存，不改已有偏好。导航与账号摘要共用状态：仅 `authenticated + verification=cli` 显示绿色，本地配置或登录文件保持待验证；Host 模型凭据不能证明原生 CLI 已登录。账号说明允许自然换行。
- ZCode、Grok、Hermes 的本地 access token 过期不再报登录成功，refresh token 单独存在不能证明任务凭据可用；Pi、OMP、OpenCode 先独立读取原生状态，再说明显式 Host 来源。每款 CLI 保留自己的登录/配置入口，不共享登录身份。
- Pi 采用已核验的原生 Pi Coding Agent 1.0.2/1.0.4 包与 SDK，目录、登录和 RPC 使用同一入口；OMP 必须核验 Oh My Pi 品牌及所需原生参数。入口混用或能力不符明确失败，工具说明同时说明二者独立；同一服务商和模型不构成同一 CLI。取消传到身份元数据进程，退出未确认时不清理仍被占用的状态目录。
- ZCode 安全读取当前 identity 精确绑定的 individual coding-plan key，与对应原生路由的账号模型范围相交。只对 ZCode Anthropic 兼容路由镜像其原生双认证头；官方 individual provider 在精确官方端点使用原生已定义的 GLM 别名表，将接口的小写 ID 投影到原生 canonical ID，执行 ID 保持不变，其他路由仍精确匹配；未知账号模式、旧 identity 或不能重建的自定义 headers 不放行。`ZCODE_CREDENTIAL_SECRET` 仅显式传给 ZCode 子进程，Host 解密与登录/执行使用同一来源，不进入 argv、文件或响应。
- Grok ACP 公共目录不能证明当前账号 Worker 权限，缺少该证据时隐藏候选并说明限制。Hermes 只对可忠实重建的原生 OpenRouter / Codex OAuth 路由验证账号范围，保留原生已选模型及其能力；账号池按所有可能凭据的共同支持范围筛选，禁用 provider、未知端点或外部 `codex_app_server` 账号不放行。损坏的 Hermes 固定 exec 入口在查询和启动前明确报错，不启动安装器。
- 模型列表的证据来自只读账号元数据和原生 Worker 能力，不能保证未来余额或每次生成成功。未进行计费生成试探、OAuth 刷新或自动登录；本机结果、模拟 UI 与残留限制分别见任务记录。


## 2026-10-08：v0.6.10 原生已登录状态与单行账号信息

- 修正 v0.6.9 把 `verification=local` 当成未登录的错误。该字段只描述读取来源；`authenticated` 的原生状态、可续用登录会话及当前账号精确绑定均可显示已登录。Antigravity consumer 会话有有效 access 或 refresh 时保持登录；ZCode 受支持 individual provider 的当前 identity、绑定 key 和原生用户记录一致时显示 OAuth 已登录。手填 API 身份、孤立/旧 key、普通配置及 Host 引用不因此提升为原生登录。
- 登录状态与模型范围分开：不要求发送模型请求才能显示已登录，模型筛选仍沿用当前账号和原生执行路由。原生文件保持只读，状态刷新不会提交登录或刷新 OAuth。
- 设置账号区统一为一行短状态及必要身份/原因，删除正常状态 detail、二次拼接和静态防御性文案；账号终端仅保留操作指导、进程状态和简短失败原因。不是把长说明用省略号藏起来；账号身份本身可保留完整 title。
- 刷新失效、CLI 身份检查、失败重试、权限和进程范围清理保持原有实现。网关形状和存储兼容，隔离验收后再更新 Desktop。


## v0.6.11：全部 CLI 自身账号与模型隔离

- 原生登录和该 CLI 独立配置的 API Key 属于自身来源；Harness 引用、跨 CLI 文件、通用密钥环境、匿名目录及旧快照不属于账号授权。旧 `zaiCredentialRef` 只兼容解析，不读取它引用的密钥。
- Host 以 CLI、受限来源、稳定 OAuth 主体或 API 摘要组成匿名账号绑定；正常 token 续期不改变主体。绑定只保存在私有 worker sidecar，不进入共享 Worker、模型目录、Gateway 或历史消息。保存、新建、队列出队及续聊重读当前来源和模型权限；准备完毕再次核对，原模型与强度不一致时拒绝，不隐式替换。
- Pi/OMP 按当前自身来源生成认证投影；可核验身份的 OAuth 使用来源绑定的共享存储与 Host 租约，API 投影按当前来源重建。移除历史合成 CN 提供商及 OMP broker；OpenCode 只展开自身目录内的环境和文件引用。Grok 每次替换派生认证链接；ZCode 复用当前 identity 与绑定 key 的原生合并。原生及插件登录账号不被迁移删除。
- OMP 原生会加载 HOME、config root、agent 和项目 dotenv。Pi/OMP 的模型查询、任务和账号终端均额外使用 macOS Seatbelt 禁读 `.env`／`.env.*`；自身私有 `.env` 已由 Host 限定目录解析并投影。OAuth 文件与会话继续可用，HOME 和项目 cwd 保持原生语义。
- Hermes 原生默认可导入其他 CLI 账号；只有自身配置 `auth.adopt_external_logins=false` 且未使用外部凭据池／Codex app-server 才可进入模型和执行路径。MiMo 禁止环境凭据和默认／外部 provider 插件自动导入，目录和任务使用相同参数。
- 所有模型都以原生能力和当前自身账号模型范围求交；前五 CLI 不再靠 Codex 旧缓存、Claude 固定别名、MiMo 公共缓存或 Kimi 配置候选直接放行。未知范围返回短原因与空列表。无生成探测，不能把历史成功或离线目录当成本轮真实生成验收。
- 查询清理失败保持错误优先于取消，阻止后续派遣。排队取消也等待已启动的账号读取结束，避免提前释放任务；设置页查询清理失败同样锁住派遣。

- Hermes 的交互 Codex 登录另有直接导入入口，不受 adoption 开关约束；账号终端、查询和任务统一拒读 Codex／Claude 的默认、环境覆盖及符号链接目标，阻止 Keychain security 导入。Hermes 自身 OAuth 文件保持可用。
- MiMo 在原生配置服务执行前检查全局、项目祖先、私有目录及托管来源，拒绝未核验的文件／环境插值、wellknown 和活跃远程组织配置；只读核查 SQLite/WAL，不读取组织令牌。屏蔽父配置覆盖，路径与原生公式不一致时拒绝。该配置检查覆盖目录和任务；账号状态只读自身 Auth，登录终端使用隔离配置上下文，界面只保留单行原因。
- 升级前无账号绑定的历史任务无法证明原会话身份，保留查看但要求新建任务；不能把当前登录自动绑定到旧会话。账号激活钩子在最后绑定核对后由 Host 获取租约，取消时等待激活返回后清理；Child 只能验证租约，不能写入或删除锁。
- OpenCode 1.18.21 的 OAuth 刷新为无 CAS 的整份认证文件写回，不能保证外部原生终端退出／换号后不恢复旧条目；该 OAuth 模式保留真实账号状态，但不提供模型和执行路径。自身 API 配置继续按账号范围开放。Pi／OMP 正常续期使用原生锁或 SQLite 条件更新，只保存当前来源仍匹配的账号条目。

- 实机反馈后的登录恢复：账号导航和摘要只采用账号证据，模型读取中或失败不覆盖已确认登录；刷新时保留账号身份，但立即使旧模型选项失效。查询失败仍在模型区独立显示短原因。
- Antigravity consumer 登录使用实时原生 `agy models`，按其明确返回的 ID/label 生成模型与强度变体；自定义提供商改选不沿用 consumer 账号绑定。登录身份先通过本地受限读取展示，模型元数据随后独立加载。
- MiMo 原生网页登录写入的是自身 ApiAuth，metadata 中的官方 base_url 参与原生模型路由解析。状态直接读自身 auth.json；账号终端使用隔离 HOME/config/DB/cwd，仅链接同一原生认证文件，避免项目模型配置阻塞登录。原生 verbose 模型头部的 window/budget/compacts 字段是合法元数据，解析后仍核验 provider/model 与 JSON 一致，再与账号模型范围求交。
- 只合并相同 CLI/项目正在进行的账号请求；每个调用独立取消，最后取消须等待进程清理，完成结果没有 TTL 缓存。Codex 优先一次原生 account/read，协议不支持才回退；OMP 仅缓存按可执行文件 canonical 路径、inode、大小和时间戳绑定的能力，账号/模型权限仍每次检查。


## 0.6.12 原生登录入口与 Grok 权限目录修复（2026-10-08）

- Kimi `provider list --json` 仅在 Host 内解析；按原生当前 `managed:kimi-code` OAuth 引用读取自己的令牌槽位，区分缺失、撤销墓碑、过期不可续期与有效／可续期。已有登录的 `login` 本来会直接复用账号，所以按钮改为“管理登录”，打开原生 TUI，由用户明确 `/logout` 后 `/login`；不自动退出或构造不存在的 force 参数。账号终端使用 0700 独立空目录和空 Git/MCP 边界，避免上溯到用户项目；原生未信任目录的 Trust 提示由用户选择，不自动写入信任记录；退出后按 inode 校验清理。
- OMP 的 `setup` 入口保持原生；其日志位于 `agent` 同级 `logs`，只为已规范化的自身私有日志子目录补写权限，不扩大到整个账号根目录。
- Hermes 在显式账号操作时建立插件内独立原生账号目录和目录外的来源标记；状态、目录、绑定、执行统一读取该来源。之后退出不回退到旧全局账号，原全局配置／凭据／会话保留。精确允许原生自身登录 source/provider 对，不开放 `manual:*` 通配；原生 last_status、reset/cooldown 仍是不可用证据。
- Hermes 安装与账号分离：复用已安装官方 launcher 绑定 checkout 的 committed facts 所选 venv，在原生安装锁内复核并持 generation lease，禁用懒安装。入口资产随正式包和 preview 打包；未知安装形态仍遵循原有核验。沙箱只允许自身 `.env`，阻断旧全局和安装源码的环境层及已知外部账号导入。
- Grok 登录状态与调用权限分离。固定官方 `/v1/settings` 的 `allow_access === true` 是 Build 门槛，随后读取 `/v1/models`；两个只读请求均绑定同一当前账号指纹。目录 200、是否订阅都不单独代替服务端门槛，不做自动续期或生成探测。门禁拒绝／未知、认证失败、超时和目录空响应分别诊断。
- Grok 当前精确安装版的动态模型 schema 已用禁外网、本地模拟目录验证能解析 `grok-4.7` 及 low／medium／high／xhigh。这个版本使用已验证动态能力与认证元数据求交，其他版本保留原生候选交集；匿名 fallback 的旧 `grok-4.5` 不再误删有证据的新模型。Worker 对源认证目录和派生 auth 链接禁止写入，不能借旧快照复活退出账号。
- 设置继续只有必要单行账号摘要。详细 Grok 诊断在聊天和验收记录中，原生操作说明仅在账号终端中。

## 2026-10-08：v0.6.13 服务商登录显示与 Hermes Nous 目录

- 本轮修复 Pi、OMP、OpenCode 与 Hermes 将自身有效认证固定显示为 configured 的问题。共享协议兼容新增 `logins`，只投影服务商名称、认证方式与安全的 OAuth 身份；Client 的账号行和导航状态使用同一格式。API 显示“服务商 API 登录”，OAuth 显示“服务商 账号登录”；混合认证保留多项且单行省略，API 身份字段不渲染。配置模板、未解析引用、禁用与失效凭据不升绿，目录失败不抹掉本地有效登录。
- Hermes 补齐 Nous 原生 flat OAuth/device-code pool 的状态、绑定、目录与执行上下文。按当前自身来源核对 agent key、身份、组织、scope、TTL、pool 与官方路由；空 pool 可识别登录，但不绕过原生初始化启动。拒绝跨账号 pool、匿名、额外 key/路由与外部来源，不修改原生账号文件。
- 模型采用官方认证 `/api/oauth/account` 与 `/v1/models` 元数据，结合原生聊天/tools/冷却和账号访问范围；无付费访问权只开放明确零费用项，未知或额外收费项不冒充免费。强度与原生 Nous chat wire 词表求交集，不将 CLI 解析器接受但传输层会钳制的 `ultra` 展示为独立能力。保持完整模型 ID，不变更公开模型和偏好结构。
- Nous 最小有效期由同一 helper 供读取、绑定、目录及子进程使用，默认与最低值 120 秒，自身更高值优先。不再因原生默认提前 1800 秒刷新而拒绝仍可使用的账号；仅投影官方进程参数，原 `.env` 不变，目录不自动续期。查询结束重新检查当前来源、TTL、身份、路由和冷却；能力缓存按来源与请求版本隔离，旧请求取消不得清除新结果。
- 不扩大 Pi/OMP/OpenCode 的模型权限，不解除 OpenCode 原有 OAuth 执行限制。真实验证限于本地状态与 Nous 已授权元数据；实际生成和续聊仍未验收。

## 2026-10-09：v0.6.14 账号摘要、身份与原生退出

- 有 OAuth 登录时，可见摘要只显示去重的订阅服务商，如“OpenAI账号登录”；其他自身 API 认证和安全身份保留在悬浮详情，模型范围不变。仅 API 登录继续显示服务商。Kimi 从当前原生 `kimi-auth` 令牌的稳定主体字段投影末六位账号 ID；不显示令牌片段、不编造邮箱或昵称、不刷新认证。
- OMP、Pi、Hermes 使用与其他 CLI 相同的退出按钮。新增有限来源 `native/plugin` 及 `accountStartForSource`，旧接口保持兼容；多个来源先由用户选择，取消不启动终端，Host 启动前重读真实来源。Pi 使用所选真实 auth 文件，OMP 仅将真实 SQLite 认证数据库链接进私有运行目录；退出不经过合并认证快照，不清空其他账号来源。
- 退出进程禁网并保留原有互斥、取消及进程范围清理。Pi/OMP 的原生菜单只删除其支持的已保存凭据，`.env` 或模型配置中的 API 需在原配置管理，保留有效来源时不伪称全部退出。Hermes 使用当前 effective home，不触发登录目录迁移；只给原生认证和环境文件及其锁/原子临时文件写权限，不扩大到配置、历史或整个账号目录。
- Hermes 原生 `suppressed_sources` 的当前来源标记同时约束账号投影、模型范围、查询结束重检及任务绑定；保留的配置值不能复活已退出账号，独立未停用来源继续核对。打开原生菜单可能规范化凭据池，取消不承诺源文件逐字节不变；本次真实账号验收未执行退出。

## 2026-10-09：v0.6.15 原生保护、Windows 与双语发布

- 用户明确改为采用各 CLI 原生保护，取消插件额外 OS 沙箱；任务、模型查询和账号终端均不再使用 sandbox-exec、SBPL 读写或网络策略。此前版本的 OS 禁读记录保留为历史，不再是当前保证。Host 继续准确识别本 CLI 自身登录/API 来源，过滤继承密钥，不注入 Harness 或其他 CLI 凭据；保存、启动、出队与续聊仍核对账号版本、模型和强度。
- 原生模式保留：Codex/Antigravity 使用其原生沙箱，Claude 等使用实际权限模式，Grok/Pi/OMP/OpenCode 保留自身工具限制；Kimi 与当前 Hermes 非交互模式没有可核验只读能力，明确拒绝只读派遣，不以普通执行冒充。宿主规划/整体只读边界和已有会话互斥不改变。
- Windows 统一解析真实官方 Node/Bun npm shim、原生 exe 和 Hermes 固定 Python launcher，以独立 argv 执行，未知 batch/运行时拒绝；不使用 cmd /c。任务经 Harness 普通 spawn 的 Win32 Job 管理后代，账号交互保留原生 ConPTY，并按实际范围确认退出。Windows 路径从盘符/UNC 根解析，私有目录复核不依赖 POSIX 目录 fd，POSIX mode 检查不误用于 Windows。
- MiMo Windows 登录直接关联当前自身原生认证目录，私有 cwd/DB 单独管理，不复制 auth 或要求 symlink 权限。OMP Windows 退出直接选中真实 agent/DB，配置代理时拒绝；非凭据配置根只在子进程重基，私有/原生账号路径仍明确。认证读取增加文件路径/描述符身份及读取中变更核对，避免取消外层后将链接目标误作自身登录。
- 默认中文 README 与完整英文页双向切换；首选安装代码块只一行固定 Release URL，macOS/Windows 共用 Desktop dsh 命令。Windows CI 验证真实运行层和临时账号数据，官方 CLI 只执行版本/帮助及 SDK 元数据，不将这类检查描述为真实推理验收。发布包含双语文档和所有动态辅助资产，远端下载与隔离 URL 安装另行核对。


## 2026-10-09：v0.6.16 派遣设定与主对话确认

模型、思考强度与角色作为完整设定保存。首次使用项目中的某个 CLI 时，先由原生问题卡选择模型，再选择实际支持的强度和角色；取消任何一步均不保存半套设定。同项目同 CLI 的新主对话只询问是否沿用；选择不沿用才重新选型。同一主对话的后续派遣使用其已确认快照，不重复问角色。

私有项目偏好扩展角色快照和账号绑定；公开 Preference 仍保持 cli/model/effort。null 表示用户明确选择无角色，旧版缺失角色字段时视为未完成选择。独立的主对话确认记录按父会话、规范项目路径和 CLI 隔离，Host 重启后继续使用；其他对话或设置页修改默认不会改写已确认对话。临时角色可随完整设定沿用，不加入角色库；预设库编辑仅在重新选型时生效。

选择队列限定同主对话、项目和 CLI；各等待者可以取消，当前询问取消后后续调用重新取得选择机会。保存前、启动前和原有队列/续聊授权仍核对当前自身账号、模型和强度。两类问题均省略项目路径、说明段落及灰色选项描述；工具指引将提问交由插件内部完成，Client 等待提示同时适用于选型和沿用。
