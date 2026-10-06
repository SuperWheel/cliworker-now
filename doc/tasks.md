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


## v0.4.2 — 原生设置层次与登录身份（2026-10-05）

- [x] 原生设置页排版：40px品牌图标、24px CLI大标题与副标题；左说明/右控件、细分隔线，导航188px、弹窗800px，模型/强度控件240px；保持36px按钮、固定高度、独立滚动与灰色悬停过渡。
- [x] 账号区显示绿色点+“已登录”及安全邮箱；API只显示“API 登录”。本地会话与CLI状态明确区分来源；读取中、失败及关闭后隐藏旧邮箱。摘要固定52px，不因有无身份跳动。
- [x] AGY按已安装CLI格式读取本地OAuth元数据，仅投影邮箱并标明未远程验证。Codex使用自身account/read获取有效账号源，拒绝通过可能过期的auth.json猜测；4秒/64KiB限制并等待进程范围清理。Claude仅投影已登录claude.ai邮箱，MiMo只显示API方式，Kimi配置仍不是已登录。
- [x] 167项测试（12文件）与Host/Client类型检查通过。新增账号投影/过期/异常/密钥排除、Codex RPC握手/取消/清理及客户端状态边界测试。独立复核44项账号相关测试通过。
- [x] 隔离构建通过；真实Harness浏览器验证AGY绿色状态+邮箱+本地来源、Codex邮箱来自CLI、MiMo API标签无账号字段。未执行真实登录/退出、没有更改账号或模型偏好。
- [x] 隔离亮暗主题验证通过。1280×720窗口modal受限为672px；加载前后摘要Y=242、模型按钮Y=442.5不变，控件240px、摘要52px。浅色按钮实测default rgba(38,49,72,0.06)，hover rgba(38,49,72,0.1)，transition 0.18s。截图 .test-data/evidence/v0.4.2-settings-light.png、v0.4.2-settings-dark.png。
- [x] 正式构建、构建后类型检查与打包通过；更新Desktop链接前确认活动worker=0。安装包 artifacts/dsh-cliworker-now-0.4.2.tgz。隔离服务与测试页已关闭，测试主题恢复。
- [x] 用户解锁后完成Desktop重启验收（2026-10-05 13:12）：确认链接当前0.4.2、活动worker及账号终端为0，重启成功。AGY显示大标题、绿色已登录及邮箱和本地来源说明；Codex显示实际账号，MiMo仅显示API登录；模型目录可加载，原生模型菜单可展开并关闭。未登录/退出或修改账号、开关及模型偏好。截图 .test-data/evidence/v0.4.2-desktop-settings.png。


## ZCode 隔离可行性验证（2026-10-05）

- [x] 本机 ZCode 3.14.4 / CLI 0.16.9 的真实帮助、NDJSON capabilities、反向 runtime preferences 请求与空会话验证；实现 scripts/probe-zcode.mjs，不修改正式执行器。
- [x] 最终离线复测三项 sandbox 边界通过：测试目录可写、目录外拒写、plan 工作区拒写；空闲 app-server SIGTERM 退出及进程组清理通过。证据 .test-data/zcode-probe/run-o2uMDT/report.json；未发送 prompt。探针语法、Prettier 与 git diff --check 通过。原始事件、退出状态与哈希不入 Git。
- [x] 用户明确选择 GLM-5.3-Flash；根据官方目录选择 low 进行短任务验证。首次复用桌面账号的首轮报 Select a model before continuing，当时未执行续聊；后续独立授权结果见下。
- [x] 临时构建官方完整 CLI：独立 Node 24.14.0 / pnpm 10.33.2、冻结锁文件、跳过安装脚本；17 个相关 workspace 构建及完整 CLI 离线探针通过。未替换桌面安装。
- [x] 完整 CLI 原生 BigModel 登录可生成授权链接；首次等待超时并清理退出；续接重新授权成功，见下。探针与接入门槛记录在 doc/zcode-probe.md。
- [x] 续接完成独立 BigModel 原生授权；GLM-5.3-Flash / low 的首轮、同会话续聊、Write JSON 产物和真实流式输出中 SIGTERM 取消均通过。证据 .test-data/zcode-probe/run-4XC18i/report.json；取消退出 143、无最终 result，进程组退出确认通过。
- [x] 只读核验 CLI 数据库：真实选型 GLM-5.3-Flash / low；规划为 mode=build 且 planEnabled=true，文件任务为 edit 且 planEnabled=false。脱敏证据 run-4XC18i/runtime-verification.json。
- [x] build 模式 Write 产生 permission.requested 与 permission.resolved(deny)，目标文件不存在；证据 run-r9wKpm/report.json。CLI 仍退出 0，正式适配必须单独判断权限拒绝。
- [x] 后续已完成正式适配与隔离插件验收；本条仅为探针阶段记录，最终结果见 v0.5.0。


