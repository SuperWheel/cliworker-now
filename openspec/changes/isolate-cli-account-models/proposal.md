# Proposal

## Why

当前 Pi/OMP/OpenCode 可借用 Harness 智谱凭据，目录和执行还存在合成模型、通用环境引用、旧任务凭据覆盖当前账号的路径。前五 CLI 的缓存和固定候选也未统一确认当前账号权限。用户要求全部 11 个 CLI 只展示并调用自身账号可用模型，已明确允许该 CLI 自身登录和 API 配置。

## What Changes

- 移除跨 CLI/Host 凭据读取和注入，保留各 CLI 原生及插件内自身账号、API 和私有环境来源。
- 模型和强度由本 CLI 原生能力与当前自身账号范围求交集；未知范围、公共候选、匿名免费入口不放行。
- Host 内部绑定账号来源版本，选型、保存、新任务、出队和续聊重新检查；阻止旧凭据快照恢复已退出的账号。
- 旧 Host 配置兼容读取但不生效，安全停用生成配置和快照；保留原生账号、会话和偏好。

## Capabilities

### New Capabilities
- `cli-account-isolation`: 全 CLI 账号来源、绑定生命周期和迁移。

### Modified Capabilities
- `cli-model-discovery`: 所有 CLI 只提供自身账号允许且原生支持的模型。

## Impact

涉及 Host 账号、适配器、模型发现、运行时和偏好入口；公开 ModelChoice/Preference 保持兼容，内部持久化增加可选匿名账号绑定。更新 README、设计及验收记录。按现有沙箱和 Gateway 接入，不修改 Harness 核心，不删除用户账号。默认验收只读/模拟，不发起模型生成。
