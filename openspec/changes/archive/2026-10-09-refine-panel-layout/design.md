# Design

## Context

动机见 proposal。当前 overview 的 overflow 包含搜索和筛选，NameCopy 图标隐藏仍占宽度；原生 Input 外壳为 inline-flex 导致输入只有默认宽度，Modal 通用 body 留白和空错误块共同增高弹窗。

## Goals / Non-Goals

以客户端结构解决滚动、对齐及反馈时机。保持 Gateway 管理操作、自己的账号验证、同会话约束、草稿保留和事件历史，不改Host协议或原生CLI执行。

## Decisions

- 搜索和筛选独立为不可缩控件区，卡片区单独flex滚动；直接移动overview ref及滚动恢复逻辑，避免sticky与父级overflow互相影响。
- 已删除通过原生Trash图标及主题error色淡底按钮切换，保留四筛选和query。不使用额外一行文字导航。
- 名称按钮只有文字，仍有主题hover/focus反馈；成功状态由离开/失焦控制约1s定时，异步复制、再次进入、名称变更和卸载均核对当前实例并清理。失败不误报成功。
- RenameWorker为两种编辑模式共用布局，Input外壳宽100%，缩紧原生Modal body间距，错误存在时才渲染错误块，不改共享Modal全局样式。
- 历史提示条在标题下面、消息滚动区外，包含必要单行文案和轻量新建/取消动作；新建提交仍经过原Host准入流程。
- 空页参考本地 Harness 原生空页的文字层级，用两行温和文案，不添加外部依赖或图片。

## Risks / Trade-offs

- 窄侧栏可能挤压垃圾桶 → 四筛选等宽可缩，垃圾桶固定宽，验收窄/宽视口。
- 指针点击后按钮仍聚焦可能延迟恢复 → 鼠标与键盘状态独立，鼠标leave约1s生效；键盘使用blur，验证重复进入及慢复制。
- DOM布局可影响滚动保存 → 唯一卡片滚动节点保留ref及回页恢复，真实原生UI用长列表核查。

## Migration Plan

无需用户数据迁移。先隔离preview及界面模拟，再确认Desktop空闲后更新v0.7.3并核对账号/历史；回退可使用v0.7.2构建包，运行数据不变。