## 六项 CLI 验证汇总（2026-10-05）

- [x] Grok 1.0.0 离线帮助、目录、ACP 与空闲停止/沙箱通过；按用户要求不做订阅模型调用，见 doc/grok-probe.md。
- [x] OMP 16.4.4、Pi 1.0.2 复用用户授权的智谱 GLM-5.3-Flash / low，真实首轮、原会话续聊、Write 产物、沙箱拒写和流中取消通过；OMP 显式 write 审批并关闭模型回退，见 doc/pi-omp-probe.md。
- [x] Harness 0.2.0-rc.2 同一智谱选型的真实首轮、续聊、Write 与只读拒绝通过；独立原生 sandbox 下已观察真实 sleep 后代启动、SIGTERM 后完整清理。双层 Seatbelt 的失败记录保留，见 doc/harness-probe.md。
- [x] OpenCode 1.18.21 的免费 MiMo 原生 run/serve 均远端403；经用户改选智谱后，首轮、续聊、实际文件、SSE中取消和原生权限询问拒绝通过，见 doc/opencode-probe.md。
- [x] ZCode 探针加强 Write 的调用ID/路径/成功结果关联，以及权限 requestID/toolCallID 对应；已有真实事件离线复核通过，没有为此追加模型调用。
- [x] 五个新增探针语法/格式检查和原始报告复核完成。凭据与运行数据均留在忽略目录；未修改原账号配置。
- [ ] 统一接入在隔离 worktree 开始；本次验证提交不代表插件已构建或 Desktop 已更新。


## v0.4.3 — 正式 Logo、紧凑账号操作与登录弹窗（2026-10-05）

- [x] 已确认 official-v1 为最新选定原图，逐字节复制到运行素材，SHA256 `1dab209b70d93af5571dfc24663b6be2b746e48b61d2093f94fddd2cb6156318`；字标与NOW标记使用原生字体/主题，工具栏同步新标志。
- [x] 账号/退出/切换入口同行、红色退出紧邻账号；按用户追加要求恢复切换账号和账号终端的原生浅描边按钮。刷新图标化，移除3条正文说明；账号来源仍可悬停查看。
- [x] 独立原生账号弹窗；初始化失败、20秒等待、12秒清理等待、30秒Host分配上限、重试、迟到终端与取消/断流清理均有明确反馈与互斥。只读复审未发现阻止交付的问题。
- [x] 全套189项测试（12文件）通过；最后描边样式改动后额外设置测试37项及Host/Client类型检查通过。两次隔离构建均成功。
- [x] 隔离Harness真实UI验证亮暗设置页与标题；原生描边实测0.5px、浅色 rgba(0,0,0,0.12)，按钮36px，颜色过渡0.18s。模型查询、设置关闭与局部加载可用，保存按钮在可视范围内。
- [x] 明确标注“模拟账号终端”的真实PTY：点击登录即出现独立弹窗，输入ping得到ECHO: ping；关闭账号弹窗后设置仍可操作，PID5513已不存在。未触发真实登录/退出或修改默认模型/账号。截图 `.test-data/evidence/v0.4.3-synthetic-account-terminal.png`、`v0.4.3-settings-light.png`、`v0.4.3-settings-dark.png`、`v0.4.3-overview-light.png`。
- [x] 隔离预览标签/服务器已关闭，测试主题恢复深色。Desktop更新前活动worker为0、无打开的账号终端。
- [x] 正式构建、构建后类型检查及pack通过；Desktop重启后实际确认新Logo字标、账号同行操作、浅描边按钮、刷新图标与目录加载。截图 `.test-data/evidence/v0.4.3-desktop-overview.png`、`v0.4.3-desktop-settings.png`；安装包 `artifacts/dsh-cliworker-now-0.4.3.tgz`。正式环境未触发登录/退出，设置页留供用户检查。


