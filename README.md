# Moke

[![Release](https://img.shields.io/github/v/release/269289854/moke-miku)](https://github.com/269289854/moke-miku/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

把自己搭的 [Talebook](https://github.com/talebook/talebook) 书库装进口袋。Moke 连接你的 Talebook 服务器，在 Windows、Linux 电脑和 Android 手机上统一完成找书、下书和读书；网络不好甚至断网时，已经缓存或下载过的书照样能打开。

## 亮点

**找书**
- 按分类、标签、作者、出版社浏览整个书库，长列表滚动加载
- 按书名、作者、简介检索

**读书**
- 内置基于 Readest 的阅读器，EPUB、PDF 等常见格式开箱即读
- 在线阅读时自动缓存内容，再次打开不用重新下载
- 墨水屏模式：高对比度黑白界面，去掉阴影和半透明效果，适合电纸书设备

**离线与弱网**
- 书籍可以下载到本地，下载目录可以自定义，支持断点续传和失败自动重试
- 网络慢时先显示缓存内容，再在后台悄悄刷新
- 封面优先加载缩略图，按需懒加载
- 在设置里查看和清理阅读器缓存，不会影响已下载的书、笔记和阅读进度

**账号与连接**
- 支持 Talebook 的访问码、登录、注册
- “记住此设备”：用设备密钥免密登录，并可以在设置里随时吊销
- 兼容局域网里的纯 HTTP 地址和自签名证书

**更新**
- 桌面端内置自动更新，安装包签名校验通过后才会安装
- 移动端暂不支持应用内更新，可以在设置里一键复制下载页链接，到浏览器中下载新版

## 下载

前往 [Releases](https://github.com/269289854/moke-miku/releases/latest) 下载最新版本：

| 平台 | 文件 | 备注 |
|---|---|---|
| Windows 10 1809+ | `.exe` / `.msi` | 推荐 `.exe`，支持自动更新 |
| Linux（glibc 2.31+） | `.AppImage` / `.deb` / `.rpm` | `.AppImage` 支持自动更新 |
| Android 8+ | `moke-android-release.apk` | 每个版本签名一致，可直接覆盖安装 |

目前只支持以上三个平台，不提供 macOS、iOS 和鸿蒙版本。

## 三步开始

1. 打开 Moke，填入你的 Talebook 服务器地址，例如 `http://192.168.1.100:8080`
2. 按服务器要求输入访问码，或者登录账号
3. 在书库里挑一本书，在线读，或者下载后离线读

## 从源码构建

### 环境

- Node.js 20.9 或更高
- pnpm 9.15.9（项目已在 `package.json` 中锁定，可用 `corepack install --global pnpm@9.15.9` 安装）
- Rust stable 工具链
- 各平台的 Tauri 系统依赖，参见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)

### 拉取代码

阅读器和部分 Tauri 组件以 git 子模块的形式引入，克隆时需要一并拉取：

```bash
git clone --recursive https://github.com/269289854/moke-miku.git
cd moke-miku
pnpm install
cd readest && pnpm install && pnpm setup:vendors && cd ..
```

`pnpm setup:vendors` 会生成阅读器所需的 PDF.js、SimpleCC、Jieba 资源。之后每次更新子模块，都需要重新执行一次。

已经克隆过的仓库，拉取新代码后如果子模块地址或版本有变化，先同步子模块：

```bash
git submodule sync --recursive
git submodule update --init --recursive
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | 启动完整的桌面应用（首次需要编译 Rust，较慢） |
| `pnpm dev` | 只启动前端开发服务器（端口 3000） |
| `pnpm dev:reader` | 启动阅读器开发服务器（`http://localhost:3001/readest/reader`） |
| `pnpm tauri build` | 构建当前平台的安装包 |
| `pnpm test` | 运行测试 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm lint` | 代码检查 |

### 目录速览

```text
src/                 Next.js 前端：页面、组件、API 封装、状态管理
src-tauri/           Tauri 宿主（Rust），负责窗口、权限和原生能力
readest/             阅读器子模块，单独构建后打包进 /readest
vendor/              Tauri、wry 等依赖的定制版子模块
scripts/             构建与发布用的辅助脚本
tests/               Node 内置测试运行器的测试用例
.github/workflows/   多平台构建与发布流水线
```

### 阅读器的安全边界

书籍内容属于不可信输入，只能在 Foliate 的沙箱 iframe 里渲染，不能接触顶层的 Tauri IPC。阅读器的原生命令只授权给顶层阅读器界面；打开本地文件时，只为应用数据目录里的书或用户通过文件选择器选中的路径放开访问范围。修改阅读器命令、权限配置或升级 Foliate 时，请保持这些限制，并运行 `tests/reader-only-build.test.mjs`。

## 发布流程

推送 `v*` 格式的 tag 后，GitHub Actions 会构建全部平台、上传安装包，并生成桌面端自动更新所需的 `latest.json`。仓库需要先在 Secrets 中配置以下签名信息：

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 桌面端更新包签名 |
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` | Android APK 签名 |

普通的推送和 PR 在缺少签名信息时也能构建成功，只是会跳过签名；打 tag 发布时则必须配置齐全。

## 反馈

- 问题和建议：[GitHub Issues](https://github.com/269289854/moke-miku/issues)
- 安全漏洞：请通过[私密报告](https://github.com/269289854/moke-miku/security/advisories/new)提交，不要公开发布
- 参与开发：见 [CONTRIBUTING.md](CONTRIBUTING.md)

## 致谢

- [Talebook](https://github.com/talebook/talebook) 及其作者 Rex，Moke 的全部数据都来自 Talebook 服务器
- [talebook/moke](https://github.com/talebook/moke)：本项目在它的基础上修改而来
- [Readest](https://github.com/readest/readest) 与 [foliate-js](https://github.com/johnfactotum/foliate-js)：阅读器的基础
- [Tauri](https://tauri.app/)：跨平台应用框架

部分代码在 AI 编程工具的辅助下完成，均经过人工审查。

## 许可证

本项目以 [GPLv3](LICENSE) 协议开源。

作者：yizhimeng
