# Proposal

## Why

实际会话中用户要求 Hermes，当前请求已带 cli=hermes 指引，但模型提交 cliworker_start 时只传 prompt/title。`src/host/index.ts` 的可选 cli 参数和 `args.cli ?? 'antigravity'` 将缺参静默转为 Antigravity，继而读取其设定并启动。历史设定按项目和 CLI 隔离，无串读证据。

## What Changes

- 将派遣工具 cli 参数设为必填，删除 Antigravity 默认值及省略说明。
- 同步入口指引，明确每次包括 Antigravity 都须传 cli，历史调用格式不能省略。
- 复现漏参路径及同对话已有 Antigravity、Hermes 两套设定的场景；只读历史兼容保持。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `worker-dispatch`: 新建派遣必须显式选择 CLI，不因参数缺失推断或回落。

## Impact

影响 Host 工具参数契约、路由说明和测试；Client、账号发现、模型能力及存量历史格式保持。旧调用漏参须由模型补正参数，不增加用户询问或自动切换。默认不进行模型生成。
