# Proposal

## Why

OMP、Pi、Hermes 的状态没有提供 logout 动作，设置页因而显示不可用的浅色退出按钮；账号摘要把订阅登录、邮箱和 API 服务商拼接后过长。Kimi 自身认证检查只返回登录布尔状态，遗漏可用于显示的原生账号身份。

## What Changes

- 接通三个 CLI 当前原生支持的自身账号退出入口，复用统一退出按钮与既有账号终端、互斥和清理流程。
- OAuth 登录的可见摘要只写服务商与账号登录，混合 API 信息保留在详细提示；API-only 继续标明 API 服务商。
- 从当前 Kimi 自身认证的真实原生身份信息生成简短账号显示，不猜邮箱或把密钥当账号。
- 完成隔离与原生能力验收、空闲 Desktop 更新和本地提交，不实际退出用户账号、不生成内容。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cli-connection-health`：简洁订阅摘要、统一可操作的退出入口及 Kimi 当前账号显示。

## Impact

修改 Host 原生账号动作和 Kimi 身份投影、Client 登录摘要与相应回归。保持自身账号隔离、模型权限、会话与偏好合同不变；不增加依赖、不修改 Harness 核心。
