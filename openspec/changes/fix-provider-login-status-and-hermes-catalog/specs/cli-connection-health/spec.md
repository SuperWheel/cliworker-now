# Spec Delta

## MODIFIED Requirements

### Requirement: 状态一致和证据范围
设置导航和账号摘要 SHALL 只依据本 CLI 的账号证据；模型目录的等待或失败 MUST 不覆盖已确认的登录状态。CLI 状态报告、可续用的原生登录会话或原生当前账号的精确凭据绑定 SHALL 正确显示已登录和绿点，不能因读取来源为本地就降级。自身有效 API 配置 SHALL 明确显示 API 登录和服务商，不冒充原生 OAuth 账号登录；只有配置声明、孤立凭据或共享 Host 引用 MUST 不冒充认证；刷新恢复后 SHALL 更新显示，不修改账号或既有项目偏好。登录状态不替代单独的模型权限筛选。

#### Scenario: 刷新恢复
- **WHEN** 用户修复原生账号配置后刷新
- **THEN** 导航和账号摘要一致更新，并保留原有会话与模型偏好

#### Scenario: 本地账号可读
- **WHEN** 本地账号或 API 配置读取成功但没有远端调用证据
- **THEN** 按原生结构区分账号登录、绑定服务商的自身 API 登录和仅配置声明，不要求通过模型生成证明登录，也不将该状态当成远端生成验收

#### Scenario: 本地凭据不冒充登录
- **WHEN** CLI 只有配置声明、孤立 key 或共享 Host 引用，没有原生会话或当前服务商精确凭据绑定
- **THEN** 保持已配置或未登录状态，不显示原生登录成功；Host 引用不能覆盖原生账号状态

#### Scenario: Antigravity 原生会话
- **WHEN** 已知原生 consumer 会话有未过期 access 或可续用 refresh
- **THEN** 显示已登录，读取来源为 local 不使其降级；没有可用或续用凭据则保持登录失效

#### Scenario: ZCode 当前原生账号
- **WHEN** 受支持的当前原生 provider、原生用户记录和当前 identity 一致，且 identity 与对应 coding-plan key 精确绑定
- **THEN** 显示已登录；旧 identity、孤立 key 或未知 provider 不能替代该证据

#### Scenario: 已登录但模型查询失败
- **WHEN** Antigravity、MiMo 或其他 CLI 的自身账号已确认登录，模型查询仍在进行或失败
- **THEN** 导航与账号行保持登录状态，模型区域单独显示进度或错误并禁用未确认模型

#### Scenario: MiMo 自身网页登录
- **WHEN** MiMo 原生网页登录把认证写入自己的 auth.json，或项目模型配置发生错误
- **THEN** 按原生认证结构识别当前账号，模型配置错误不阻止独立的账号检查及原生登录入口

## ADDED Requirements

### Requirement: 多提供商认证摘要
OMP、Pi、Hermes 和 OpenCode SHALL 根据各自真实有效认证显示绿色状态，以及服务商的账号登录或 API 登录。存在多个自身认证时 MUST 分别保留服务商与登录方式，不把任意第一个账号当成全部身份；API 摘要不得显示密钥或密钥片段，账号行保持单行，兼容旧 Host 的简短摘要。

#### Scenario: 自身 API 登录
- **WHEN** 本 CLI 的当前有效来源含明确服务商及可用格式的 API Key，且没有已知撤销或禁用证据
- **THEN** 显示对应服务商 API 登录和绿点，例如 zai.cn API 登录；不使用模型目录或其他 CLI 的凭据推断认证

#### Scenario: 多种登录方式
- **WHEN** 本 CLI 同时存在服务商账号登录与其他服务商 API 登录
- **THEN** 同一行分别显示其认证方式，安全账号身份仅可用于账号登录，不把所有项目都标成 API 登录

#### Scenario: 缺失或失效
- **WHEN** 只有模型/provider 声明、模板、未解析引用，或凭据过期/撤销/禁用
- **THEN** 未配置或失效保持原有灰/红状态，不因为显示文案改动而升为已登录

#### Scenario: 登录与模型范围不同
- **WHEN** 自身登录确认但模型目录未知、查询失败或原生执行方式尚不支持
- **THEN** 保留真实登录信息，模型单独给出短原因并禁用未经确认选项
