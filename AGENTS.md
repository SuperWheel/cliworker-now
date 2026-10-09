# CLI Worker Now

## 目标与边界

为 DeepSeek Harness 0.2.0-rc.2 提供独立的多 CLI 可视化插件，支持 Antigravity、Codex、Claude Code、Kimi、官方 MiMo Code、ZCode、Grok Build、OMP、Pi、Hermes Agent 和 OpenCode。支持明确派遣、项目级模型偏好、实时过程、两层任务树、停止及结束后续聊。遵循 `doc/design.md`；实施进度与实际验证写入 `doc/tasks.md`。

## 开发约定

- TypeScript ESM；Host、React Client 与共享协议分开。通过 Cordis 扩展点接入，不修改 Harness 核心或用户现有 skill。
- Host 负责进程和持久化，Client 只通过 Harness 原生 Gateway 访问 Host。使用参数数组，禁止拼接 shell 命令执行任务。
- 模型、强度与会话 ID 不得猜测。按 CLI 的实际能力生成参数，禁止套用另一种 CLI 的协议或权限开关。首次选择前不启动任务；同会话互斥；同目录写任务串行。
- 使用各 CLI 的原生保护和权限模式，不附加插件操作系统沙箱；遵循宿主权限和规划模式。凭据、用户日志和运行数据不入 Git。持久化目录 0700、文件 0600。
- 所有注册、订阅、进程都必须有生命周期清理。停止操作只有在进程范围退出后才报告成功。
- 使用 Harness 的主题 token 和共享组件；CLI 内容视为不可信文本，不渲染未经处理的 HTML。
- UI 不伪造进度、对话或内部推理。测试夹具须明确标注模拟；真实验收保留可核查的结果。

## 验证与交付

- 常用命令：`pnpm typecheck`、`pnpm test`、`pnpm build:preview`、`pnpm build`、`pnpm smoke:extended --help`；真实模型调用需已有选型授权。
- 测试应覆盖流解析、互斥、取消、恢复、权限边界、配置继承和安装协议。不要只验证实现细节。
- 先用 `pnpm build:preview` 构建隔离包并测试，再正式构建更新 Desktop 链接；更新前确认无活动任务。不得覆盖现有会话、密钥或不相关配置。
- 真实 CLI 完成说明不是验收证据；必须检查事件、退出状态及实际产物。
- 更新用户行为、协议或安装方式时同步 README 和设计文档。只报告真正执行过的测试。
- 使用 `/Library/Developer/CommandLineTools/usr/bin/git`；按阶段提交，不推送远程。

## OpenSpec 工作流

- 阅读 `doc/openspec.md` 和 `openspec/config.yaml`。新增能力、行为/协议/权限变更及跨模块重构，先创建或续用 `openspec/changes/<change-name>/`，再按提案、增量规格、设计、任务清单实施；拼写、排版等无行为变化的小修正可直接完成并记录验证。
- `openspec/specs/` 表示已落实的规格；未覆盖的业务域应在实际变更触及时，对照源码、测试与当前文档逐步补齐。`doc/design.md` 保留架构及历史决策，`doc/tasks.md` 保留实际验证记录；旧版本未勾选项不自动成为当前待办。
- OpenSpec 使用项目锁定版本：将技能示例中的 `openspec …` 命令写成 `pnpm spec …`，不要依赖全局安装。常用 `pnpm spec:list`、`pnpm spec status --change <name>`、`pnpm spec:check`。配置和规则使用中文，保留 OpenSpec 要求的英文结构标题及 SHALL/MUST、WHEN/THEN。
- `.agents/skills/openspec-*` 为官方生成的项目级技能，不手改生成内容；定制写入本文件和 `openspec/config.yaml`。显式选择 explore/propose 时先完成探索/方案；实施仍按用户本次及此前已给出的授权范围执行，不因流程重复索取已有授权。
- 任务完成后先核对规格、实现和验收证据，再运行严格校验并归档。OpenSpec 格式通过或文件存在不等于业务验收通过；必须保留未验证、权限/订阅阻塞及待授权事项，不能虚勾任务或通过归档隐藏缺口。
