# OpenCode CLI：隔离验证

状态：2026-10-05 核心真实执行验证通过。用户最初选定 `opencode/mimo-v2.5-free`，原生 run 与 serve 首轮均被服务端拒绝；随后用户明确改选智谱 `zhipuai-coding-plan/glm-5.3-flash` 并授权复用指定凭据引用，首轮、原会话续聊、真实文件、流式取消和权限拒绝均通过。当前仍只做验证，不加入插件执行器列表、不更新 Desktop。

## 本机入口与能力

- 入口 `/opt/homebrew/bin/opencode`，实际二进制位于 `/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode.exe`。包版本与 `--version` 均为 **1.18.21**。
- `run` 支持 `--model provider/model`、`--format json`、`--session`、`--agent`、`--variant`、`--dir` 及 `--attach`。`--auto` 默认 false；不能因此推断所有工具都需要审批，实际规则须显式配置。
- `serve` 提供本机 HTTP、OpenAPI 3.1 与事件流接口；支持 `OPENCODE_SERVER_PASSWORD` Basic Auth。探针使用随机进程级密码、只绑定 `127.0.0.1`，密码不写入报告。
- 实测获取 `/global/health`、`/doc`、`/config/providers` 与 `/config`，通过 `POST /session` 创建并 `GET /session/:id` 取回空会话。未提交 prompt。
- 本版同时公开 `/session/...` 与 `/api/session/...` 路由。将来集成应固定已验收版本与接口，不根据在线文档混用不同代协议。

## 原生模型目录与账号边界

用户原生 `~/.local/share/opencode/auth.json` 不存在；用户配置未指定 Provider 或模型。免费模型验证时，探针仅保留基础环境变量，不继承其他 CLI 的密钥、Token 或 Base URL，隔离 `auth list` 报告 0 credentials。

离线 `models opencode` 与 `/config/providers` 的实际可选项一致：

| 完整模型 ID | 原生目录价格 | 原生 variants |
| --- | --- | --- |
| `opencode/big-pickle` | 输入、输出均 0 | 空 |
| `opencode/ling-3.0-flash-fin-free` | 输入、输出均 0 | low / medium / high |
| `opencode/mimo-v2.5-free` | 输入、输出均 0 | 空 |
| `opencode/muse-spark-1.2-contributor-free` | 输入、输出均 0 | minimal / low / medium / high / xhigh |
| `opencode/nemotron-3-ultra-free` | 输入、输出均 0 | 空 |
| `opencode/nemotron-3.5-lightning-free` | 输入、输出均 0 | 空 |

以上是本机版本在无联网条件下解析得到的目录，不是远端可用性或永久免费承诺。目录为空的 variants 不传强度参数。原生配置默认模型为 `big-pickle`，真实任务仍必须用用户明确选定的完整 ID。用户公共模型缓存中还出现过 `deepseek-v4-flash-free`，但原生可用目录未列出，因此不能用缓存项目冒充可用选项。

用户改选后的原生目录确认：`zhipuai-coding-plan/glm-5.3-flash`，API 为 `https://open.bigmodel.cn/api/coding/paas/v4`，SDK 为 `@ai-sdk/openai-compatible`，原生密钥环境变量为 `ZHIPU_API_KEY`，目录实际 variants 为 `low/high/max`。本轮未显式传强度，采用该模型原生默认；不能将目录包含某强度误写为已验证该强度请求。

凭据只在用户明确授权后读取 `~/.dsh/.credentials.yaml` 的 `refs.ZAI_CODING_CN_API_KEY`，内存映射到子进程 `ZHIPU_API_KEY`；不写原始凭据、不复制整个存储、不改原配置。配置 `enabled_providers=["zhipuai-coding-plan"]`，避免同名密钥环境变量启用其它地区或计费方式的 Provider。成功的两个运行目录共扫描 79 个文件，所用秘密值出现 0 次，目录/文件私有权限检查无异常。

## 探针与隔离

```sh
node scripts/probe-opencode.mjs
```

默认仅离线。用户明确选型后可用以下命令：

```sh
CLIWORKER_OPENCODE_MODEL=opencode/mimo-v2.5-free node scripts/probe-opencode.mjs --smoke
CLIWORKER_OPENCODE_MODEL=opencode/mimo-v2.5-free node scripts/probe-opencode.mjs --server-smoke
```

上面免费模型在本机验证失败，保留命令供复现；不作为推荐默认。已授权的智谱验证命令为：

