# dsh-local-model-long-prefill

**修复本地 OpenAI 兼容 provider 的三层超时：undici `headersTimeout` 中断、OpenAI SDK per-request timeout（默认 600 s → "Request timed out."，恰好 +10 分钟）、pi-ai 流空闲看门狗。**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 插件：让本地模型（LM Studio、vLLM、Ollama、llama.cpp 等）跑长上下文 Prefill 和长生成时，不再被 300 秒超时或恰好 +600 s 的 "Request timed out." 掐断。

> 🇬🇧 English docs: **[README.md](./README.md)**

---

## 问题

三层独立的超时机制会在长 prefill 期间掐断本地模型的请求——哪个截止期最小，就先触发哪一个：

1. **undici `headersTimeout`**（300 s）— DSH 通过 OpenAI SDK → Node 内置 `fetch`（undici）访问模型 API。undici 有一个 **300 秒的 `headersTimeout`**：如果响应头在 5 分钟内没到，连接就被强制断开（`terminated`）。

2. **OpenAI client per-request timeout**（默认 **600 s**）— 即使修好了第 1 层，每个请求仍然会在恰好 **+600 秒**时死掉。OpenAI SDK 的 `timeout` option 默认为 `DEFAULT_TIMEOUT = 600_000 ms`：它给每次 fetch 套一个 abort signal，本地模型在 **10 分钟**内没返回响应头就抛 "Request timed out."（`APIConnectionTimeoutError`）——不管 prefill 合法地需要多久。会话日志里这个特征非常清楚：每个 attempt 都恰好 +600 s 失败、约 470 ms 后重试（一个会话里出现 25+ 次完全相同的失败）。

3. **pi-ai 流空闲看门狗**（默认 **300 000 ms**）— `@deepseek-ai/dsh-llm-pi-ai` 适配器用 `idleWatchdog` 包裹每个流，窗口内没有 token 到达就报：
   ```
   pi-ai stream idle timeout after 300000ms
   ```

本地小模型（消费级 GPU 上的 3B–7B）做**长 prefill**（输入很长、要把整个 context 先算一遍）或**长生成**（输出很长、要持续吐 token）时经常超过这三个窗口 → 请求被掐断。只修一层只会把失败点挪到下一个更小的截止期——这正是 v1.0 修好 undici 之后发生的事：请求从 +300 s 改在 +600 s 死掉（"Request timed out."）。

## 解决方案

插件在**每次 DSH 加载时**：

1. **自动修复 SDK 补丁** — 定位所有 `openai/internal/shims.{mjs,js}`，把 `getDefaultFetch` 重写为走 **`node:http`**（无 headers/body 超时）。幂等——标记注释做守卫，重复加载是空操作。

2. **自动重写 `settings.yaml`** — 对 `llm-pi-ai.providers` 下每个 `baseURL` 指向本地/局域网地址（`127.0.0.1`、`localhost`、`10.x`、`172.16–31.x`、`192.168.x`）的 provider，把**两个**超时字段都设为共享预算 **7 200 000 ms（2 小时）**：
   - `timeoutMs` — dsh-llm-pi-ai 会在每次请求上把它作为 `{ timeout }` 转发，覆盖 OpenAI SDK 的默认 600 s（`DEFAULT_TIMEOUT`）。没有这个字段时，上面第 2 层无论怎样都会在恰好 +10 分钟触发。
   - `streamIdleTimeoutMs` — 抬高 pi-ai 空闲看门狗（第 3 层）。看门狗每收到一个 chunk 就重新计时，所以大值不会掩盖仍在推进的流；它只约束完全静默的请求（挂死的本地服务器会在 ~2 小时内失败，而不是永远不失败或死在某个随意的 SDK 截止期上）。

   幂等且**只升不降**——任一字段已有 ≥ 目标值的设置时保留你的更高值。首次重写前自动备份为 `settings.yaml.bak`；其余所有 key 逐字节保留（测试中用真实 `yaml` round-trip 验证过）。

