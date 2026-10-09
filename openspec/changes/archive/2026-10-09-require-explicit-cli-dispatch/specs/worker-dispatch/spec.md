# Spec Delta

## ADDED Requirements

### Requirement: 新派遣显式 CLI 参数
新建派遣工具 SHALL 将 cli 作为必填参数，包含明确调用 Antigravity 的情况。缺失或无效 CLI MUST 在账号查询、读取选型、保存偏好和创建任务前返回工具参数错误，不得从历史调用、项目默认、标题或任务文本推断为 Antigravity 或其他 CLI，不增加用户询问。历史记录的兼容读取 SHALL 保持。

#### Scenario: Hermes 请求但工具漏参
- **WHEN** 用户本次明确要求 Hermes，主模型调用 cliworker_start 时遗漏 cli，且同对话已有 Antigravity 设定
- **THEN** 原生工具参数校验失败，不读取或使用 Antigravity 设定，不显示选型问题，不启动任何 Worker

#### Scenario: 明确 CLI 后使用对应设定
- **WHEN** 同项目存有 Antigravity 和 Hermes 设定，工具明确传 cli=hermes 或其已支持别名
- **THEN** 只查询和确认 Hermes 的模型、强度和角色；有当前对话设定则按原流程使用，新对话则确认是否沿用 Hermes 设定

#### Scenario: 全部 CLI 与旧历史
- **WHEN** 工具明确选择任一受支持 CLI，或用户查看省略 cli 的旧 Antigravity 记录
- **THEN** 新任务按显式 CLI 路由，旧记录保持原有归属；新任务不得因旧记录省略过 cli 而省略参数
