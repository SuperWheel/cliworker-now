# Design

## Context

rc.2 plugin CLI要求显式profile；规格转交pnpm支持registry/git/tarball。当前根private:true、无prepare、lib不跟踪，Git源码简写无法获得运行入口。此前0.7.6包、1307测试及Desktop验收已完成，本次只改变分发元数据和说明。

## Goals / Non-Goals

使已验证预构建包可用短包名安装；不改运行源码、不重建正在链接Desktop的lib、不引入用户侧构建或新权限。

## Decisions

- 根开发manifest保留private:true，独立dist/npm/dsh-cliworker-now公开目录拷贝lib及allowlist。公开manifestprivate:false并补官方registry/repository信息；移除scripts、devDependencies及packageManager，保留运行依赖、SDK peer、exports、files和dsh声明。
- 发布脚本只处理已构建产物，验证公开JS运行入口/14动态辅助文件的可达依赖和.d.ts声明路径；完整拷贝但不把非公开tsc附带JS当第二入口，拒绝符号链接及私有路径；不执行模型/账号/运行进程。npm pack生成唯一公开tarball，同一字节上传registry和GitHubRelease。
- 推荐固定dsh-cliworker-now@0.7.6，保留--profile desktop，web放折叠段。不能省必填profile或以未生成lib的github源码代替预构建。固定版本也避免裸latest被新版本等待策略选到旧包。
- 用户自行完成npm网页登录。发布前dry-run核对清单/哈希；实际发布后读取registry版号与integrity并下载，再使用独立HOME/DSH_HOME/profile安装，核对插件注册与lib，默认不生成。

## Risks / Trade-offs

- 首次npm发布可能要求2FA → 保留准确待办并由用户完成官方验证，不输出令牌。
- 发布版本不可覆盖 → 先查询是否存在，未知结果先读取registry，不盲目重试。
- 打包遗漏动态辅助文件 → 实际tar成员/import目标核对与干净profile安装；不能以源码push或dry-run替代发布证据。
- 同版本运行行为已验但分发manifest不同 → 明确记录公开包新哈希及运行文件与原0.7.6相同；源码与Desktop数据不变。

## Migration Plan

已有18提交正常快进push到main；完成分发代码与检查后本地提交并push，发布npm及v0.7.6 Release。两种远端字节一致并验证短安装后才把README推荐改为registry命令，同步规格与归档并push记录。旧URL与原本机链接安装保持，不重写已发布registry版本。