```sh
CLIWORKER_OPENCODE_MODEL=zhipuai-coding-plan/glm-5.3-flash \
CLIWORKER_OPENCODE_CREDENTIAL_REF=ZAI_CODING_CN_API_KEY \
node scripts/probe-opencode.mjs --smoke

CLIWORKER_OPENCODE_MODEL=zhipuai-coding-plan/glm-5.3-flash \
CLIWORKER_OPENCODE_CREDENTIAL_REF=ZAI_CODING_CN_API_KEY \
node scripts/probe-opencode.mjs --lifecycle
```

`--smoke` 依次验证首轮、原会话续聊与实际文件；每步失败立即停止，不换型号。文件阶段仅放行 edit，其他工具继续 deny。`--server-smoke` 仅通过官方 CLI 的本机会话接口发送一条首轮消息，由 CLI 自行构造远端请求。`--lifecycle` 用原生 HTTP/SSE 验证实际文本增量后取消、edit 权限询问及拒绝，均检查进程组退出。单次报告只覆盖该模式，`completeLiveAcceptance=false` 不将三项或两项冒充五项；本次五项完整结论由下方两份互补真实证据共同支持。新任务的模型须显式选定且存在于实际原生目录中；不猜 reasoning variant、不自动登录。

每次创建 `.test-data/opencode-probe/run-*`，目录 0700、文件 0600，运行数据被 Git 忽略。

探针保持 `HOME` 不变，用独立 XDG 配置、数据、缓存、状态目录和数据库路径隔离 OpenCode；禁用项目配置、外部插件、Claude 配置和外部 Skills，禁用更新、模型抓取、分享、LSP 下载、格式化与文件监听。读取原生公共模型缓存不复制凭据；所有工具显式 deny。

macOS sandbox 拒绝目录外写入；默认禁止互联网，只放行本机回环和 Unix socket，显式真实模式才允许模型网络请求。所有进程使用参数数组启动；标准输出与错误共限 2 MiB，发现接口 HTTP 分块读取限 4 MiB，SSE 分块读取限 2 MiB，离线进程 25 秒、真实进程 120 秒超时，随后强制结束；退出后检查整个进程组无非僵尸成员。实测 macOS 重复组信号可能报 EPERM，探针仅对进程清单中仍属于该组的活成员逐一补发信号，最终仍须检查整组退出。

## 2026-10-05 验收记录

证据根目录为 `.test-data/opencode-probe/`，原始记录不提交。

| 项目 | 结果 |
| --- | --- |
| 版本、总帮助、run / serve / auth 帮助 | 通过，退出 0 |
| 隔离 auth list 与实际模型目录 | 通过，0 凭据与上述 6 项 |
| 测试目录可写、目录外哨兵拒写 | 通过，外部内容保持不变 |
| HTTP 健康、OpenAPI、模型目录、配置 | 通过，版本 1.18.21；配置确认 plugin=[]、mcp={}、permission.*=deny |
| 创建并取回空会话 | 通过，无 prompt |
| 未带 Basic Auth 的请求 | 返回 401 |
| 空闲 server 停止 | 收到 SIGTERM、进程组退出确认通过 |
| 原生 run 真实首轮 | 失败，JSON error / HTTP 403 FreeTierError，进程退出 1；`run-bEkaqq` |
| 原生 serve 真实首轮对照 | 失败，会话接口 HTTP 200，但响应 info.error 为相同 APIError / 403；`run-9PMg3f` |
| 用户改选智谱后首轮与原会话续聊 | 通过，marker 一致、至少一条实际 sessionID 且全相同，退出 0；`run-YJcBRn` |
| 实际文件产物 | 通过，write 工具 completed、proof.json 字段吻合并计算 SHA-256；同上 |
| 流式输出中取消 | 通过，真实 message.part.delta / field=text 后 SIGTERM，进程组无活成员；`run-lx3KJR` |
| 原生 Write 权限拒绝 | 通过，permission.asked → permission.replied(reject)，write 状态 error，forbidden.json 不存在；同上 |

离线完整通过记录：`run-DTOMnY/report.json`，最终修订后的默认离线复测为 `run-aVHZTx/report.json`。较早 `run-Zzx8rZ` 在读取包含全部 Provider 的 `/provider` 时超过 4 MiB 上限，探针正确失败并清理进程；后续改用较小的 `/config/providers`，并改为分块有界读取。未扩大数据上限或关闭输出限制。生命周期早期 `run-jZcf2V`、`run-3AUwtR` 因重复组信号竞态失败，不冒充成功记录；修复后 `run-lx3KJR` 完整通过。

