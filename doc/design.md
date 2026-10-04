# CLI Worker Now — MVP 设计

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

原生右侧栏内采用可折叠树、紧凑任务头、模型/强度标签、可滚动对话和底部输入框。工具输出折叠显示。复用 Harness 明暗主题、字体、状态与间距。运行时禁用续聊；向上阅读时不强制滚到底部。空态、等待、异常和中断提供明确动作。

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
