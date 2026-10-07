# Design

## Context

动机见 proposal.md。当前系统提示已提及 agy，但工具参数只接受规范 CLI enum。Harness 提供 `agent/pre-step` 的本轮用户消息以及动态 `systemPrompt.section.text`，无需改核心即可增加上下文提示。ZCode builtin 只提取一个 account provider／GLM-5.3-Flash；Pi／OMP bridge 强制单个 CN GLM route，未连通插件原生登录终端保存的账号。Client 把未配置和认证失败合并为红色。

## Goals / Non-Goals

**Goals:** 单一名称表驱动提示和工具解析；原生目录、账号来源和执行模型一致；状态证据可解释；保持首轮选型、角色、规划和沙箱约束。

**Non-Goals:** 不增加无意图自动启动，不修改宿主或现有 skill，不授权新登录或远端模型任务，不覆盖用户全局 CLI 数据，不将目录条目视作订阅可用性。

## Decisions

1. Host 名称解析接受规范 ID、常用别名以及较长名称的唯一轻微误差。短别名必须精确匹配，retired harness 拒绝；多个目标或歧义返回澄清。工具描述用中文明确例句，可增加只读路由工具。保持省略 cli 的旧 Antigravity 工具调用兼容。
2. 通过原生 pre-step 读取本步 `source.kind=user` 文本，只有明确命令才在提示中标出规范路由；不拼入原始用户文本，不扫描旧历史，不直接调用 launch。动态提示逐步更新并随 agent／插件生命周期清理。普通讨论、否定或引用不生成派遣提示；最终是否调用工具仍由宿主模型决定，离线测试不得声称每个模型必定遵循。
3. ZCode 遍历原生可见 provider 和有效 model，保留完整 ID及推理能力。Pi 采用原生 SDK 查询／模型 registry；OMP 使用原生 models JSON 查询／配置目录。bridge 使用选定模型，动态核验 observed model；没有能力证据的强度保留 default。既有 Flash 原生 ID保持兼容。
4. Pi／OMP 连通插件持久账号目录与 worker 隔离目录；原生账号是读取来源，worker 的 session 和运行状态保持隔离。显式 Host CN 引用作为兼容来源，不能覆盖无关 provider。原生配置使用安全读取／私有副本，凭据不输出、不入 Git、不写全局目录。
5. 账号状态增加明确 unconfigured；unauthenticated 表示已知失效，unavailable 表示读取／配置错误，unknown 保留无法确认。Client 共用指示灯投影，优先区分未配置后再看目录失败。无安装用灰色，但显式执行路径配置失败用红色。不新增隐式网络认证探测。

## Risks / Trade-offs

- [模型仍可能忽略工具提示] → 增加当前步中文路由提示、工具别名解析与真实 prompt assembly 回归；远端主模型服从情况单列未验证。
- [目录存在但无账号／订阅] → 保留原生状态与来源说明，实际错误如实展示，绝不静默换模型。
- [原生账号结构或 CLI 版本变化] → 采用真实当前查询结果及多模型夹具回归，解析失败显式报错，保留未知状态。
- [并行源码修改冲突] → 按路由、模型／bridge、账号／Client 划分文件所有权，Pi／OMP account 文件由模型负责并与状态任务协调。
- [更新中断活动任务] → preview 独立构建及渲染验收；正式 build 前检查 worker 和账号终端为零，备份已生成 lib，保留所有个人状态。

## Migration Plan

新增状态只影响 Gateway 返回值，不迁移个人存储；旧项目偏好及会话 ID不变。发布 0.6.7，preview 验收后正式构建与打包。失败时恢复旧 lib，不覆盖账号、会话或不相关配置。完成实际验证、规格一致性核对和严格校验后同步规格并归档；未做的真实模型验收在 doc/tasks.md 明确保留。