## v0.5.0 — 六个 CLI 统一接入（2026-10-05）

- [x] 共享 CLI 列表扩展到 11 项，新增 ZCode、Grok Build、OMP、Pi、Harness、OpenCode 独立目录与执行适配器；复用项目偏好、首次选型、两层任务列表、停止、同会话续聊与持久化恢复。原生 RPC/JSONL 分别解析，不混用协议，不静默回退。
- [x] Pi/OMP/Harness/OpenCode 按用户授权复用原生 credentials 服务中的智谱引用，只经子进程环境传递；ZCode 使用本次新授权的独立私有目录。Pi 官方 1.0.2 运行时已固定安装；ZCode 实测 Desktop 内置 CLI 无头入口可用。
- [x] 真实 WorkerRuntime 集成验收：Pi run-lYyKgY、OMP run-js51Io、OpenCode run-0ArlRb、Harness run-Ygfv7g、ZCode run-snDbO7；五个 CLI 各首轮、原会话续聊、JSON 文件任务，共15轮通过。核对原生会话ID、实际模型、工具事件、文件内容/哈希和重开Storage后的时间线。证据位于隔离 worktree 的 .test-data/extended-smoke/。
- [x] Grok 仅完成离线原生目录、参数、协议和取消验证；没有订阅任务验收。OpenCode 免费 MiMo 两次403保留，不规避免费层限制；经用户改选智谱后真实验收通过。
- [x] 私有目录逐层拒绝软链、写配置原子替换，避免 Host 在沙箱启动前越界。进程范围确认退出后权限收敛，跳过软链并拒绝硬链接；目录查询使用独立 query 状态。旧验收数据收敛后共498文件，密钥泄漏0、文件权限异常0；原始宽权限审计保留，366项为ZCode公共插件缓存资源。
- [x] 隔离原生 Harness UI 实测11个导航、六个新增目录查询、模型/强度菜单、原生账号按钮禁用及灰色待确认状态。未保存模型偏好、未执行账号登录/退出。截图 .test-data/evidence/v0.5.0-settings-eleven-cli.png；新增CLI品牌暂用主题文字缩写。
- [x] ZCode明确禁用原生子代理、Skill、工作流/跨会话调度及node_repl。源码与无模型调用反证确认：CLI仍加载用户全局插件/MCP，plan可直接允许未标注破坏性的MCP，edit显式授权也可放行；无头broker仅拒绝ask分支。文档和目录提示保留这一实际边界，不声称完全MCP隔离。
- [x] 最终隔离回归：18文件249项测试、Host与Client类型检查通过；build:preview成功，逐文件哈希确认预览src与最终源码一致。新增测试包含分流协议、原生目录、权限拒绝、取消、状态迁移、凭据引用、并发查询、软硬链接边界；真实停止证据沿用前述原生探针，不追加未授权Grok调用。
- [x] 与 v0.4.3 界面修改完成三方合并，保留其他图标归档改动；主目录18文件271项测试、类型检查、隔离构建、正式构建和pack通过。安装包 artifacts/dsh-cliworker-now-0.5.0.tgz 核验142项，桥脚本齐全且无私有运行数据。更新前Desktop活动worker=0；仅添加本插件智谱凭据引用/ZCode独立目录，其他配置未变。Desktop重启后11个CLI导航与Pi原生目录查询可用，未启动新模型任务或保存偏好。

## v0.5.1 — 六个新增 CLI 的账号入口修复（2026-10-05）

