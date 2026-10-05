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


## 多 CLI 扩展：ZCode、Grok、OMP、Pi、Harness、OpenCode

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
