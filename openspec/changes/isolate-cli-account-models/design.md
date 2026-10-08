# Design

## Context

当前 Host 显式读取智谱引用；Pi/OMP桥接存在环境触发的合成provider，OpenCode直接展开父进程配置引用。Pi/OMP续聊优先旧worker凭据。前五CLI目录仍有缓存、静态别名和仅配置候选。用户已确认全部CLI自身登录/API可用，禁止跨账号复用。

## Goals / Non-Goals

- 全11CLI统一自身来源、账号权限与原生能力交集；展示/执行一致。
- 原生账号、会话历史和偏好保留；不改变主机平台或CLI协议，不执行付费生成探测。

## Decisions

- 旧zaiCredentialRef兼容解析但不解析其值；移除resolver调用、managed来源、合成CN模型和账号终端注入。
- 以Host内部readCliAccountBinding返回CLI+canonical来源+稳定principal/API摘要的匿名版本；OAuth正常续期不换身份。秘密和绑定不进入公开目录。
- 统一授权函数在目录前后比较绑定并核验精确模型/强度；运行时入队记录绑定，出队重新查目录，准备后复核绑定，再发送prompt。续聊比较历史绑定，旧无绑定任务重新核对当前自身来源。
- 只信自身账号文件/原生credential store和私有环境；引用其他CLI/通用环境拒绝。SDK认证初始化审查发现实际跨导入时关闭对应路径，无法证明范围时fail closed。
- 旧worker/catalog认证快照不作账号源；新快照按当前自身来源重建，原生用户登录文件保持。只删除确证派生覆盖，保留历史偏好并提示重选。
- ModelChoice/Preference保持兼容；Worker私有持久化可增可选账号绑定，公开快照剥离它。账号和模型错误采用短句，保持现有单行UI。

## Risks / Trade-offs

无法提供账号范围的CLI会返回空目录；不能为保持列表而恢复公共候选。旧快照正常刷新token只有来源仍在且同账号才允许复用；无法确认时要求本CLI重新登录。中断/清理仍使用宿主进程范围协议。

## Migration Plan

先模拟/离线与隔离preview，确认无活动任务后备份lib并更新Desktop。旧Host配置noop，清理范围仅插件派生目录；对原生账号及既有worker/偏好/开关/角色做哈希核验。正式构建、本地分阶段提交，不推送。

## Open Questions

无产品范围待决；各CLI可取得的原生账号范围须以安装源码/协议验证，不支持时采用空目录规则。
