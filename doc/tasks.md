# 实施任务与验证记录

## 阶段 1：基础准备
- [x] 核验 Harness 0.2.0-rc.2、agy 1.2.16 和真实模型列表（规划阶段只读核验）。
- [x] 建立 AGENTS.md、设计文档和任务清单。
- [x] 初始化 main、提交基础文档、建立 feat/antigravity-mvp。
- [x] 建立锁定依赖及构建脚本。

## 阶段 2：原生接入
- [x] 独立 bundle 可安装、加载、卸载。
- [x] 原生右侧栏与 Host/Client RPC 可用。

## 阶段 3：执行闭环
- [x] 项目级模型选择与继承。
- [x] 流式解析、持久化、并发与会话互斥。
- [x] 停止、续聊、失败与中断恢复。
- [x] 后台完成结果回传父 Agent。

## 阶段 4：体验整合
- [x] 明确调用意图路由及四个模型工具。
- [x] 两层任务树、状态、模型标签、实时记录。
- [x] 明暗主题、窄侧栏、长路径与工具日志展示；滚动位置按贴底状态保持。

## 阶段 5：交付验证
- [x] 类型检查、测试、构建。
- [x] 隔离 Harness profile 集成验收。
- [x] 真实 Antigravity 运行、停止和续聊。
- [x] 安装到本机 Desktop profile 并验证。
- [x] README 安装、使用和卸载说明。

## 实际验证记录

2026-10-04：

- Git：`main` 基础提交 `51e08e0`；开发分支 `feat/antigravity-mvp`；本地身份 SuperWheel，无远程。
- 使用官方 0.2.0-rc.2 包与 Typert 生成器构建，Host/Client 类型检查通过。
- `vitest` 20 项通过：UTF-8 任意分片、畸形与超长输出、会话 ID 冲突、重复最终事件、未知事件、私有权限、锁与崩溃恢复、项目配置隔离、调度、并发互斥、排队取消、停止、认证/非零退出/缺结果、超时与输出限制。
- 真实 smoke：`gemini-3.8-flash-low / low`；首次读取随机 nonce 成功，同 conversation_id 续聊复述成功；另一个真实 CLI 在收到 init 后被停止，已 await 原生管理器的整个进程范围退出。证据 `.test-data/evidence/real-smoke.json`，原始记录留在 `.test-data/real-smoke/`，不入 Git。
- 隔离 profile：`.test-data/harness-home/profiles/cliworker-test`，官方 `dsh plugin add` 安装成功，宿主无插件激活告警，右侧栏及 Gateway 流可用。
- 原生模型问题卡片实际选择 `gemini-3.8-flash-low / low`；确认前没有 worker 进程，等待选择时终止宿主得到 ASK_ABORTED，未创建 worker。
- UI 测试父消息由明确标注的测试夹具创建。子 CLI 为真实调用，首轮返回 `CLIWORKER_UI_OK`；从侧栏续聊返回 `CLIWORKER_UI_OK FOLLOWUP_OK`。Harness Jobs 完成通知与父 Agent 总结实际出现。
- 随后在主对话实际输入“用 Antigravity CLI 新建另一个子 Agent…”，主 Agent 正确调用插件并沿用默认模型，无第二次选择；第二 worker 返回测试目录与 `SECOND_WORKER_OK`。任务树切换后记录互不混淆。
- 真实页面浅色、深色主题均已检查，约 360px 侧栏中模型标签、长路径和输入框可读。暗色截图 `.test-data/evidence/sidebar-dark.png`。

后续验证记录追加于此。

- 最终补充：原生 terminal 的 PID + 启动身份追踪，修复普通 pipe 进程组停止无法覆盖 CLI 工具另建进程组的问题。模拟 detached 子进程回归与真实 agy → Node 工具子进程回归均通过；真实 PID 36433 停止后返回 ESRCH，证据 `.test-data/evidence/real-stop-regression.json`。早期 shell/Python 夹具未产生 PID 标记，不计为通过。
- 增加最终聚合响应去重测试；20 项自动测试、构建、Host/Client 类型检查通过。
- 隔离 profile 官方 remove → add 成功。Desktop 原配置已私有备份，官方 add 完成；Desktop 插件页面显示 v0.1.0 已启用、1 个组件运行中，截图 `.test-data/evidence/desktop-installed.png`。Desktop profile 由 Electron 独占，CLI dump-config 不适用，改用原生插件管理页验收。
- 早期测试驱动手工写入的两份父会话日志不满足 Harness 回放契约；插件 worker 记录正常恢复。驱动已改为仅注册测试命令，不再写入任何父会话日志。旧夹具不计入完整恢复验收。

- 最终原生恢复验收：通过 Harness UI 全新创建会话“Antigravity CLI 恢复验证指令”，真实派遣得到 `NATIVE_RECOVERY_OK`。关闭并重启宿主，父历史正常回放、worker 记录恢复且无重复；侧栏续聊返回 `NATIVE_RECOVERY_OK RESUMED_OK`（页面恰有 1 条），证明保留原 CLI 上下文。截图 `.test-data/evidence/sidebar-recovered.png`。
- 界面显示来自 CLI 的原始公开粒度；不会承诺逐 token、未公开思维链或拦截任意外部 CLI。系统级双重 fork 后瞬时脱离祖先链等极端情况不在本轮验收覆盖内。

