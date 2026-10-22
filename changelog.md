# 1.0.3

安全更新，建议所有用户升级。

## 安全修复

- 内置 Mihomo 内核升级到 v1.19.33（Go 1.26.10 编译），修复 Go `crypto/tls` 的 ECH 内存耗尽漏洞（CVE-2026-97031），并包含 Go 10 月的 `crypto/x509` 证书吊销更新
- 应对 Node.js 的 Brotli 解码器远程代码执行漏洞（CVE-2026-111497）：在内置 Node.js 修复之前，软件和 Sub-Store 解压 Brotli 数据时改用 Google 官方的纯 JavaScript 解码器，恶意或被劫持的订阅服务器无法再利用这个漏洞；内置 Node.js 修复后自动换回原生实现
- Electron 升级到 45.0.0（Chromium 150、Node.js 24.22.0），包含上游的安全修复
