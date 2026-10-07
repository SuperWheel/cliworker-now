# Proposal

## Why

用户明确说“调用 agy cli”时主 Agent 未稳定进入插件，且“glm cli”不能解析为用户指定的 ZCode。当前 ZCode、Pi、OMP 模型发现限定了验收时使用的 GLM-5.3-Flash，设置页又把未配置与登录失效统一显示为红点，妨碍真实选型和故障判断。

## What Changes

- 增强插件原生系统提示与派遣工具的可发现性，提供明确自然语言调用、别名及保守模糊名称解析；agy 对应 Antigravity，glm／智谱对应 ZCode。歧义和未知名称不得静默派遣。
- 从各 CLI 原生目录及用户已有配置发现 ZCode、Pi、OMP 的完整模型和服务商，执行时保留真实原生模型标识；移除 GLM 单模型限制，不猜模型或强度，不共享新凭据。
- 区分“未安装／未配置／未登录”“配置或认证失败”“已读取登录或配置”以及“无法确认”；未配置灰点、配置失败或已知失效红点，提供相应说明。
- 补充本次触及的派遣、模型发现与账号状态规格，覆盖安全边界、回归、隔离构建和实际界面验收；已有项目偏好、角色选择和会话数据继续兼容。

## Capabilities

### New Capabilities

- `worker-dispatch`: 明确 CLI 派遣、别名解析、保守模糊路由、首轮选型与现有宿主权限边界。
- `cli-model-discovery`: 原生模型和服务商目录发现、原生 ID 传递、缓存与配置失败的可观察行为。
- `cli-connection-health`: CLI 配置和认证证据的状态投影及灰／红／绿指示灯含义。

### Modified Capabilities

无。当前主规格仅覆盖 development-workflow，本次逐步补齐实际触及的业务域。

## Impact

- Host：`src/host/index.ts` 的系统提示与工具、`src/host/adapters.ts`、ZCode 与 Pi/OMP adapters／bridges、`src/host/accounts.ts` 及身份读取模块。
- Shared / Client：模型目录和账号状态类型、设置页与模型选择页的状态映射；Gateway 合同重新生成。
- 测试与文档：派遣、adapter、账号及设置页回归，README、doc/design.md、doc/tasks.md 同步。
- 不修改 Harness 核心或用户 skill，不新增登录、远端付费验收或默认模型授权。离线目录及协议验证不能声称远端模型可用；正式构建更新前核对活动任务。现有无关图标删除不纳入本次提交。