- 干净构建与打包通过；安装包 `artifacts/dsh-cliworker-now-0.1.0.tgz`，不包含测试夹具、凭据或运行数据。源码链接安装已完成，源码目录需保留原位。

## 阶段 6：体验与稳定性（v0.1.1）

用户选择优先完善体验与稳定性，继续保持 Antigravity 单 CLI、两层任务树。

- [x] 修复切换任务草稿丢失及异步操作结果串到其他任务的问题。
- [x] 断线保留记录、提供重新连接按钮；切换时不短暂展示其他任务的数据。
- [x] 保持历史阅读位置并提供回到最新消息入口。
- [x] 显示持久化错误和无法续聊原因；结束后不再把未完成工具显示为运行中。
- [x] UI 交互与宿主状态回归测试、原生侧栏验收、版本与文档同步。

### v0.1.1 实际验证（2026-10-04）

- 28 项测试通过（21 项 Host/协议/进程与 7 项 React 交互回归），Host/Client 类型检查通过。新增覆盖草稿隔离、延迟成功/失败归属、断线保留与重订阅去重、滚动位置、缺失会话 ID、父会话切换；恢复中断事件只追加一次。
- 完成结果改为独立快照，并验证续聊不改变已完成轮次的 runId/status/response。
- 在隔离 profile 安装预览包，已有 v0.1.0 历史正常读取。原生 UI 创建真实第二 worker“体验验收”，返回 `UI_STABILITY_OK`；两个 worker 的未发送草稿切换后分别保留。
- 真实 CLI 续聊生成 30 行记录，原生滚动至顶部出现“回到最新消息”；点击后距底部 0.5px。截图 `.test-data/evidence/sidebar-v0.1.1-history.png`。
- 观察到父 Agent 曾复述旧轮摘要，而侧栏实际内容正确。因此通知补充本轮任务/runId、续聊标签和读取当前结果的指引；不以模型自述作为验证依据。
- 自动重连失败入口使用受控断流的 React 测试验证；未以伪造数据充当真实 CLI 输出。

- 最终真实续聊返回 `V011_FOLLOWUP_OK`；磁盘状态 completed，runId `a8bc3b31-7b26-40a8-86ce-17b096efeac7`；父 Agent 实际引用了本轮结果与新运行编号。证据 `.test-data/evidence/v0.1.1-acceptance.json` 和 `sidebar-v0.1.1-final.png`。
- 正式干净构建、类型检查和 `pnpm pack` 通过，安装包 `artifacts/dsh-cliworker-now-0.1.1.tgz`。确认 Desktop 无活动 CLI worker 后更新链接包；原生插件页显示 v0.1.1 已启用、1 个组件运行中，截图 `desktop-v0.1.1-installed.png`。隔离验收服务器已停止。

## 阶段 7：历史浏览与任务查找（v0.1.2）

- [x] 原生分页读取已保存的完整逻辑记录，支持向前/向后翻页和返回实时。
- [x] 历史阅读期间保留当前位置，运行中的实时更新不覆盖历史页。
- [x] 按标题/模型/强度与状态筛选子 Agent，筛选不停止任务、不丢草稿。
- [x] 复制具体回复或本轮结果，明确成功/失败反馈。
- [x] 分页边界、身份隔离、并发新增事件及 UI 交互测试；隔离原生验收后升级 Desktop。

### v0.1.2 验证记录（2026-10-04）

- 35 项测试通过；新增覆盖 1,250 行记录完整回读、双向分页无重叠、实时追加不移动页边界、非法/跨任务游标、历史页对抗新快照与迟到请求、筛选保留选择和草稿、复制原文及拒绝写入的反馈。
- 隔离 profile 以 `maxTimelineItems: 10` 的仅测试 overlay 验收，使用已有真实 CLI 记录而非写入模拟对话；Desktop 正式默认仍为 1000。
- 原生侧栏中“体验验收”共 12 条逻辑记录：实时显示末 10 条，向前读取 1–2，向后读取 3–12，再返回实时。筛选标题及“进行中”状态符合预期，清除筛选后恢复列表。
- 点击复制最新结果显示成功；直接粘贴到未提交的输入框核对 `V011_FOLLOWUP_OK\n` 完全一致，随后清空，未派发新任务。浏览器自动化的虚拟剪贴板读接口返回空值，因此以真实 UI 粘贴验收为准。
- 隔离预览、正式构建、Host/Client 类型检查和打包通过；安装包 `artifacts/dsh-cliworker-now-0.1.2.tgz`。更新前确认 Desktop 无活动 worker，插件管理页已显示 v0.1.2 启用且 1 个组件运行中。
- 原生历史页截图 `sidebar-v0.1.2-history.png`、安装截图 `desktop-v0.1.2-installed.png` 和验收摘要 `v0.1.2-acceptance.json` 留在 `.test-data/evidence/`，不入 Git。隔离服务器与临时验收页面已关闭。本轮使用已有真实 CLI 记录验收，没有新增 CLI 推理调用。

## 阶段 8：多 CLI（v0.2.0）