- [x] 根因：扩展 CLI 的任务协议已接入，但 AccountManager 仍统一返回空 actions 并拒绝启动账号终端。移除此占位限制，按真实能力分流。
- [x] ZCode/Grok 使用经原生 help 核验的登录、退出及管理入口；ZCode 完整 0.16.9 离线运行时安装到稳定 managed 路径，3424 文件 SHA256 校验、75包、零符号链接，实际 import TUI 通过。账号与 worker/catalog 共享同一指定来源。
- [x] Pi/OMP/Harness 和有 zaiCredentialRef 的 OpenCode 通过本版原生共享 Store 桥复用原生模型设置；不伪造独立 OAuth 登录或无效退出。Harness 本版无 TUI，管理入口为原生设置。账号状态只显示本地配置事实，不伪称远程验证成功。
- [x] Pi/OMP/OpenCode 原生管理 TUI 沿用同一 API 来源；OpenCode CN模式固定已验证提供商/模型，无ref则使用私有共享原生账号。独立临时目录在失败、取消、进程退出后清理；账号刷新失败不会让已开的原生设置误切成终端。
- [x] 实际隔离页面打开 Harness 原生模型设置；Pi、ZCode、OMP、OpenCode TUI 均已目视确认。OMP首次向导与全局MCP自动发现已修正；无网络、模拟凭据的原生PTY复验确认无向导、无MCP连接、模型可见、0模型任务、最终进程范围为空。证据 `.test-data/omp-account-native-probe/tui-report.json`。
- [x] ZCode/Grok账号终端通过私有launcher使用umask077；在父进程umask022的实际模拟子进程验证中，新目录0700、新文件0600。
- [x] 未执行真实登录/注销或提交凭据，未发送模型任务。Grok 保持离线命令与协议验证范围，没有进行付费/订阅调用。
- [x] 全套21文件331项测试通过，Host/Client 类型检查、隔离构建、正式构建和pack通过；Desktop更新前活动worker=0。
- [x] 解锁后定位并修复 Desktop Client 加载故障：插件重复声明宿主 `settings.section`，触发原生 SlotCore 所有权冲突。改为由框架管理生命周期的共享 Store 桥，关闭插件弹窗后进入原生「模型」设置。新增覆盖两种加载顺序、卸载、能力缺失的回归；本轮3文件68项针对性测试、Host/Client类型检查、隔离/正式构建及重新pack通过。
- [x] 修复后在真实 Desktop 确认11个CLI导航和六个新增管理入口；Harness API入口打开完整原生模型设置，OMP、OpenCode、ZCode原生账号终端均成功显示。OMP/OpenCode展示已配置智谱模型，关闭后相关进程与临时目录已清理；未触发登录、退出或模型任务。截图 `.test-data/evidence/v0.5.1-desktop-native-models.png`、`v0.5.1-desktop-omp-terminal.png`、`v0.5.1-desktop-opencode-terminal.png`、`v0.5.1-desktop-zcode-terminal.png`。正式包 `artifacts/dsh-cliworker-now-0.5.1.tgz` 已重新生成。

## v0.5.2 — 原生登录菜单、账号识别与六款图标（2026-10-06）