另存脱敏汇总 `.test-data/opencode-probe/acceptance.json`：重新解析上述成功记录和实际文件，确认三轮最终 step_finish.reason=stop、取消发生在第一个正文增量且没有最终 step-finish、拒绝与询问使用同一个 requestID。只读核查两个原生数据库中的 7 条 assistant message，Provider/model 全部为 `zhipuai-coding-plan/glm-5.3-flash`。CLI 二进制 SHA-256 为 `8c783005340f8dfc5e7d168478dd0dd2bd1faead531cb34270de2a9689d9f135`。

真实服务端错误为 `OpenCode's free tier can only be used from within OpenCode`。两次都执行本机未修改的官方 CLI，未直接请求 Zen 模型 API、伪造客户端头或更换模型。二进制核心模型请求代码原本就包含 OpenCode 自有会话与客户端头，未发现禁用默认插件会删除这些头的证据；尚不能根据该错误确定远端拒绝的具体判定条件，也不能推断所有 OpenCode 模型或所有权限配置都不可用。保留为当前版本、所选免费模型与隔离配置下的明确阻塞。服务端会话接口 HTTP 200 或空闲进程正常退出，不等于模型任务成功。

源码经 `node --check` 与本地 Prettier 验证；未运行插件构建、应用测试或正式安装。接入前仍须权限与宿主审批映射、目录与会话锁、包含真实后代进程的停止场景、预览包和 UI 验收；当前取消任务未执行 shell，不能当作多层后代进程终止测试。

## 统一接入的精确接口

1. 无头首轮使用参数数组 `['run','--format','json','--model',provider+'/'+model,'--agent','build','--title',title,prompt]`，工作目录由 spawn 的 `cwd` 指定。续聊增加 `['--session',nativeSessionID]`，不得用 `--continue` 猜最后会话。强度可用 `--variant`，取值只从本版实际目录的 `model.variants` 读取。
2. CLI JSON 事件包含 `type`、`timestamp`、`sessionID`、`part`。文本为 `type=text, part.text`；完成步骤为 `type=step_finish, part.reason`。`reason=tool-calls` 是中间步骤，最后的 `reason=stop`、退出 0、没有 error 和失败工具结果才支持完成。`tool_use` 的 `part.state.status` 区分 completed/error。顶层 `error` 包含 APIError；免费模型两次拒绝均有可核查错误，不回退模型。
3. `run --format json` 本轮观察到结束后的 text 块。需要逐 token 实时过程或人工审批时，使用独立 `serve`、随机 Basic Auth、回环地址与 `/event` SSE。真实文本增量为 `message.part.delta`，读取 `properties.sessionID/partID/field/delta`，只在 field=text 时作正文增量。
4. `/config/providers` 返回实际已配置目录：`providers[].id/models` 与 `default`；从 `models[modelID].variants`、`capabilities`、`api` 提取原生能力，不把默认模型当用户选择。接口返回可能带 Provider options，不能未经脱敏写盘或投影给 Client。
5. 权限询问为 `permission.asked`，其 `properties.id` 是原生 requestID；拒绝请求为 `POST /permission/:requestID/reply`，JSON `{reply:'reject',message:...}`。随后核查 `permission.replied.reply=reject`、工具 state.error 与实际文件。模型可继续输出解释并进入 idle，不能把 idle 当作文件任务成功。
6. 会话 API 的 HTTP 200 也可能带 `info.error`；必须检查模型响应体。`POST /session` 返回真实 `id`；`POST /session/:id/prompt_async` 接受 `{model:{providerID,modelID},agent,parts:[{type:'text',text}]}`。本轮停止采用终止专属 server 进程组；`/session/:id/abort` 只确认目录存在，尚未独立验收其取消完成语义。
7. 最小隔离基础是独立 `XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME`、`OPENCODE_DB`、`OPENCODE_CONFIG`，禁用项目配置、外部插件/Skills、自动更新/模型刷新/分享，并显式配置 permission 和 allowed Provider。`model` 与 `small_model` 均固定为选择，title 显式给出，避免辅助步骤换模型。生产需要保留宿主锁和进程管理，不能直接把测试目录作为正式数据路径。
8. 本机没有可复用的 OpenCode 原生已登录账号，未验收其 OAuth 登录/刷新。已验证的复用仅限用户明确授权的一项 Harness 密钥引用经原生 `ZHIPU_API_KEY` 注入；不得据此自动导入其它账号、全部凭据或把 OpenCode 与 ZCode 登录态等同。

官方参考：[CLI](https://opencode.ai/docs/cli/)、[配置及优先级](https://opencode.ai/docs/config/)、[Server](https://dev.opencode.ai/docs/server/)、[权限](https://opencode.ai/docs/permissions/)。以上本机行为以保存的帮助、OpenAPI 和实际输出为准。