3. **安装 `globalThis.fetch` 兜底**（双保险），覆盖绕过 SDK shims 的请求路径。

因为所有补丁在每次加载时都会重新应用，即使 `npm install` 覆盖了 `openai` 包，**下次 DSH 启动就会自动补回**——无需手动操作。

### 为什么用 `node:http` 而不是 `undici.Agent`？

教科书方案是 `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`。但 Node 24 里 `undici` **不是可 require 的包**（内置但未导出）。所以我们替换 `getDefaultFetch()` 拿到的全局 `fetch`——对这条代码路径等效，零新依赖。

### 为什么要自动重写 settings.yaml？

上面三层里有两层是按 provider 配置在 `~/.dsh/settings.yaml`（`timeoutMs`、`streamIdleTimeoutMs`）里的——哪个设得小就先触发，所以**两个必须一起抬高**。以前用户需要手动编辑每个本地 provider；现在插件每次加载时自动完成（只升不降：你的更高值会被保留），你再也不需要记着这一步。

## 哪些路由受影响（哪些不受）

| 路由 | 行为 |
|------|------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http`，两个超时 = 2 小时预算 |
| `http://192.168.0.110:1234/v1/responses` | ✅ `node:http`，两个超时 = 2 小时预算 |
| `http://localhost:8000/v1/completions` | ✅ `node:http`，两个超时 = 2 小时预算 |
| `https://api.openai.com/v1/chat/completions` | ❌ 不动 — 走原来的 undici `fetch`，默认看门狗 |
| 任何非 OpenAI URL | ❌ 不动 — 直接透传 |

插件只拦截**本地/局域网** OpenAI 兼容端点。远程 API 完全不受影响。

## 安装

```bash
# 官方 CLI（推荐）
dsh plugin --profile <你的profile> add dsh-local-model-long-prefill@latest

# 或手动
cd <profile目录>
npm install file:<路径>/dsh-local-model-long-prefill
```

然后**新开一个会话**（插件挂载在启动时读取）。

## 验证

1. 检查 `~/.dsh/settings.yaml` — 每个本地 provider 应该都有**两个**字段且 ≥ 7200000 ms（例如端口 1234 的 LM Studio）：
   ```yaml
   providers:
     lmstudio:
       baseURL: http://localhost:1234/v1
       timeoutMs: 7200000            # OpenAI SDK per-request 预算（原来默认只有 600 s）
       streamIdleTimeoutMs: 7200000   # pi-ai 空闲看门狗（原来是 300 s）
   ```
2. 用之前恰好 +10 分钟报 "Request timed out." 的长上下文 prompt 重新测试——现在应该能跑完，而不是死在某个固定截止期上；如果还有失败，那是真实的模型/服务器问题，不是这几层超时。
3. 检查补丁是否到位：
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## 与 dsh-compaction-tool 的配合

如果你同时用了 [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool)（把压缩 offload 到快速副模型），本插件保证副模型做**长压缩调用**时（输入 = 整段历史 = 长 prefill）不会因这三层超时中的任何一层被掐断。两个插件互补。

## 配置

两个受管字段（`timeoutMs`、`streamIdleTimeoutMs`）的共享超时预算目标值是 **7 200 000 ms**（2 小时），在 `lib/index.mjs` 的常量 `DEFAULT_LOCAL_TIMEOUT_MS` 中定义；字段清单见 `MANAGED_PROVIDER_FIELDS`。要改的话，编辑那个常量即可。重写只升不降——已有 ≥ 目标值的设置会原样保留。路由分类由 URL 决定，本地/局域网主机集由 `LOCAL_HOSTS` + `isLocalOrLanHost()` 定义。

## 卸载

```bash
cd <profile目录>
npm uninstall dsh-local-model-long-prefill
# 从 package.json 的 dsh.profile.bundles 里移除（如有）
```

然后重启 DSH。`node_modules/openai/` 里的文件补丁和 `settings.yaml` 的修改会保留（无害——它们就是期望的最终状态），但不再安装新的 fetch 包装器，也不再自动重写 settings。

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
