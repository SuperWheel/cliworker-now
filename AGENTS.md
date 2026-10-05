# CLI Worker Now

## 目标与边界

为 DeepSeek Harness 0.2.0-rc.2 提供独立的多 CLI 可视化插件，支持 Antigravity、Codex、Claude Code、Kimi、官方 MiMo Code、ZCode、Grok Build、OMP、Pi、Harness 和 OpenCode。支持明确派遣、项目级模型偏好、实时过程、两层任务树、停止及结束后续聊。遵循 `doc/design.md`；实施进度与实际验证写入 `doc/tasks.md`。

## 开发约定

- TypeScript ESM；Host、React Client 与共享协议分开。通过 Cordis 扩展点接入，不修改 Harness 核心或用户现有 skill。
- Host 负责进程和持久化，Client 只通过 Harness 原生 Gateway 访问 Host。使用参数数组，禁止拼接 shell 命令执行任务。
- 模型、强度与会话 ID 不得猜测。按 CLI 的实际能力生成参数，禁止套用另一种 CLI 的协议或权限开关。首次选择前不启动任务；同会话互斥；同目录写任务串行。
- 默认沙箱；遵循宿主权限和规划模式。凭据、用户日志和运行数据不入 Git。持久化目录 0700、文件 0600。
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
