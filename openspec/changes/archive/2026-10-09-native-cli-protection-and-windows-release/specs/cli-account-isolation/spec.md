# Spec Delta

## MODIFIED Requirements

### Requirement: 自身账号来源
Host SHALL 仅识别各 CLI 自身原生账号目录、插件内该 CLI 登录目录、自己配置的 API Key 和私有环境文件。Host 凭据引用、继承的通用密钥及其他 CLI 账号 MUST 不成为本 CLI 登录证据或由插件注入执行。原生登录同一服务商属于本 CLI 自身来源，不按服务商名称误判跨 CLI；插件不额外提供操作系统级文件禁读隔离。

#### Scenario: 只有其他账号
- **WHEN** 仅 Harness 或其他 CLI 有账号
- **THEN** 本 CLI 无可用模型，任何入口均不能启动模型任务

#### Scenario: 自身 API 配置
- **WHEN** 用户在该 CLI 自身配置中设置 API Key 或私有环境引用
- **THEN** 只允许当前账号确认支持且 CLI 能执行的模型；通用环境及其他 CLI 文件引用无效