- [x] 识别 CLI 与项目偏好隔离，兼容旧 Antigravity 数据。
- [x] Codex / Claude / Kimi / 官方 MiMo 的参数、协议和模型目录适配。
- [x] 侧栏 CLI 标识、独立默认设置与模型实际映射显示。
- [x] 模拟协议、配置隔离、能力限制与 UI 交互回归。
- [x] 隔离 Harness 原生界面验收、正式构建与 Desktop 更新。
- [ ] 四种新增 CLI 均完成真实首轮、续聊和停止验收。

### v0.2.0 验证记录（2026-10-04）

- 本机版本：Codex 0.160.0、Claude Code 2.1.176、Kimi Code 0.42.0。官方 MiMo 0.1.15 仅安装在项目缓存用于帮助与模型目录核验，不是全局安装或登录。
- 用户已选定真实验收配置：Codex gpt-6-luna / low，Claude sonnet / low，Kimi kimi-code/k3-256k / CLI 默认强度。
- Codex 与 Claude 的首轮随机标记回复及原会话续聊均通过，证据 `.test-data/evidence/multi-smoke.json`。Claude 本机 sonnet 别名实际映射为 glm-5.2[1M]；不能把本次成功表述为 Anthropic Sonnet 模型验收。
- Kimi 真实运行返回订阅访问权限 403、状态 failed；没有完成首轮或续聊，不重试消费，不修改订阅。
- MiMo 官方缓存 CLI --help 与模型目录解析通过（7 个模型）；没有执行真实推理，尚待安装/认证及用户模型选择。
- 模拟协议与回归测试目前 54 项通过；模拟数据不替代真实 CLI 验收。

- 用户随后安装官方 MiMo 0.1.15，路径 `~/.mimocode/bin/mimo`。插件识别官方用户目录安装位置，解决 Desktop 未加载 `.zshrc` 时找不到新命令的问题；该真实安装的模型目录已在原生侧栏读取。
- 最终 57 项测试通过，包含混合 CLI 同目录写任务排队、续聊不可换执行器、Kimi tool-only EOF 不误报成功、原生按钮提交类型与设置失败处理。Host/Client 类型检查、隔离构建、正式构建和 pack 通过。
- 原生 UI 暴露旧设置按钮默认为 type=button，已显式改成 submit；实际保存 Codex gpt-6-luna/low 后重新打开读取一致，磁盘偏好与旧 Antigravity 偏好分别存在。
- 原生混合任务树使用实际 smoke 的 worker/event 文件，导入到隔离 profile 的已存在父对话；标题明确“真实记录导入验收”，只调整插件测试数据中的父关联，未写入 Harness 主对话日志，不计为主 Agent 自然语言派遣的真实验收。
- 原生 UI 验证 Claude 实际模型、Kimi 默认强度与 403 错误、Codex/Kimi/MiMo 模型目录。截图 `.test-data/evidence/sidebar-v0.2.0-multi.png`。Desktop 无活动 worker 后更新，插件管理页显示 v0.2.0 已启用、1 个组件运行中。
- 安装包 `artifacts/dsh-cliworker-now-0.2.0.tgz`。Kimi 真实成功与续聊仍被账户权限阻止；MiMo 真实首轮和续聊已通过。各新增 CLI 的真实停止尚未分别验收，共享原生进程清理回归已通过。不可将这些未验收项写成已完成。

- MiMo 用户选定 `xiaomi/mimo-v2.5 / low` 后，真实随机标记首轮、同 sessionID 续聊均 completed 且回复匹配，证据 `.test-data/evidence/multi-smoke-mimo.json`；没有改为自动选模或其他模型。

- 最终原生页面展示六个直接 worker（含旧 Antigravity 与三种新增 CLI 的真实结果、Kimi 失败），MiMo 回复与模型/强度标签正确；Kimi 无会话 ID 时续聊禁用。最终截图 `sidebar-v0.2.0-mimo.png`、安装截图 `desktop-v0.2.0-installed.png`、验收摘要 `v0.2.0-acceptance.json` 均位于 `.test-data/evidence/`。隔离服务器在验收后关闭。

## CLI 卡片图标设计（2026-10-04）

- [x] 核验五类 CLI 的官方素材或本机官方应用图标。
- [x] 使用内置 image_gen 生成五组扁平图标，共六张 PNG（Kimi 分亮暗主题）。
- [x] 核查六张 PNG 均为 1254 × 1254 RGBA，四角完全透明；记录透明像素与主体边界。
- [x] 浏览器实看亮暗卡片中的 24px／32px 图标，保存 `doc/assets/cli-icons/v1/preview.png`。预览服务与临时页面已关闭。
- [x] 素材、来源说明、完整提示词和预览页保存到项目。
- [x] 图标已在 v0.3.0 接入正式父级页面并跟随 Harness 主题。

本轮没有修改业务代码或安装版本，没有调用真实 CLI，也没有重跑业务测试。验收范围为图标素材、透明通道和浏览器视觉展示。

### 项目独立图标（2026-10-04）

- 使用内置 image_gen 生成 CLI Worker Now 独立扁平图标，保存于 `doc/assets/project-icon/v1/`。
- 已目视检查图形，核查 PNG 的 RGBA 与四角透明；完整提示词和透明通道检查随素材保存。未接入运行界面，未运行业务测试。

### 项目图标第二轮（2026-10-04）

