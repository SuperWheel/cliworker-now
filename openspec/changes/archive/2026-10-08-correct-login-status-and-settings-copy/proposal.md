# Proposal

## Why

用户截图显示账号摘要被重复的证据声明占满。v0.6.9 Client 将 verification=local 一概降级，导致 Antigravity 原生已登录会话显示灰点；ZCode 当前账号与 Worker key 精确绑定被 Host 降为 configured，产生已登录却未登录的误报。

## What Changes

- 状态以原生已登录会话或当前账号精确绑定为依据；verification 只表示读取来源，不代表必须降级。普通配置、过期且不可续用的会话及失效状态继续区分。
- 各 CLI 账号区统一单行必要信息，删除重复拼接、免责声明及终端冗余说明；保留简短可操作错误。
- 保持账号读取、模型权益筛选、偏好、会话、权限和登录动作的既有边界。

## Capabilities

### New Capabilities

无新增能力域。

### Modified Capabilities

- `cli-connection-health`: 原生本地登录证据正确投影及简洁账号状态。

## Impact

Host 的 ZCode 身份投影、Client 设置/终端文案及回归测试；不更改 Gateway 数据形状、不新增依赖或远端生成验收。按隔离构建和界面验收后更新 Desktop，保留用户数据及已有未提交改动。
