# dsh-lmstudio-long-prefill

**修复本地 OpenAI 兼容 provider 的 5 分钟 undici `headersTimeout` 中断问题。**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 插件：让本地模型（LM Studio、vLLM、Ollama、llama.cpp 等）跑长上下文 Prefill 和长生成时不再因 300 秒超时被掐断。

> 🇬🇧 English docs: **[README.md](./README.md)**

---

## 问题

DSH 通过 OpenAI SDK → Node 内置 `fetch`（undici）访问模型 API。undici 有一个 **300 秒的 `headersTimeout`**：如果模型在 5 分钟内还没返回响应头，连接就被强制断开。

本地小模型（消费级 GPU 上的 3B–7B）做**长 prefill**（输入很长、要把整个 context 先算一遍）或**长生成**（输出很长、要持续吐 token）时经常超过 300 秒 → 请求被掐断 → DSH 报 `TRANSPORT / terminated`。

- OpenAI SDK 自带的 `timeoutMs` 是一个 `setTimeout`，**一旦收到响应头就被清除**——它**不能**覆盖 undici 内部的 `headersTimeout`。
- 加大 `maxRetries` 没用：失败是**确定性的**（每次都在恰好 5 分钟时死）。

## 解决方案

插件在**每次 DSH 加载时**都会**自动修复 SDK 补丁**：

1. **定位**运行时可达的所有 `openai/internal/shims.{mjs,js}`（profile `node_modules`、npx 缓存 DSH 安装、插件自身所在目录）。
2. **重新修补** `getDefaultFetch`，把本地 OpenAI 兼容请求路由到 **`node:http`**（无 headers/body 超时）。重写是**幂等**的——用标记注释做守卫，重复加载是空操作。
3. **安装 `globalThis.fetch` 兜底**（双保险），覆盖绕过 SDK shims 的请求路径。

因为补丁在每次加载时都会重新应用，即使 `npm install` 覆盖了 `openai` 包，**下次 DSH 启动就会自动补回**——无需手动操作。

### 为什么用 `node:http` 而不是 `undici.Agent`？

教科书方案是 `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`。但 Node 24 里 `undici` **不是可 require 的包**（内置但未导出）。所以我们替换 `getDefaultFetch()` 拿到的全局 `fetch`——对这条代码路径等效，零新依赖。

### 为什么用标准插件而不是动态插件？

**动态** Cordis 插件运行在受限沙箱里，没有 `require`、`http`、`fetch`、`globalThis` 的访问权限。**标准**插件是普通 ESM npm 包，有完整 Node 访问权限——它住在 profile 的 `node_modules` 里，DSH 升级也不会动它。

## 哪些路由受影响（哪些不受）

| 路由 | 行为 |
|------|------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http` — 无超时 |
| `http://localhost:8000/v1/responses` | ✅ `node:http` — 无超时 |
| `https://api.openai.com/v1/chat/completions` | ❌ 不动 — 走原来的 undici `fetch` |
| 任何非 OpenAI URL | ❌ 不动 — 直接透传 |

插件只拦截**本地** OpenAI 兼容端点（`127.0.0.1`、`localhost`、`::1`）。远程 API 完全不受影响。

## 安装

```bash
# 官方 CLI（推荐）
dsh plugin --profile <你的profile> add dsh-lmstudio-long-prefill@0.4.0

# 或手动
cd <profile目录>
npm install file:<路径>/dsh-lmstudio-long-prefill
```

然后**新开一个会话**（插件挂载在启动时读取）。

## 验证

1. 用之前 5 分钟超时的长上下文 prompt 重新测试。
2. 如果仍然失败，失败时间会在**更长的墙钟时间**（10–30+ 分钟）而不是恰好 5 分钟——确认 undici `headersTimeout` 是根因。
3. 检查补丁是否到位：
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## 与 dsh-compaction-tool 的配合

如果你同时用了 [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool)（把压缩 offload 到快速副模型），本插件保证副模型做**长压缩调用**时（输入 = 整段历史 = 长 prefill）不会因 300 秒超时被掐断。两个插件互补。

## 配置

无。路由分类由 URL 决定，没有可调参数。要改哪些路由走长超时，编辑 `lib/index.mjs` 里的 `OPENAI_PATHS` / `LOCAL_HOSTS` 集合。

## 卸载

```bash
cd <profile目录>
npm uninstall dsh-lmstudio-long-prefill
# 从 package.json 的 dsh.profile.bundles 里移除（如有）
```

然后重启 DSH。`node_modules/openai/` 里的文件补丁会保留（无害），但不再安装新的 fetch 包装器。

## 项目结构

```
dsh-lmstudio-long-prefill/
├── lib/index.mjs             # 插件源码（单文件，ESM）
├── cordis.patch.yml          # Bundle 挂载补丁
├── README.md / README.zh.md  # 本文件
└── LICENSE                   # MIT
```

## 许可证

[MIT](./LICENSE) © 2025