- 用户否定 v1 与 Codex 过于相似；已在素材说明中标记否定状态，保留历史文件。
- 使用内置 image_gen 新生成 A 会话气泡、B 任务分派、C Worker W 三张扁平透明 PNG，保存于 `doc/assets/project-icon/v2/`。完整提示词与 alpha 检查随素材保存。
- 已目视检查三张生成图并确认 RGBA 与四角透明；尚待用户选择，没有替换插件图标，没有进行业务代码变更或业务测试。

### 项目 Logo 会话可见方案（2026-10-04）

- [x] 根据项目的多 Agent 对话可视化特点，使用内置 image_gen 生成新设计稿 v3：打开的会话窗口、三条并列会话、实时状态圆点。
- [x] 原图、完整提示词、设计说明、HTML 预览和浏览器截图保存至 `doc/assets/project-icon/v3/`；未覆盖此前方案。
- [x] 检查 1254 × 1254 RGBA 原图的透明通道，并在浏览器实看亮暗背景及 24px／32px／48px 尺寸。
- [x] 用户已通过素材包选定 v3；v0.3.0 接入插件（此前设计稿阶段未修改业务代码）。

## 阶段 9：B 桌面侧栏设计（v0.3.0）

- [x] 父级按 CLI 分组卡片，子级独立对话与返回按钮；状态在话题后，元数据无“思考”前缀。
- [x] 桌面式消息与续聊框、子级标题去除模型/强度行；实际模型信息保留在任务选项。
- [x] 接入用户提供的七张透明原图，Kimi 随宿主主题切换。
- [x] 搜索、折叠、状态筛选、草稿、历史与停止交互回归。
- [x] 正式构建、打包、Desktop 更新；提交在本地开发分支，不推送远程。

### v0.3.0 实际验证（2026-10-04）

- 59 项测试通过（新增分组/折叠、两页导航、标题元数据与停止入口覆盖）；Host/Client 类型检查和隔离构建通过。
- 隔离 Harness 使用已保存的真实 CLI 记录验证五种 CLI 分组、搜索、返回保留草稿、异常筛选、历史 1–2/12 与返回实时；没有新增 CLI 推理调用，也不把导入记录当成本轮自然语言派遣证据。
- 亮暗主题在 Harness 原生设置内切换，七张 1254px 原图加载成功，Kimi 对应主题图片显示；约 365px 侧栏无横向溢出。
- 发现并修复屏幕阅读器隐藏标签导致的外层滚动溢出；输入框聚焦后标题仍位于侧栏顶部（y=38），长记录只在内部滚动。
- 页面证据保存在 `.test-data/evidence/sidebar-v0.3.0-*.png`，不入 Git。Kimi 原有账户 403 及新增 CLI 单独真实停止验收边界未改变。

- 最终隔离构建、正式构建、Host/Client 类型检查与 pack 通过。pnpm 11 在包版本变更后触发依赖自动重装检查，本轮依赖和锁文件未变，使用 `--config.verify-deps-before-run=false` 执行既有脚本，避免无关重装。
- 正式更新前确认 Desktop 状态目录无 worker 文件/活动任务；插件页刷新后显示 v0.3.0 已启用、1 个组件运行中。原生 Desktop 从侧栏引导打开新版总览空态成功；没有创建虚假任务。
- 安装包 `artifacts/dsh-cliworker-now-0.3.0.tgz`；安装与页面截图、验收摘要位于 `.test-data/evidence/`。隔离主题恢复原深色，验收服务器及临时页面已关闭。

## 阶段 10：原生控件与样式统一（v0.3.1）

- [x] 任务标题与元数据靠卡片左侧 12px 对齐，CLI 标题与任务列表添加分隔线。
- [x] 搜索直接使用原生 Input；筛选使用原生 Button 标准 36px 高度，不覆盖其字体和描边。
- [x] 自定义文字引用宿主字体尺度；对话与续聊响应原生字号设置；圆角、边框和阴影引用宿主参数。
- [x] 隔离亮暗主题/365px 侧栏验收，正式构建与 Desktop 更新，本地提交。

### v0.3.1 实际验证（2026-10-04）

- 16 项 React 页面回归通过；Host/Client 类型检查、隔离构建、正式构建与 pack 通过。本轮未重复运行未改动的 Host/CLI 进程测试，也未新增模型调用。
- 原生搜索输入“体验”仅显示对应任务，进入子页正常；365px 侧栏无横向溢出。标题与元数据实际左边距均为 12.5px（含半像素卡片边框）。亮色卡片和标题分隔线为 0.5px rgba(0,0,0,0.1)，暗色同样使用宿主语义色。
- 在隔离 Harness 设置将字号 14→15，插件正文与续聊框均实时变为 15px，恢复后均为 14px；恢复原深色主题。输入框圆角与主 composer 相同，读取宿主 panel=28px 与 elevation-soft 阴影。
- 更新前 Desktop 无活动 worker；插件管理页显示 v0.3.1 已启用、1 个组件运行中。返回主页面后新版总览正常，未创建模拟任务。隔离服务器和验收页面已关闭。
- 证据 `.test-data/evidence/sidebar-v0.3.1-light-overview.png`、`sidebar-v0.3.1-dark-overview.png`、`sidebar-v0.3.1-dark-conversation.png`、`desktop-v0.3.1-installed.png`；安装包 `artifacts/dsh-cliworker-now-0.3.1.tgz`。

