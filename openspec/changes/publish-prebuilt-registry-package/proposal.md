# Proposal

## Why

当前首页一行安装使用长Release资产URL且仍锁v0.6.15；源码已有18个v0.7.6相关提交。参考项目通过预构建npm包名安装缩短命令，本插件尚未注册npm包且private标记阻止发布。

## What Changes

- 保持现有包名dsh-cliworker-now，预构建npm发行包可公开发布，安装不在用户侧构建源码。
- 首页推荐固定版本短命令，保留desktop/web profile准确含义及GitHub Release备用资产。
- 核对发布包完整性、npm远端哈希与独立profile实际安装；上传完成代码至GitHub主分支并发布对应Release及校验文件。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `package-distribution`：预构建npm来源、简短固定版本推荐安装以及registry/GitHub发布证据。

## Impact

只修改发布manifest/脚本、README及发布记录，不改Host/Client运行行为或Desktop原账号/数据。用户明确授权GitHub上传与npm公开发布，账户登录由用户完成。源码开发的private标记可保留，公开发布目录使用经过检查的manifest；不引入用户侧prepare脚本或扩大构建授权。
