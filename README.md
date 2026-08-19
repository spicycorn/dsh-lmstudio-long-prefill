# dsh-local-model-long-prefill

**Fix the 5-minute undici `headersTimeout` abort AND the pi-ai stream idle watchdog for local OpenAI-compatible providers.**

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) plugin that makes long-context Prefill and long generation work reliably with local models (LM Studio, vLLM, Ollama, llama.cpp, etc.) — no more `terminated` error at exactly 300 seconds.

> 🇨🇳 中文文档见 **[README.zh.md](./README.zh.md)**

---

## Problem

Two independent timeout layers kill local model requests at ~300 seconds:

1. **undici `headersTimeout`** — DSH routes model API calls through the OpenAI SDK → Node's built-in `fetch` (undici). undici has a **300-second `headersTimeout`**: if the model hasn't returned response headers within 5 minutes, the connection is forcibly aborted.

2. **pi-ai stream idle watchdog** — the `@deepseek-ai/dsh-llm-pi-ai` adapter wraps every stream in an `idleWatchdog` with a `streamIdleTimeoutMs` (default **300000 ms**). If the local model is slow to emit tokens during a long prefill, the watchdog aborts with:
   ```
   pi-ai stream idle timeout after 300000ms
   ```

Local small models (3B–7B on consumer GPUs) doing a **long prefill** (long input, full context pass) or **long generation** (many output tokens) routinely exceed 300 seconds → request dies → DSH reports `TRANSPORT / terminated`.

## Solution

On **every DSH load**, the plugin:

1. **Self-heals the OpenAI SDK patch** — locates every `openai/internal/shims.{mjs,js}` and re-patches `getDefaultFetch` to route local OpenAI-compatible requests through **`node:http`** (no headers/body deadline). Idempotent — a marker comment guards it, so repeated loads are no-ops.

2. **Auto-rewrites `settings.yaml`** — for every provider under `llm-pi-ai.providers` whose `baseURL` points to a local/LAN address (`127.0.0.1`, `localhost`, `10.x`, `172.16–31.x`, `192.168.x`), sets `streamIdleTimeoutMs` to **1800000** (30 minutes). Idempotent — if the value is already at or above the target, no write. A backup (`settings.yaml.bak`) is created before the first rewrite.

3. **Installs a `globalThis.fetch` fallback** (belt-and-suspenders) for OpenAI-compatible routes that bypass the SDK shims.

Because all patches are re-applied on every load, an `npm install` that overwrites the `openai` package is **automatically re-patched on the next DSH start** — no manual intervention needed.

### Why `node:http` and not `undici.Agent`?

The textbook fix is `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`. But `undici` is **not exposed as a requireable package** in Node 24 (it's built-in but not exported). So we replace the global `fetch` that `getDefaultFetch()` picks up — equivalent for this code path, zero new dependencies.

### Why auto-rewrite settings.yaml?

The pi-ai stream idle watchdog (`streamIdleTimeoutMs`) defaults to 300000 ms. Previously the user had to manually edit `~/.dsh/settings.yaml` and add `streamIdleTimeoutMs: 1800000` to each local provider. Now the plugin does it automatically on every load, so you never have to remember this step.

## What Gets Patched (and What Doesn't)

| Route | Behavior |
|-------|----------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http` + 30 min watchdog |
| `http://192.168.0.110:1234/v1/responses` | ✅ `node:http` + 30 min watchdog |
| `http://localhost:8000/v1/completions` | ✅ `node:http` + 30 min watchdog |
| `https://api.openai.com/v1/chat/completions` | ❌ untouched — real undici `fetch`, default watchdog |
| Any non-OpenAI URL | ❌ untouched — passthrough |

The plugin only intercepts **local/LAN** OpenAI-compatible endpoints. Remote APIs are completely unaffected.

## Install

```bash
# Official CLI (recommended)
dsh plugin --profile <name> add dsh-local-model-long-prefill@1.0.0

# Or manual
cd <profile-dir>
npm install file:<path-to>/dsh-local-model-long-prefill
```

Then **start a new session** (plugin mounts are read at boot).

## Verify

1. Check `~/.dsh/settings.yaml` — every local provider should now have `streamIdleTimeoutMs: 1800000`.
2. Use the same long-context prompt that previously failed at 5 minutes.
3. If it still fails, the failure will now be at a **much longer** wall time (10–30+ min) rather than exactly 5 min — confirming undici `headersTimeout` was the root cause.
4. Check the SDK patch is in place:
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## Works With dsh-compaction-tool

If you also use [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool) (offloads compaction to a fast secondary model), this plugin guarantees that the secondary model's **long compression call** (input = full history = long prefill) won't be killed by the 300-second timeout. The two plugins are complementary.

## Configuration

The default `streamIdleTimeoutMs` target is **1800000** (30 minutes), set in `lib/index.mjs` as `DEFAULT_STREAM_IDLE_TIMEOUT_MS`. To change it, edit that constant. The route classification is by URL; the local/LAN host set is `LOCAL_HOSTS` + `isLocalOrLanHost()`.

## Uninstall

```bash
cd <profile-dir>
npm uninstall dsh-local-model-long-prefill
# Remove from package.json dsh.profile.bundles if present
```

Then restart DSH. The file patches in `node_modules/openai/` and `settings.yaml` will remain (harmless — they are the desired end state), but no new fetch wrapper is installed and no further auto-rewrites occur.

## Project Structure

```
dsh-local-model-long-prefill/
├── lib/index.mjs             # Plugin source (single file, ESM)
├── cordis.patch.yml          # Bundle mount patch
├── README.md / README.zh.md  # This file
└── LICENSE                   # MIT
```

## Migration from dsh-local-model-long-prefill

This plugin **replaces** `dsh-local-model-long-prefill`. To migrate:

1. Uninstall the old plugin: `npm uninstall dsh-local-model-long-prefill`
2. Remove `"dsh-local-model-long-prefill"` from `package.json` `dsh.profile.bundles`
3. Install the new plugin: `npm install dsh-local-model-long-prefill`
4. Add `"dsh-local-model-long-prefill"` to `dsh.profile.bundles`
5. Restart DSH

The SDK shims patch is compatible — the new plugin recognizes and repairs files patched by the old plugin name.

## License

[MIT](./LICENSE) © 2025