## 阶段 11：消息与 composer 对齐（v0.3.2）

- [x] CLI 入口浅色扁平背景；原生设置、复制、发送图标；搜索框 38px 且移除聚焦蓝圈。
- [x] 原生安全 Markdown 回复，时间/复制操作置于消息下方，24 小时制时间。
- [x] 原生 composer 几何/发送按钮/底栏，取消拖高，内容自动增高。
- [x] 原生模型菜单与强度子菜单，严格区分当前会话固定配置和新任务默认配置。
- [x] 隔离及 Desktop 验收、构建打包和本地提交。

### v0.3.2 实际验证（2026-10-04）

- 17 项 React 交互回归通过；新增验证菜单只写项目/CLI 默认配置，不触发 followup、不更改当前 worker 模型。Host/Client 类型检查、隔离构建、正式构建和 pack 通过。
- 同一个隔离原生页面测量：主 composer 与插件空输入框都高 98px、圆角 28px；插件发送按钮高 34px，背景 rgb(65,118,230)。搜索框高 38px，focus 后 outline=none、shadow=none，描边为 0.5px rgba(0,0,0,0.12)，CLI 入口背景为白色。
- 四行未提交草稿令 textarea 自动变为 100px，resize=none，根侧栏 top 仍为 38px；清空恢复。子会话 Markdown、时间、复制按钮、模型菜单、CLI 真实模型与强度子菜单正常呈现；亮暗主题验收通过。
- 使用既有真实记录；没有新增推理调用，没有修改已保存模型偏好。隔离主题恢复深色，浏览器尺寸恢复，测试页面和服务器关闭。
- 正式更新前 Desktop 有 1 个历史 worker、0 个活动 worker。插件页显示 v0.3.2 已启用、1 个组件运行中；用户已有“说一句你好”对话实际加载新版时间/复制/模型菜单和 composer。
- 安装包 `artifacts/dsh-cliworker-now-0.3.2.tgz`。截图位于 `.test-data/evidence/`：`sidebar-v0.3.2-overview.png`、`sidebar-v0.3.2-conversation.png`、`sidebar-v0.3.2-model-menu.png`、`sidebar-v0.3.2-dark-conversation.png`、`desktop-v0.3.2-installed.png`、`desktop-v0.3.2-conversation.png`。

## v0.3.3 — 模型选择、真实耗时与 Desktop 404 修复（2026-10-05）

- [x] 根因复现：旧 Desktop Host 未重新加载新增 Remote 接口，Client 的 `catalogForCli` 返回 HTTP 404。完整退出并重新打开 v0.3.2 后，同一实际会话设置页恢复模型及强度；由此确认并更新安装说明，不能以插件页刷新/版本号作为接口验收。
- [x] 实际 `agy models` 核验：Flash 3.8/3.7/3.6 各 low/medium/high；Pro 3.1 仅 low/high；GPT-OSS 120B 仅 medium；Claude 型号未公开等级，保守沿用 CLI 配置。
- [x] 按真实目录合并家族名称、保留执行 ID 映射；支持旧 raw ID 偏好，禁止未知强度；默认设置和当前会话配置分别保存。
- [x] 新 `configureWorker`：校验归属、CLI、目录与空闲状态；更改下一轮型号/强度，保留会话 ID 和历史；运行中拒绝变更。
- [x] 模型菜单采用原生 Menu/Input 与 ModelSelect 的模型/强度两项入口；模型可检索。发送按钮采用原生 InputBar 的准确 SVG 路径与 34px 几何，不再使用不同的线条图标。
- [x] 基于完整事件的每轮耗时，分页后仍可展示；展开公开状态、工具及诊断，明确不补写未公开思考。原始 transport 报错改为可操作的中文提示与重试。
- [x] `pnpm test`：4 个文件、64 项通过，含真实子进程组清理。`pnpm build:preview`、`pnpm build`、`pnpm typecheck`、打包均成功。
- [x] 隔离真实 UI：模型菜单 7 个去重选项；切换 Pro 后只有 low/high；切换 Flash low→medium 持久化成功。真实续聊 run `5dd9bfa8-6ccf-48fb-b0a1-d2eb362ec5e4` 返回 `MODEL_SWITCH_OK`，状态 completed；原始 init 实际模型 `gemini-3.8-flash-medium`，conversation ID 仍为 `30229a34-d379-4b19-a844-fae0c0470a5b`。这是新真实请求，不是模拟记录。
- [x] 隔离暗色窄侧栏视觉核验：工作过程显示 13 秒、菜单等级与原生发送图形；证据 `.test-data/evidence/v0.3.3-pro-efforts-dark.png`。
- [x] 正式更新前确认 Desktop 活动 worker 为 0；已生成 `artifacts/dsh-cliworker-now-0.3.3.tgz`。
- [ ] 正式 Desktop 最终交互验收：更新后已执行正常退出，重新打开时 Mac 锁屏，等待用户解锁；不得将此阶段标为已验证。

### 项目 Logo Cli 字形修订（2026-10-05）

