# dsh-local-model-long-prefill

**修复本地 OpenAI 兼容 provider 的 5 分钟 undici `headersTimeout` 中断 + pi-ai 流空闲看门狗超时问题。**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 插件：让本地模型（LM Studio、vLLM、Ollama、llama.cpp 等）跑长上下文 Prefill 和长生成时不再因 300 秒超时被掐断。

> 🇬🇧 English docs: **[README.md](./README.md)**

---

## 问题

两层独立的超时机制会在 ~300 秒时掐断本地模型的请求：

1. **undici `headersTimeout`** — DSH 通过 OpenAI SDK → Node 内置 `fetch`（undici）访问模型 API。undici 有一个 **300 秒的 `headersTimeout`**：如果模型在 5 分钟内还没返回响应头，连接就被强制断开。

2. **pi-ai 流空闲看门狗** — `@deepseek-ai/dsh-llm-pi-ai` 适配器用 `idleWatchdog` 包裹每个流，`streamIdleTimeoutMs` 默认 **300000 ms**。本地模型在长 prefill 期间如果 token 产出太慢，看门狗就会报：
   ```
   pi-ai stream idle timeout after 300000ms
   ```

本地小模型（消费级 GPU 上的 3B–7B）做**长 prefill**（输入很长、要把整个 context 先算一遍）或**长生成**（输出很长、要持续吐 token）时经常超过 300 秒 → 请求被掐断 → DSH 报 `TRANSPORT / terminated`。

## 解决方案

插件在**每次 DSH 加载时**：

1. **自动修复 SDK 补丁** — 定位所有 `openai/internal/shims.{mjs,js}`，把 `getDefaultFetch` 重写为走 **`node:http`**（无 headers/body 超时）。幂等——标记注释做守卫，重复加载是空操作。

2. **自动重写 `settings.yaml`** — 对 `llm-pi-ai.providers` 下每个 `baseURL` 指向本地/局域网地址（`127.0.0.1`、`localhost`、`10.x`、`172.16–31.x`、`192.168.x`）的 provider，设置 `streamIdleTimeoutMs` 为 **1800000**（30 分钟）。幂等——如果值已经 ≥ 目标值则不写。首次重写前自动备份为 `settings.yaml.bak`。

3. **安装 `globalThis.fetch` 兜底**（双保险），覆盖绕过 SDK shims 的请求路径。

因为所有补丁在每次加载时都会重新应用，即使 `npm install` 覆盖了 `openai` 包，**下次 DSH 启动就会自动补回**——无需手动操作。

### 为什么用 `node:http` 而不是 `undici.Agent`？

教科书方案是 `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`。但 Node 24 里 `undici` **不是可 require 的包**（内置但未导出）。所以我们替换 `getDefaultFetch()` 拿到的全局 `fetch`——对这条代码路径等效，零新依赖。

### 为什么要自动重写 settings.yaml？

pi-ai 流空闲看门狗（`streamIdleTimeoutMs`）默认 300000 ms。以前用户需要手动编辑 `~/.dsh/settings.yaml`，给每个本地 provider 加上 `streamIdleTimeoutMs: 1800000`。现在插件每次加载时自动完成，你再也不需要记着这一步。

## 哪些路由受影响（哪些不受）

| 路由 | 行为 |
|------|------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http` + 30 分钟看门狗 |
| `http://192.168.0.110:1234/v1/responses` | ✅ `node:http` + 30 分钟看门狗 |
| `http://localhost:8000/v1/completions` | ✅ `node:http` + 30 分钟看门狗 |
| `https://api.openai.com/v1/chat/completions` | ❌ 不动 — 走原来的 undici `fetch`，默认看门狗 |
| 任何非 OpenAI URL | ❌ 不动 — 直接透传 |

插件只拦截**本地/局域网** OpenAI 兼容端点。远程 API 完全不受影响。

## 安装

```bash
# 官方 CLI（推荐）
dsh plugin --profile <你的profile> add dsh-local-model-long-prefill@1.0.0

# 或手动
cd <profile目录>
npm install file:<路径>/dsh-local-model-long-prefill
```

然后**新开一个会话**（插件挂载在启动时读取）。

## 验证

1. 检查 `~/.dsh/settings.yaml` — 每个本地 provider 应该都有 `streamIdleTimeoutMs: 1800000`。
2. 用之前 5 分钟超时的长上下文 prompt 重新测试。
3. 如果仍然失败，失败时间会在**更长的墙钟时间**（10–30+ 分钟）而不是恰好 5 分钟——确认 undici `headersTimeout` 是根因。
4. 检查补丁是否到位：
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## 与 dsh-compaction-tool 的配合

如果你同时用了 [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool)（把压缩 offload 到快速副模型），本插件保证副模型做**长压缩调用**时（输入 = 整段历史 = 长 prefill）不会因 300 秒超时被掐断。两个插件互补。

## 配置

默认 `streamIdleTimeoutMs` 目标值是 **1800000**（30 分钟），在 `lib/index.mjs` 的 `DEFAULT_STREAM_IDLE_TIMEOUT_MS` 常量中定义。要改的话，编辑那个常量即可。路由分类由 URL 决定，本地/局域网主机集由 `LOCAL_HOSTS` + `isLocalOrLanHost()` 定义。

## 卸载

```bash
cd <profile目录>
npm uninstall dsh-local-model-long-prefill
# 从 package.json 的 dsh.profile.bundles 里移除（如有）
```

然后重启 DSH。`node_modules/openai/` 里的文件补丁和 `settings.yaml` 的修改会保留（无害——它们就是期望的最终状态），但不再安装新的 fetch 包装器，也不再自动重写 settings。

## 从 dsh-local-model-long-prefill 迁移

本插件**替代** `dsh-local-model-long-prefill`。迁移步骤：

1. 卸载旧插件：`npm uninstall dsh-local-model-long-prefill`
2. 从 `package.json` 的 `dsh.profile.bundles` 里移除 `"dsh-local-model-long-prefill"`
3. 安装新插件：`npm install dsh-local-model-long-prefill`
4. 把 `"dsh-local-model-long-prefill"` 加到 `dsh.profile.bundles`
5. 重启 DSH

SDK shims 补丁兼容——新插件能识别并修复旧插件名修补过的文件。

## 项目结构

```
dsh-local-model-long-prefill/
├── lib/index.mjs             # 插件源码（单文件，ESM）
├── cordis.patch.yml          # Bundle 挂载补丁
├── README.md / README.zh.md  # 本文件
└── LICENSE                   # MIT
```

## 许可证

[MIT](./LICENSE) © 2025