- [x] OMP/Pi/OpenCode 登录设置改为原生终端，无 API 凭据前置要求，无模型任务或按键注入；私有账号目录保留，临时终端数据清理。
- [x] ZCode/Grok 原状态只检查文件存在；现按本机格式解析原生本地身份，真实只读检查两者均 authenticated、accountLabel 非空，未输出凭据。
- [x] 用户给出的 ZIP 为旧款；找到并接入项目内 v2-extended 六款PNG，按素材清单统一光学大小和亮暗表现。
- [x] Harness 0.2.0-rc.2 无原生 TUI/登录命令，保留明确禁用说明；未伪造页面、升级 CLI 或跳转原生设置。
- [x] 无网络私有PTY验收中，Pi显示原生认证方式菜单，OMP显示提供商设置页，OpenCode显示 Select provider 登录列表。未提交认证、未请求订阅模型；各进程组退出为空。证据 `.test-data/v052-native-login/`。OpenCode探针使用单层等效文件限制与禁网沙箱，避免macOS禁止嵌套sandbox-exec，不把探针描述成生产沙箱链验收。
- [x] 全套22文件336项测试、Host/Client类型检查通过；隔离构建、正式构建与pack通过，安装包158项、含Pi原生UI入口、无私有运行数据。
- [x] 隔离Harness页面实际打开Pi原生认证方式菜单，关闭终端后设置仍可操作；Grok显示绿色已登录和账号，六款图标暗色可读。证据 `.test-data/evidence/v052-preview-pi-login.png`、`v052-preview-grok-settings.png`。
- [x] 更新前Desktop活动worker=0，隔离worker均终态；预览标签与服务已关闭，未提交认证或保存模型偏好。
- [x] 解锁后重启Desktop加载0.5.2：ZCode/Grok均实际显示绿色已登录和账号，六款新图标在亮色设置页可见；Pi/OpenCode/OMP均打开原生认证菜单后关闭，未选择提供商、提交凭据、退出账号或发送模型任务。Harness显示本版无终端登录界面，按钮禁用。
- [x] Desktop验收额外发现OMP原生向导在300px终端中截断提供商列表；仅OMP终端改为520px，小屏由原生弹窗滚动。2文件55项针对性测试、Host/Client类型检查、隔离/正式构建及重新pack通过；Desktop再次重启确认完整提供商列表。此前受限沙箱内误跑全套测试的3个权限失败（sandbox-exec/ps）保留日志，不视为代码回归。
- [x] Desktop证据：`.test-data/evidence/v052-desktop-zcode-settings.png`、`v052-desktop-pi-login.png`、`v052-desktop-opencode-login.png`、`v052-desktop-omp-login-final.png`。账号临时目录已清理；正式包 `artifacts/dsh-cliworker-now-0.5.2.tgz` 已更新。

## 智能体角色预设与命名（2026-10-06）

- [x] 读取七份用户小说技能，整理为默认角色；保留审稿、规划、修订和草稿授权边界，不执行原技能任务。
- [x] 实现角色库私有持久化、模板 CRUD、每个 worker 的独立快照和临时提示词。
- [x] 原生派遣新增角色问题；稳定命名、重命名、同父会话按名称续聊／状态／停止。
- [x] 标题字标、NOW 对齐与留白调整；设置新增角色卡片；列表与对话显示智能体名称。
- [x] 集成工作区 31 文件388项测试通过；为遵循 Hermes 尚未更新 Desktop 的范围，本轮从 HEAD 8783e5e 单独构建角色功能 0.5.3，未带入 Hermes 或图标归档改动。
- [x] 独立发布目录 `.cache/roles-release` 的26文件354项全套测试、Host/Client类型检查、build:preview、build与pack通过。独立测试首次发现快照夹具漏传自定义worker列表，补回后全套通过；日志保留在其 `.test-data/`。
- [x] 七份默认提示词经独立来源复核；真实隔离Harness页面显示七个卡片，并完成模拟预设新增、搜索及重新打开回读。文件0600；模拟预设只存在隔离profile，不进入Desktop。
- [x] Desktop更新前活动worker为0；备份并更新本插件生成文件后重启，实际确认“智能体名称｜主题”、列表名称/模型/强度、重命名对话框、七个默认卡片及完整提示词编辑表单。未改变原会话名称、模型、登录或任务内容；正式角色库7项、0600。
- [x] 亮色Desktop与暗色隔离页面均目视检查；角色搜索框修正为使用原生Input的span容器铺满可用宽度。生成Host/Remote合同均包含4个新增RPC，未出现404。
- [x] 独立包 `artifacts/dsh-cliworker-now-0.5.3.tgz` 170项，无运行数据或凭据；验证摘要同目录JSON。本轮不发送真实模型任务、不测试小说产出质量。专用隔离预览服务已停止。
- [x] 仅提交本轮角色功能、说明和独立版本号，保留工作区其余并行改动；不推送远程。


## 2026-10-06 — Hermes Agent 隔离接入（v0.6.0）

