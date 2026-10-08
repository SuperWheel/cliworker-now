# Design

## Context

AccountStatus.verification 已定义为 cli/local 读取来源，Client 却把它当登录真伪门槛。Antigravity Host 已返回 authenticated/local；ZCode 精确 native account-provider identity/key 绑定被降为 configured。账号 detail 又把 Host summary 和固定验证声明二次拼接。

## Goals / Non-Goals

**Goals:** 准确投影原生登录、简洁单行账号信息、保留缺配置及错误的区别。

**Non-Goals:** 不自动登录/刷新 OAuth/生成模型任务；不扩大模型目录、不修复外部安装、不写现有凭据。

## Decisions

- Host 负责证据判定。Antigravity 保持原生可续用会话语义；ZCode 仅支持的原生 provider 且当前 identity 精确绑定为 authenticated，普通 key/配置不升级。
- Client 以 state 判断登录，verification 仅表示来源。configured 保持中性，刷新期间仍失效旧结果；不把任意 local 值改成已登录。
- 账号信息去掉 Host summary 的二次拼接和正常状态 detail 段；必要错误使用短文案。删除终端静态免责声明，保留原生操作及清理失败。
- Gateway/持久化结构和模型账号筛选保持兼容。新版本 0.6.10，隔离 UI 验证后无活动任务时备份并更新 Desktop；旧 lib 可回退。

## Risks / Trade-offs

- 错把任意 key 当登录：以 provider、当前 identity 和精确绑定限制，并回归未配置/旧 identity/过期会话。
- 精简隐藏真实错误：只删冗余正常说明，错误仍保留原因与动作并做渲染检查。
- 文案过长：实际正常行短文本，不用 ellipsis 掩盖长免责声明；安全账号身份可有完整 title。
