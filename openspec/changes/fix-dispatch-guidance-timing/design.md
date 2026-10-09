# Context

Harness 的顺序是 inbox.claim → systemPrompt.assemble → agent/pre-step → 模型请求。原实现的 WeakMap 在 pre-step 写入、在 assemble 读取，使当前调用指引晚一步。真实会话第一步先问角色，第二步才出现 agy 指引，验证了时序缺陷。

# Goals / Non-Goals

- Goals: 在第一次处理派遣请求时就提供正确入口语义；只由插件负责完整选型或沿用询问。
- Non-Goals: 不过滤工具 schema，不注册提问 guard，不修改原生 ask_user_question，不自动调用 CLI，不修改已有选型状态机。

# Decisions

1. 在 pre-step 的 next 返回后仅检查已准入的人类消息。使用 Harness 原生 createUserMessage，追加 source.kind=cliworker-invocation、form=instructions 的插件上下文；不改原消息对象。返回消息进入同次模型请求，避免跨步 WeakMap 和滞后 section。
2. 无明确调用、已取消、reject、子 Agent、派遣工具不可见时不追加。正常插件释放由 Cordis effect 清理监听，无跨步状态。
3. 工具文案说明先选型后启动，只需要 CLI、任务标题和任务内容。模型/强度/角色由插件收集，避免主模型把它们当作调用前置输入。
4. 测试先组装 prompt，再执行 pre-step，检查同次返回消息；同时注册原生形态的普通问题工具并验证其仍可见可执行。保留首次完整选型、沿用及取消回归。

# Risks / Trade-offs

模型仍是概率性决策，修复指引时序不等于对所有主模型行为作绝对保证。本轮使用本地模拟和真实原生界面验证，未发起付费模型生成。插件上下文可能保留在原生会话记录中，来源标记与用户请求区分。

# Migration Plan

无需数据迁移。预览构建与验收后，在无活动任务时更新 Desktop 至 0.6.17。保留账号、历史及项目偏好，检查版本和文件哈希，本地提交不推送。