- [x] 用 Hermes Agent / `hermes` 替换外部 Harness CLI；使用用户 `v3-hermes/hermes.png` 原图。保留 DeepSeek Harness 宿主和旧 Harness 只读历史；旧 session ID、偏好不映射到 Hermes。
- [x] 按用户授权安装官方固定提交 `4787e4d56fc8d9265d4c7d3c0fe5accee86b4078`，实际版本 `v0.21.5+7527.g4787e4d`、Python 3.14.7；跳过浏览器与电脑控制依赖，不安装 Hermes Desktop 或启动 gateway。
- [x] 原生 `model` 登录向导、`auth` 账号菜单、当前服务商/模型目录、stream-json、session_id 续聊、真实 tokens 投影；按原生已公开能力提供强度，未公开能力不猜测。
- [x] 任务/目录查询使用窄范围 Seatbelt 写入白名单；原生账号、config、.env、源码与依赖保持只读。修复并行目录查询的原生安装锁竞争、连续文本分片重复，以及空安装配置被误判为已配置登录。
- [x] 独立工作树 `feat/hermes-integration` 构建与类型检查通过：`pnpm --config.verify-deps-before-run=false build`、`typecheck`、`build:preview`。未将并行“制作智能体”任务的角色实现和文档混入本包。
- [x] 同工作树完整回归：27 个测试文件、371 项通过，包含 7 项实际 macOS Seatbelt 测试，以及取消/进程清理、流式解析、模型目录、账号读取、历史迁移与 UI 用例。日志位于工作树 `.test-data/final-test.log`。
- [x] 真实 CLI 目录验证：默认 provider=auto 时明确要求选型；私有模拟配置经真实 CLI 返回 fixture/model。配置值为模拟，进程与沙箱真实，未调用模型。最终窄策略真实读取 provider 成功退出 0。
- [x] 最终隔离包在 cliworker-test profile 的设置页中显示 Hermes 新图标与未登录状态，不再显示可选 Harness。真实点击“登录设置”显示提供商列表，“账号终端”显示原生凭据管理菜单；均关闭并确认对应进程退出。截图在主工作区 `.test-data/evidence/hermes-final-login.png` 与 `hermes-final-auth.png`。
- [x] 遵照用户“暂时只完成 Hermes 隔离验证，不更新 Desktop”：没有构建主工作区 lib、更新 Desktop 链接或重启 Desktop；隔离测试 profile 使用后恢复原链接。
- [ ] 真实模型运行、续聊和任务停止：本轮未选模型、未提交凭据、未发送模型请求，留待用户选型后验收。协议夹具与登录菜单验证不等同于真实任务通过。


## 2026-10-06 — Hermes 合入当前角色版本（v0.6.0）

- [x] 用户要求将 Hermes 加入当前版本。基于 `6de1b25` 的智能体预设与命名功能，核对隔离提交 `2469f84`：Hermes 独立实现完整，共享 Host/Client/Storage 逻辑保留角色选择、快照、七个默认角色、重命名与按名称续聊。
- [x] 主工作区 31 文件、389 项测试通过，含实际 macOS 沙箱/进程清理测试；组合版本 `build:preview` 与生成合同后的 Host/Client 类型检查通过。未执行模型任务、登录或退出账号。
- [x] 隔离 UI 同时显示 Hermes 设置、新图标与七个智能体预设；旧 Harness 无可选入口。当前 Hermes 尚未明确选择原生服务商/模型，按设计提示先完成登录设置，不伪造目录。
- [x] 组合安装包为 `artifacts/dsh-cliworker-now-0.6.0.tgz`，与先前仅 Hermes 的隔离包分开；保留现有 Desktop 构建备份 `.cache/desktop-before-hermes-060`。
- [ ] Desktop 生效验收：更新前活动 worker=0、账号终端=0，但完整退出 Desktop 被自动审批拦截（此前暂不更新 Desktop 的约束被视为仍有效，并提示未保存状态风险）。本轮未运行主目录 build 或替换 Desktop 的 lib；等待用户明确允许退出并重启。
