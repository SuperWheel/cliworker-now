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
