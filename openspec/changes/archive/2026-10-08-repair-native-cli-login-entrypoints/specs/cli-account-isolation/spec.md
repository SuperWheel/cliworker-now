# Spec Delta

## ADDED Requirements

### Requirement: 登录与执行来源贯通
在插件内为 Hermes 建立的原生登录目录 SHALL 成为 Hermes 独立的自身来源，账号状态、模型发现及执行 MUST 使用一致的来源选择。显式切换至插件 Hermes 账号上下文后，退出不得自动回退到全局旧账号；原生全局数据保留。

#### Scenario: 独立 Hermes 登录
- **WHEN** 用户通过插件 Hermes 原生菜单建立自身账号
- **THEN** 账号状态、目录和新任务均识别该目录；只有该 CLI 真实原生登录流程或自身 API 配置被允许，其他工具导入来源仍被拒绝

#### Scenario: 插件 Hermes 账号退出
- **WHEN** 插件 Hermes 自身登录目录的账号被退出或更换
- **THEN** 状态和模型同步失效或重新核对；旧任务不能用全局账号或旧快照继续执行

#### Scenario: 全局账号保持
- **WHEN** 插件准备和关闭独立 Hermes 账号菜单
- **THEN** 不复制外部账号、不删除原生账号、不覆盖原生配置和历史；只保留该插件登录来源及必要的私有状态
