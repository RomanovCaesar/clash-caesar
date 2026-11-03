# 1.0.5

## 更新

- Electron 升级到 45.2.1（Node 24.22.1、Chromium 156），包含上游的安全修复
- 内置 Node 已修复 Brotli 解压漏洞（CVE-2026-111497），1.0.3 加入的替代解压方案会自动停用，改回原生实现

## 安全修复

- 订阅下载用的 follow-redirects 升级到 1.16.2，修复跨站重定向时可能泄露访问凭据的新问题
- Sub-Store 本地服务的依赖 body-parser、qs 升级到已修复版本
