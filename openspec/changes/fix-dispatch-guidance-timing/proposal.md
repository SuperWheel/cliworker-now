# Why

用户首次调用 agy 时，主模型先自行询问角色，之后才进入插件。核对真实会话和 Harness 0.2.0-rc.2 源码确认：systemPrompt.assemble 早于 agent/pre-step；插件在 pre-step 保存的当前调用指引要到下一次模型请求才能出现。原测试使用了相反顺序，未发现问题。

# What Changes

- 将已接收的人类派遣指引作为具名 instructions 上下文附加到同次 pre-step 返回消息，不再等待下一次 system prompt 组装。
- 明确 cliworker_start 负责打开选型，模型无需先获取模型、强度或角色；实际启动仍在用户选型后。
- 按原生顺序验证首次请求，并保留通用提问工具和宿主权限，不拦截、不隐藏问题工具。

# Capabilities

## New Capabilities

无。

## Modified Capabilities

- `worker-dispatch`: 当前派遣指引必须进入接收用户请求的同次模型调用。

# Impact

仅修改插件 Host 路由上下文、工具说明、回归测试和文档；不修改 Harness 核心、用户 skill、账号、历史数据或既有选型协议。真实模型生成不在默认验收范围。
