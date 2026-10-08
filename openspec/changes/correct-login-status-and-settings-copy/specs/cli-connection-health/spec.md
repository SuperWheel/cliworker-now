# Spec Delta

## MODIFIED Requirements

### Requirement: 状态一致和证据范围
设置导航、账号摘要与模型目录失败提示 SHALL 使用一致状态含义。CLI 状态报告、可续用的原生登录会话或原生当前账号的精确凭据绑定 SHALL 正确显示已登录和绿点，不能因读取来源为本地就降级。普通 API 配置、孤立凭据或共享 Host 引用 MUST 不冒充原生登录；刷新恢复后 SHALL 更新显示，不修改账号或既有项目偏好。登录状态不替代单独的模型权限筛选。

#### Scenario: 刷新恢复
- **WHEN** 用户修复原生账号配置后刷新
- **THEN** 导航和账号摘要一致更新，并保留原有会话与模型偏好

#### Scenario: 本地账号可读
- **WHEN** 本地账号或 API 配置读取成功但没有远端调用证据
- **THEN** 按原生结构区分已登录会话和普通配置，不要求通过模型生成证明登录，也不将该状态当成远端生成验收

#### Scenario: 本地凭据不冒充登录
- **WHEN** CLI 只有普通配置、孤立 key 或共享 Host 引用，没有原生会话或当前账号精确绑定
- **THEN** 保持已配置或未登录状态，不显示原生登录成功；Host 引用不能覆盖原生账号状态

#### Scenario: Antigravity 原生会话
- **WHEN** 已知原生 consumer 会话有未过期 access 或可续用 refresh
- **THEN** 显示已登录，读取来源为 local 不使其降级；没有可用或续用凭据则保持登录失效

#### Scenario: ZCode 当前原生账号
- **WHEN** 支持的原生 provider 的当前 identity 与对应 coding-plan key 精确绑定
- **THEN** 显示已登录；旧 identity、孤立 key 或未知 provider 不能替代该证据

## ADDED Requirements

### Requirement: 简洁账号信息
所有 CLI 设置 SHALL 用一行必要状态、账号身份或短原因表达账号情况；正常状态 MUST 不附加重复的远端验证、凭据有效性或隐私免责声明。账号终端 SHALL 保留必要操作指导和短错误，不重复冗长声明；不能仅截断原有长段落来完成精简。

#### Scenario: 正常设置
- **WHEN** CLI 已登录、已配置或未登录
- **THEN** 账号区只显示对应短状态及必要身份，不拼接第二段防御性说明

#### Scenario: 错误和终端
- **WHEN** 安装、认证、读取或关闭终端失败
- **THEN** 保留简短原因及必要重试动作，不删除实际错误或堆叠免责声明
