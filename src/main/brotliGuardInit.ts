// 必须是主进程入口的第一个导入：在任何模块用到 zlib 之前替换掉有漏洞的 Brotli 解码器
import { installBrotliGuard } from './utils/brotliGuard'

installBrotliGuard()
