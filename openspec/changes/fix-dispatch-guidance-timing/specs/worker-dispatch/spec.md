# Spec Delta

## ADDED Requirements

### Requirement: 同次请求的派遣入口指引
插件 SHALL 在主模型第一次处理已准入的明确 CLI 派遣请求时，提供当前 CLI 对应的入口指引，说明 cliworker_start 先收集选型后启动，无需主模型预先询问模型、强度或角色。指引 MUST 与原始人类消息区分来源，并尊重已准入消息、取消、子 Agent 和工具作用域；不得通过隐藏或拦截通用提问工具实现。

#### Scenario: 原生组装顺序
- **WHEN** Harness 先组装 system prompt 再执行 agent/pre-step，用户本次请求“用agy和我说你好”
- **THEN** 本次模型请求已经包含 cli=antigravity 和进入插件选型的指引，不等到下一步才生效

#### Scenario: 无新增派遣或入口不可见
- **WHEN** 已准入消息不包含人类派遣、步骤被拒绝或取消、当前为子 Agent 或派遣工具不可见
- **THEN** 不新增派遣指引，不修改原始消息，不改变通用提问工具的可见性或执行

#### Scenario: 内部选型不变
- **WHEN** 主模型直接调用 cliworker_start，仅提供 CLI、标题和任务
- **THEN** 插件呈现完整选型或沿用以前设定的问题，用户完成必要选型前不启动 Worker，已有宿主权限检查保持有效
