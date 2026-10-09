# package-distribution Specification

## Purpose

让 macOS 和 Windows 用户从默认中文 GitHub 首页或完整英文页面获取准确的安装与能力说明，并用固定版本的一条命令安装完整的预构建插件包，发布资产能够通过远端下载和校验核对。

## Requirements

### Requirement: 双语首页与单行安装
README.md SHALL 默认提供中文首页，完整英文页有双向语言切换。推荐安装代码块 MUST 只含一条可执行命令，无上下注释；命令使用相同跨平台 dsh plugin 语法和实际已发布的预构建资产。

#### Scenario: 打开仓库首页
- **WHEN** 用户打开 GitHub 默认分支首页
- **THEN** 默认显示中文，English 链接打开完整英文介绍，语言切换和图片路径有效

#### Scenario: 跨平台安装
- **WHEN** macOS 或 Windows 用户已配置 Desktop 的 dsh 命令并执行安装行
- **THEN** 安装该固定版本包到指定 profile，无需用户克隆或构建源码；web/desktop profile 含义准确

### Requirement: 发布证据与能力范围
Release SHALL 包含版本一致的完整预构建包和校验文件，远端下载 MUST 与本地包哈希一致，并验证独立 profile 的 URL 安装。能力说明 SHALL 区分平台运行层验证与第三方 CLI/模型实际调用，不能把 mock、安装成功或目录可读写作生成成功。

#### Scenario: 发布资产验证
- **WHEN** 新版 Release 上传并公开
- **THEN** 下载实际远端文件核对校验，确认 Host/Client/协议/辅助资产完整，不包含凭据或私有日志

#### Scenario: 第三方运行限制
- **WHEN** 某 CLI 在 Windows 没有可用原生安装或未获得调用授权
- **THEN** 保留对应依赖或未验证范围，不因插件可安装就声称该 CLI 和全部模型真实通过
