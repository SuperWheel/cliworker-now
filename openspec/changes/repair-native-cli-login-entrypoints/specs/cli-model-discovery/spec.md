# Spec Delta

## ADDED Requirements

### Requirement: Grok 自身账号模型目录
Grok 的可选模型 SHALL 由本 CLI 自身账号认证的官方 Build 模型目录与当前原生能力精确求交。匿名、内置或缓存 fallback MUST 不独立证明账号权限；成功空响应、认证拒绝、网络失败和插件尚未支持 SHALL 保持不同的诊断含义，详细解释不堆叠到设置页。

#### Scenario: 有效账号目录
- **WHEN** 自身 Grok 官方 Build 模型请求成功，且模型也被原生 CLI 明确支持
- **THEN** 显示交集和原生报告的强度，不能因曾缺少实现而无条件清空

#### Scenario: 仅原生公共候选
- **WHEN** 原生 ACP 返回候选，但账号目录请求失败或不可用
- **THEN** 模型不可选；不能将该空列表描述成账号没有模型权益的事实

#### Scenario: 账号改变或查询取消
- **WHEN** 账号在查询期间退出、切换，或用户取消查询
- **THEN** 丢弃原结果并结束 HTTP 请求和原生进程，不恢复旧登录或发起生成

#### Scenario: 请求目标与凭据隔离
- **WHEN** 当前凭据不是受支持的自身官方 Build 认证，或响应尝试跳转至另一目标
- **THEN** 不向其他服务发送凭据，不借用通用 API Key 或其他 CLI 账号查询
