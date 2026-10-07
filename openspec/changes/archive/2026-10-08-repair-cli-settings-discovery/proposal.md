# Proposal

## Why

设置将本地 `configured` 直接显示成绿灯，且 OMP、Pi、OpenCode 账号优先投影同一 Host 凭据，造成未登录也似已登录；Pi 运行入口还优先旧私有安装。六个新增 CLI 的账号、模型与强度必须遵循各自原生来源和统一加载语义，减少派遣时才发现不可用模型的情况。

## What Changes

- 统一设置加载、刷新、失败与取消状态；本地凭据存在不再显示已登录或已连接，账号刷新使旧模型证据失效。
- 六个 CLI 独立读取原生账号、登录入口、模型和强度；显式 Host 引用仅标注为可用的独立凭据来源，不能冒充原生登录。
- OMP 与 Pi 在工具说明、执行入口、安装身份、账号及模型配置上明确分开；发现错误 CLI 时拒绝执行，不静默替换。
- 扩充 ZCode、Grok、Hermes 的账号及 Worker 模型筛选，沿用 Pi/OMP/OpenCode 当前账号交集与失败封闭原则；只有原生能力支持的强度可选。
- 增加回归、真实只读元数据及设置 UI 验收，先隔离构建再更新 Desktop，保留会话与既有偏好。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `cli-connection-health`: 证据明确的登录状态、统一刷新生命周期、独立账号来源。
- `cli-model-discovery`: 六个 CLI 的模型与强度证据及执行入口一致性。
- `worker-dispatch`: OMP/Pi 明确独立身份，不因相同模型或共享技术而混用。

## Impact

涉及 `src/client/settings-dialog.tsx`、Host 账号读取与适配器、模型元数据及路由说明、对应测试、README 和设计/验收文档。无 Harness 核心或用户 skill 修改，不迁移账号、会话或强制改写旧偏好。真实付费生成与用户登录交互不由打开设置触发；远端完整任务成功仍需单独选型和验收。本轮保留现有无关工作区改动。
