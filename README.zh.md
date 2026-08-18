# dsh-lmstudio-long-prefill（中文说明）

## 这个插件是干什么的

**一句话：让本地 LM Studio 跑长上下文、长生成（long-prefill / long-generation）时不再因 300 秒超时被掐断。**

DSH 默认用浏览器/Node 的 `fetch`（底层是 undici）去访问模型 API。undici 有一个
**300 秒的 `headersTimeout`**：如果模型在 300 秒内还没返回响应头，连接就被强制断开。
本地小模型（比如 3B~7B 级、在消费级 GPU 上跑）做**长 prefill**（输入很长、要把整个
context 先算一遍）或**长生成**（输出很长、要持续吐 token）时，经常超过 300 秒——于是
请求被掐断，DSH 报错，任务失败。

这个插件把 DSH 访问**本地 OpenAI 兼容端点**（LM Studio、vLLM、llama.cpp 等）时的
`getDefaultFetch` 换成走 **`node:http`** 的原生实现：`node:http` **没有 300 秒
headersTimeout**，连接可以一直等，直到模型真正返回。这样长 prefill / 长生成就不会被
超时掐断，能稳定跑完。

## 为什么它很重要（意义）

- **本地模型能用得起来**：没有这个 patch，本地慢模型在长任务上基本不可用（动辄 300 秒
  超时）。有了它，长上下文压缩、长文档处理、长生成才能稳定完成。
- **对远程/快模型无影响**：patch 只对**本地 OpenAI 路由**（`localhost` / `127.0.0.1` /
  `::1` 上的 `/v1/chat/completions` 等）生效；其它路由仍然走原来的 `fetch`，行为不变。
- **自动恢复，不怕升级覆盖**（关键特性）：这个 patch 写在 `node_modules/openai/` 里，
  而 `npm install` 重装 openai 包会把它**覆盖掉**。本插件在**每次 DSH 加载时都会自动
  重新应用** patch（幂等，已打过就跳过），所以即使将来 openai 包升级覆盖了 patch，
  下次启动 DSH 就会**自动补回**——你不需要手动重打。

## 它是怎么工作的（机制）

1. **定位**：插件加载时，从模块所在目录向上找 `node_modules/openai/internal/shims.{mjs,js}`
   （覆盖 profile 安装、npx 缓存等常见位置）。
2. **判断**：读文件，检查是否已打过 patch（用 `[dsh-lmstudio-long-prefill]` 标记 + 恰好
   1 个 `node:http` import 作为「健康」判据）。
   - 健康 → 跳过（幂等，不重复写）。
   - 没打过 / 被打坏（重复声明）→ 重建。
3. **重建**：把文件还原成「原始核心」（剥掉所有 patch 痕迹：helper 函数、node import、
   重复的 `getDefaultFetch`、孤儿函数体），再**恰好应用一次**我们的 `node:http` 版
   `getDefaultFetch`。这样无论是干净文件、已打补丁文件、还是被打坏的文件，重建后都是
   干净、可加载、幂等的。
4. **兜底**：同时给 `globalThis.fetch` 装一个本地路由回退（会话结束自动还原），双保险。

## 安装

官方 CLI（推荐）：

```bash
dsh plugin --profile <你的profile> add dsh-lmstudio-long-prefill
```

或手动：把 `dsh-lmstudio-long-prefill` 加进 profile 的 `dsh.profile.bundles` + 依赖，
`pnpm install`，重启 DSH。

## 验证

新开一个会话，跑一个**长 prefill**（比如给本地模型塞很长的上下文）或**长生成**任务，
确认不再出现 300 秒超时断开。也可以直接看：

```bash
node -e "import('openai/internal/shims.mjs').then(m=>console.log('patched:', m.getDefaultFetch!==globalThis.fetch))"
```

## 与压缩插件的配合

如果你同时用了 `dsh-compaction-tool`（把压缩 offload 到快的副模型），本插件保证那个
**副模型做长压缩时**（输入 = 整段历史，往往是长 prefill）不会因为 300 秒超时被掐断——
两者配合，本地慢模型 + 长任务才能稳定跑通。

## 注意

- 只对**本地 OpenAI 兼容端点**生效；远程 API（如 OpenAI 官方、Anthropic）行为完全不变。
- patch 是**幂等**的：重复加载不会重复写文件；被打坏的文件会被自动修复。
- 不修改 openai 包的其它任何导出；只替换 `getDefaultFetch` 一个函数的行为。