- [x] 内置 image_gen 按用户标注修改，原图与提示词保存至 `doc/assets/project-icon/v4/`，保留之前版本。
- [x] 目视检查 Cli 构形与内容移除，核验 PNG 的 RGBA、透明像素与四角透明；原样复制一份到本地素材包文件夹。
- 此次仅修改设计素材，未接入插件，未运行业务测试。

### 项目 Logo 紧凑等高版（2026-10-05）

- [x] 内置 image_gen 编辑 v4，统一 C 主体、l 与 i（含圆点）的上下边界，缩窄 C 与留白。
- [x] 目视检查形状，核验透明通道；原图、提示词和检查结果保存至 `doc/assets/project-icon/v5/`，另复制到本地素材文件夹。
- 本轮未修改业务代码或安装版本，未运行业务测试。

### 项目 Logo 柔和人文版（2026-10-05）

- [x] 用户认可 Cli 基本样式；使用内置 image_gen 优化曲线、比例和双蓝色，并再调整字母间隔以便缩小显示。
- [x] 原图、两步提示词和 alpha 检查保存至 `doc/assets/project-icon/v6/`；保留之前版本。
- [x] 浏览器实看亮暗背景中的 24／32／48px，保存 HTML 与截图。24px 可辨识，推荐标题旁采用 32px 以更清楚呈现间距与尾部。
- 本轮为设计素材迭代，未接入插件，未运行业务测试。

## v0.3.4 — 菜单返回与按钮悬停（2026-10-05）

- [x] 模型及强度子菜单共用顶部返回项；按钮去除静态描边，使用宿主主题色与 180ms 颜色过渡，保留键盘焦点及减少动画偏好。
- [x] 类型检查、18 项 React 界面测试、隔离构建、正式构建及打包通过；安装包 `artifacts/dsh-cliworker-now-0.3.4.tgz`。
- [x] 隔离暗色页面验证模型目录、顶部返回及强度选项；实测按钮 border 为 0px、transition 为 0.18s。截图 `.test-data/evidence/v0.3.4-effort-preview.png`。
- [x] 正式更新前活动 worker 为 0；Desktop 热加载后实际打开模型和强度菜单，均显示顶部返回、真实目录与 low/medium/high，无 404。截图 `.test-data/evidence/v0.3.4-desktop-model.png`、`v0.3.4-desktop-effort.png`。
- 本轮没有新增 CLI 推理或修改会话模型配置。此前锁屏造成的 Desktop 菜单验收阻碍已解除；本轮验证范围为菜单交互和外观。
- 已关闭本轮隔离浏览器页面及测试服务器，保留 Desktop。

### 项目 Logo 近正方形版（2026-10-05）

- [x] 内置 image_gen 在 v6 基础上调整纵向比例，保留原有设计语言。
- [x] 第一轮主体宽高比 1.382:1，继续修订后实测约 1.004:1；验证透明通道，原图与两步提示词保存至 `doc/assets/project-icon/v7/`。
- 此轮仅交付设计素材，未接入插件，未运行业务测试。

### 项目 Logo 舒展比例版（2026-10-05）

- [x] 根据用户要求放宽整体比例，使用内置 image_gen 从 v7 调整；两步提示词和透明原图保存至 `doc/assets/project-icon/v8/`。
- [x] 第一轮实际约 1.499:1，进一步调整后约 1.379:1；按实际测量记录比例，不将提示词目标当作结果。
- [x] 浏览器查看亮暗背景与 24／32／48px 效果，图片等比显示，保存预览页与截图。
- 仅更新设计素材，保留历史版本；未修改业务代码、安装版本或运行业务测试。

## v0.3.5 — 回复与底栏真实用量（2026-10-05）

- [x] 回复栏增加真实 Token 用量与原生日历格式；输入框底栏按左侧状态、中间 Token、右侧上下文圆环排列，复用原生数据库/仪表图标与 13px 次级字号。
- [x] 从私有原始日志只读增量恢复旧记录，区分回复、任务与 CLI 会话统计口径；同一快照不重复计数、历史分页不影响当前底栏；无记录时显示 `—`。
- [x] Antigravity 实际输出只有用量、没有当前上下文占用/容量；显示未知值和解释，不以累计用量生成虚假百分比。
- [x] 灰色/禁用按钮及 summary 增加平滑 hover，保留 disabled 操作限制与减少动画偏好。
- [x] 类型检查通过；全套 5 文件 72 项测试通过（首次沙箱内的进程清理测试被 ps 权限阻止，在批准的执行环境中重跑全套通过）。之后日期/读数边界微调，26 项相关回归与类型检查再次通过。
- [x] 隔离构建及暗色窄侧栏检查通过：旧 Antigravity 两次回复分别 21.5K、5.4K tok，底栏会话累计 26.9K tok；三项底栏同为 y=951、13px 字号。按钮 border=0px，transition=0.18s。截图 `.test-data/evidence/v0.3.5-preview-usage.png`。
- [x] 正式更新前活动 worker 为 0，构建、打包后完整重启 Desktop。原有“说一句你好”回复真实用量 20851 tokens 显示为 20.9K tok，日期显示 10月4日 22:19，底栏同样显示 20.9K tok。截图 `.test-data/evidence/v0.3.5-desktop-usage.png`。
- [x] 安装包 `artifacts/dsh-cliworker-now-0.3.5.tgz`；关闭隔离页面与服务器。本轮未新增 CLI 推理、未修改用户会话或偏好。


