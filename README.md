<p align="center">
  <img width="128" src="./images/logo.png" alt="Clash Caesar">
</p>

<h1 align="center">Clash Caesar</h1>

<p align="center">基于 <a href="https://github.com/MetaCubeX/mihomo">Mihomo</a> 内核的 Windows 代理客户端</p>

<p align="center">
  <a href="https://github.com/RomanovCaesar/clash-caesar/releases">
    <img src="https://img.shields.io/github/v/release/RomanovCaesar/clash-caesar?include_prereleases&label=release" alt="Release">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/github/license/RomanovCaesar/clash-caesar" alt="License">
  </a>
  <a href="https://t.me/ClashCaesar">
    <img src="https://img.shields.io/badge/Telegram-Channel-blue?logo=telegram" alt="Telegram Channel">
  </a>
</p>

## 简介

Clash Caesar 是一个开源的 Mihomo（Clash Meta）图形客户端，基于 [Clash Party](https://github.com/mihomo-party-org/mihomo-party) 2.0.3 二次开发，目前专注于 Windows 平台。

## 特性

- 稳定版、预览版、特定版本三种 Mihomo 内核可选，支持在应用内一键升级内核
- 开箱即用的虚拟网卡（TUN）模式，无需安装服务
- 系统代理、TUN、DNS 覆写、嗅探覆写一键切换，托盘图标实时显示代理状态
- 支持大部分 Mihomo 常用配置的图形化修改
- 订阅模版：把订阅的分组和分流规则换成统一的一套，节点保持不变，订阅文件本身不会被修改；内置与 [m-ui](https://github.com/RomanovCaesar/m-ui) 相同的模版（中国大陆 / 俄罗斯 / 伊朗），也可导入自己的模版或从现有订阅生成
- 深度集成 Sub-Store，轻松管理订阅
- 订阅按 WiFi 网络自动切换
- 连接管理、流量统计与悬浮窗
- 通过 WebDAV 或本地文件备份、恢复配置，支持将运行配置同步到 GitHub Gist

## 下载安装

前往 [Releases](https://github.com/RomanovCaesar/clash-caesar/releases) 下载最新版本：

| 文件                                          | 说明                       |
| --------------------------------------------- | -------------------------- |
| `clash-caesar-windows-<版本>-x64-setup.exe`   | 安装版（推荐）             |
| `clash-caesar-windows-<版本>-x64-portable.7z` | 便携版，数据保存在程序目录 |

系统要求：Windows 10 / 11（x64）。

> macOS 与 Linux 版本暂未提供。

## 从源码构建

需要 [Node.js](https://nodejs.org) 24 或更高版本。项目使用 pnpm，可通过 Corepack 启用：

```bash
corepack enable
pnpm install        # 安装依赖，并下载内核、GeoIP 数据等运行时文件
pnpm dev            # 开发模式运行
pnpm build:win      # 构建 Windows 安装包，输出到 dist/
```

提交代码前请确保以下检查全部通过：

```bash
pnpm run format:check && pnpm run lint:check && pnpm run typecheck && pnpm test
```

## 与 Clash Party 的主要区别

- 内核升级改由客户端下载并替换，修复了「升级成功却提示失败」以及左右两侧版本号显示不一致的问题
- 用订阅模版取代了 YAML / JavaScript 覆写
- 移除了 Smart 内核、GitHub 下载加速镜像和在线主题库
- 独立的应用标识与数据目录（`%APPDATA%\clash-caesar`），可与 Clash Party 同时安装
- 订阅请求默认 User-Agent 为 `clash.caesar/v<版本> (clash.meta)`

## 反馈与交流

- 问题反馈：[GitHub Issues](https://github.com/RomanovCaesar/clash-caesar/issues)
- 最新动态：[Telegram 频道](https://t.me/ClashCaesar)

## 致谢

- [Mihomo](https://github.com/MetaCubeX/mihomo)：代理内核
- [Clash Party](https://github.com/mihomo-party-org/mihomo-party)：本项目的上游
- [Sub-Store](https://github.com/sub-store-org/Sub-Store)：订阅管理

## 许可证

本项目基于 [GPL-3.0](./LICENSE) 许可证开源。
