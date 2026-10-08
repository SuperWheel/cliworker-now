# Proposal

## Why

OMP、Pi、OpenCode 的自身认证被一律降为“已配置”，Hermes 的真实 Nous 授权格式未被识别，模型查询与账号绑定也缺少 Nous 分支。用户需要绿点和明确的服务商登录方式，并让 Hermes 已授权账号可选择其实际支持的模型。

## What Changes

- 用本 CLI 自身有效认证投影账号登录或服务商 API 登录；配置声明不冒充认证。多服务商逐项表达，不随意取第一个。
- 设置账号行与侧栏使用相同的简短状态，保持单行。认证显示与模型权限判断独立。
- 核对当前原生 Hermes Nous OAuth、模型元数据和执行用凭据，贯通身份、目录、绑定与启动重检；不自动刷新或用其他 CLI 账号补齐。
- 通过模拟回归、隔离 UI 和真实自身状态只读核对验收；无活动任务时更新 Desktop，保留原账号和历史，本地提交不推送。默认不发起模型生成。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cli-connection-health`：自身 OAuth 与 API 认证按服务商显示登录方式，区分只有配置、缺失及失效。
- `cli-model-discovery`：支持 Hermes Nous 自身账号的已核实模型范围与原生能力交集，保留失败和取消边界。
- `cli-account-isolation`：Hermes Nous 目录与执行认证保持同一来源及账号版本，退出/换号使旧结果失效。

## Impact

影响共享账号状态的兼容可选显示字段、Client 账号行、Pi/OMP/OpenCode 原生账号投影、Hermes 身份/目录/账号绑定及测试。公开模型与偏好结构不变，不修改 Harness 核心、原生账号文件或用户 skill。已观察到 `hermes-accounts.ts` 仅识别 Codex/xAI 且仍返回 configured，`hermes-models.ts` 与 `cli-account-binding.ts` 缺少 Nous；后续契约以当前已安装原生源码为依据，不猜测服务接口。
