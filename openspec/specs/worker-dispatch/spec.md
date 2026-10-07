# worker-dispatch Specification

## Purpose

保证用户在主对话明确指定外部 CLI 时，能够通过插件入口解析名称并进入原生选型与派遣流程；对简称、别名和轻微拼写误差提供可靠处理，同时保持宿主权限、首次选型及直接子 Agent 的边界。

## Requirements

### Requirement: 明确调用与别名路由
插件 SHALL 向主 Agent 提供明确派遣工具及中文调用指引，支持规范名称和常用别名；agy 对应 Antigravity，glm／智谱对应 ZCode。名称解析 SHALL 返回规范 CLI 与解析依据，不得改用其他 CLI 或 shell 执行。

#### Scenario: 用户指定 agy
- **WHEN** 用户要求“调用 agy cli 帮我检查代码”
- **THEN** 提示与工具接受该名称并解析为 antigravity，进入插件选型与派遣路径

#### Scenario: 用户指定 glm
- **WHEN** 用户要求“调用 glm cli”并通过插件提交 glm 名称
- **THEN** 解析结果是 zcode，展示 ZCode 模型，不将 GLM 当作已授权模型

### Requirement: 保守模糊路由与明确意图
插件 SHALL 仅在明确调用上下文解析名称；轻微拼写误差只有唯一可信候选时才可解析。歧义、未知名称和多个目标 MUST 在启动前返回候选或要求澄清。普通模型或 CLI 讨论 MUST 不作为自动派遣授权。

#### Scenario: 唯一名称误差
- **WHEN** 明确调用中传入一个与已知较长名称仅差一个字符且具有唯一候选的名称
- **THEN** 返回规范 CLI 和模糊匹配依据

#### Scenario: 歧义与未知名称
- **WHEN** 请求不能唯一确定 CLI 或传入未知名称
- **THEN** 不启动进程、不保存选型，返回澄清信息

#### Scenario: 普通讨论
- **WHEN** 用户仅询问“GLM 模型有哪些”或引用一段调用示例
- **THEN** 插件指引不要求自动派遣，路由提示不将该消息判作执行请求

### Requirement: 选型和宿主权限保持
派遣 SHALL 保持首次模型与强度选择、每次新 Worker 的角色选择以及项目和 CLI 隔离偏好；子 Agent、宿主规划或整体只读状态 MUST 拒绝外部执行。未选择前和取消选择后 MUST 不启动进程。

#### Scenario: 首次使用与取消
- **WHEN** 用户首次调用一个未保存偏好的 CLI，随后取消选型
- **THEN** 不产生 Worker 进程或自动选择的模型

#### Scenario: 宿主拒绝执行
- **WHEN** 主会话处于规划模式或整体只读状态，或调用来自子 Agent
- **THEN** 返回原有权限拒绝，名称别名不得绕过边界