## v0.3.6 — 原生交互与上下文占用（2026-10-05）

- [x] 分隔线改用 Harness WorkStatus 的 border-l2。隔离暗色界面实测原生与插件均为 0.5px solid rgba(255,255,255,0.12)，高度 33px、100ms 颜色过渡。复制按钮均为 28px、8px 圆角，使用原生 Tooltip；菜单复用原生 Menu、原生箭头/选中图标及对应尺寸。
- [x] 回复与底栏的用量改为可点击详情，上下文使用原生定位/外部点击关闭能力、264px 详情面板；隔离验收确认 Esc 和点击外部关闭，两级菜单返回均在顶部。底栏状态恢复彩色圆点。
- [x] CLI 1.2.16 的模型目录和流式输出缺少上下文容量；核验其嵌入 protobuf 描述和插件所管理会话的 SQLite 元数据，增加只读可选适配。真实“说一句你好”读数为 28,757 / 256,000，显示 11%，明确为最近一次请求的 CLI 估算。
- [x] 新增 5 项模拟 protobuf/SQLite 测试：字段解析、非法值与未知字段、只读不修改数据库、归属与路径校验、最新元数据与缓存失效。类型检查及 6 文件 77 项测试通过；首次普通沙箱测试的 ps EPERM 在获准的执行环境中重跑通过。
- [x] 隔离构建、暗色界面验收、正式构建和打包通过。更新前 Desktop 活动 worker 为 0；完整重启后，在真实 Desktop 会话打开上下文详情并核验数值、日期、Token 与绿色圆点。最后修复无用量日志时仍可提供上下文，类型检查、77 项测试及两种构建再次通过。
- [x] 截图：.test-data/evidence/v0.3.6-preview-menu.png、v0.3.6-preview-context.png、v0.3.6-desktop-context.png。安装包 artifacts/dsh-cliworker-now-0.3.6.tgz。
- 本轮没有新建 CLI 推理、改动会话模型偏好或修改原始 Antigravity 数据库。主题和原生组件仍以 Harness 0.2.0-rc.2 为适配基线；CLI 未提供有效上下文时保留未知值，不承诺所有 CLI 都有该数值。

## v0.3.7 — 暗色卡片、悬停反馈与 v8 Logo（2026-10-05）

- [x] 暗色分组卡片与未选中筛选按钮共用 interactive-bg-hover；隔离界面实测两者均为 rgba(255,255,255,0.08)，取代过亮的 elevated-fill。
- [x] 顶部入口移至原生 header.utilities 尾部，移除 CLI 文字及计数，仅保留 Logo、无障碍名称与原生 Tooltip；Desktop 实际点击入口正常。
- [x] 项目入口、侧栏标题、空状态使用 v8 透明原图，SHA-256 与设计源文件一致，object-fit:contain 保持比例；侧栏图标槽实测 32 × 32px。各 CLI 品牌图标不变。
- [x] 恢复灰色按钮 180ms ease 的背景色、字体颜色及透明度过渡；实际 DOM 计算样式确认生效；禁用控件保留 disabled，减少动态效果设置保留。
- [x] 类型检查、18 项 React 界面回归、隔离及正式构建、打包通过。更新前活动 worker 为 0；Desktop 自动加载新 Client，实看亮色布局与右侧图标入口。
- [x] 验收截图：.test-data/evidence/v0.3.7-preview-dark.png、v0.3.7-desktop-light.png；安装包 artifacts/dsh-cliworker-now-0.3.7.tgz。
- 本轮仅界面/资源变化，没有启动新的 CLI 推理或修改用户会话配置；关闭隔离页面与测试服务，保留 Desktop。

## v0.3.8 — 白天灰色按钮悬停修复（2026-10-05）

- [x] 定位：亮色默认灰底与 hover-solid 视觉近似，只有 transition 并不能产生可见变化。亮色灰色筛选按钮、返回及禁用灰色控件悬停改用原生 interactive-bg-active，保留 180ms ease 和减少动态效果偏好；不改变暗色与已选筛选按钮。
- [x] 隔离构建后切到浅色实际验证：未选中“进行中”按钮 aria-pressed=false，默认 rgba(38,49,72,0.06)，真实 :hover=true 时最终为 rgba(38,49,72,0.1)，捕获到动画中间色，transition 为 0.18s。截图 .test-data/evidence/v0.3.8-light-hover.png。
- [x] 本轮仅 CSS 与版本文档变化，未新增或重复业务测试。隔离及正式构建、打包通过；更新前活动 worker 为 0。安装包 artifacts/dsh-cliworker-now-0.3.8.tgz。

### 项目 Logo 饱满对话版（2026-10-05）

- [x] 使用内置 image_gen 编辑 v8：放大对话尾部、明显缩小 C 留白并调整字母比例。
- [x] 目视检查变化并核验 RGBA、透明通道和复制一致性；原图与提示词保存至 `doc/assets/project-icon/v9/`。
- 本轮仅交付设计素材，未接入插件，未重新进行浏览器小尺寸验收或运行业务测试。

### 项目 Logo 收窄协调版（2026-10-05）

- [x] 内置 image_gen 调整 C 占比和字母比例，保存 `doc/assets/project-icon/v10/`；按用户要求不另存或展示提示词。
- [x] 目视检查形状，核验透明通道；未接入插件，未运行业务测试。

### 选定 Logo 与整体效果图（2026-10-05）

- [x] 用户选定 v10 Logo；设计记录已同步。
- [x] 内置 image_gen 制作四栏整体概念图，包含父子页面与亮暗主题，已目视检查并保存至 `doc/assets/overall-preview/logo-v10/overview.png`。
- 本轮未修改业务代码或安装版本，图中对话与状态均为示例。

## v0.4.0 — 原生设置弹窗、账号管理与局部加载（2026-10-05）

- [x] 工具栏入口使用原生 utilities、order=-20，位于 Finder(-10) 左侧；24px 小按钮、16px Logo。隔离 DOM 实测入口24×24px，Finder含外框高24px。取消侧栏标题下分隔线。
- [x] 设置复用 Harness Modal/Menu/Button/StateDot，5个CLI导航、账号区、项目默认区，继承亮暗主题。目录、账号、保存分别异步加载；切CLI/关闭取消并隔离迟到响应，不再使用Panel全局busy锁。
- [x] 账号管理使用经过本机核验的各CLI原生参数与PTY，安全状态摘要、登录/切换/退出入口；AGY与Kimi部分操作由用户在TUI输入原生斜杠命令。账号操作与同CLI任务互斥；主会话/插件关闭、中途取消和断流清理；超时和有界内存，无账号日志持久化。
- [x] 119项测试通过（9文件）：25项账号后端、7项账号终端、7项设置、19项Panel及原有协议/进程测试。覆盖跨父会话隔离、启动竞争、关闭与迟到启动、旧CLI响应、真实进程组清理和未确认清理后阻止改账号。初次普通沙箱ps被拒绝，使用获准环境运行完整测试通过。
- [x] 类型检查、隔离构建、正式构建及打包通过。完整更新前确认Desktop活动Worker为0；Desktop重启后实际点击设置，Codex真实状态显示“已通过ChatGPT登录”，模型和强度可选择，无404。
- [x] 隔离界面真实只读验证Codex、Claude、Kimi、MiMo状态；未知/配置存在与已认证严格区分。模型原生菜单、加载圆圈、切CLI、关闭、亮暗主题可用。
- [x] 独立模拟CLI真实PTY验收：界面明确显示“模拟账号终端”，输入ping收到ECHO: ping；关闭终端以及关闭设置两种路径后检查PID均不存在。深色终端跟随主题；修复亮色viewport黑底条。未运行真实登录/退出、未改用户账号或模型默认值。
- [x] 截图 .test-data/evidence/v0.4.0-settings-light.png、v0.4.0-settings-dark.png、v0.4.0-account-terminal-dark-fixture.png、v0.4.0-desktop-settings.png；安装包 artifacts/dsh-cliworker-now-0.4.0.tgz。隔离测试服务器和页面已关闭。


## v0.4.1 — 独立 CLI 开关与稳定设置页面（2026-10-05）

- [x] 每个 CLI 使用 Harness 原生 Switch 独立持久化；关闭后灰化，本次不移动，重新打开/页面刷新后稳定排到末尾。内容顶部始终显示该 CLI 图标与名称。
- [x] 已登录绿色、明确失败红色、未核验灰色；模型目录失败单独记录，不再混成“尚未检测”。不把本地凭据当作认证成功。
- [x] 固定弹窗高度700px并受原生最大可用高度限制，右侧独立滚动；账号摘要/按钮/选择器/说明预留固定空间，spinner位于标题固定槽。控件加载前后DOM和实际坐标不变。
- [x] 原生md按钮统一36px；原生Switch保持36×20px；下拉框及展开菜单实测300px。修复通用hover选择器覆盖active底色的问题，灰按钮实测静态rgba(38,49,72,0.06)，真实hover rgba(38,49,72,0.1)，180ms过渡保留。
- [x] Host在异步选择前后及最终提交校验开关；禁用后不能派遣/续聊/查询目录/探测账号/修改配置/开启账号终端。运行或排队任务与账号终端阻止关闭；历史/任务状态/停止保留。取消信号在读写开关前检查。
- [x] 142项测试通过（10文件），含10项开关持久/竞争/取消约束、20项设置状态和加载布局、19项Panel、25项账号管理及原进程/协议测试。Host+Client类型检查、隔离构建、正式构建、pack均通过。
- [x] 隔离原生Harness真实UI验收：加载前后modal700px、账号按钮/模型选择器/保存按钮位置完全相同；Codex单独关闭后灰化且原位，重开排末，恢复开启成功；亮暗主题、真实目录与账号状态可读。测试开关已恢复全开；未执行登录/退出或修改模型默认值。
- [x] 更新前确认Desktop活动worker为0；重启后实际打开新设置页，开关和模型查询可用，无新增RPC404。证据见 .test-data/evidence/v0.4.1-settings-light.png、v0.4.1-settings-dark.png、v0.4.1-settings-disabled-dark.png、v0.4.1-desktop-settings.png。安装包 artifacts/dsh-cliworker-now-0.4.1.tgz。
