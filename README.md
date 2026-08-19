# dsh-lmstudio-long-prefill

**Fix the 5-minute undici `headersTimeout` abort for local OpenAI-compatible providers.**

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) plugin that makes long-context Prefill and long generation work reliably with local models (LM Studio, vLLM, Ollama, llama.cpp, etc.) — no more `terminated` error at exactly 300 seconds.

> 🇨🇳 中文文档见 **[README.zh.md](./README.zh.md)**

---

## Problem

DSH routes model API calls through the OpenAI SDK → Node's built-in `fetch` (undici). undici has a **300-second `headersTimeout`**: if the model hasn't returned response headers within 5 minutes, the connection is forcibly aborted.

Local small models (3B–7B on consumer GPUs) doing a **long prefill** (long input, full context pass) or **long generation** (many output tokens) routinely exceed 300 seconds → request dies → DSH reports `TRANSPORT / terminated`.

- The OpenAI SDK's own `timeoutMs` is a `setTimeout` **cleared as soon as headers arrive** — it does NOT override undici's internal `headersTimeout`.
- Raising `maxRetries` doesn't help: the failure is **deterministic** (every attempt dies at exactly 5 minutes).

## Solution

On **every DSH load**, the plugin **self-heals the SDK patch**:

1. **Locates** every `openai/internal/shims.{mjs,js}` reachable from the runtime (profile `node_modules`, npx-cache DSH install, the plugin's own tree).
2. **Re-patches** `getDefaultFetch` to route local OpenAI-compatible requests through **`node:http`** (no headers/body deadline). The rewrite is **idempotent** — a marker comment guards it, so repeated loads are no-ops.
3. **Installs a `globalThis.fetch` fallback** (belt-and-suspenders) for OpenAI-compatible routes that bypass the SDK shims.

Because the patch is re-applied on every load, an `npm install` that overwrites the `openai` package is **automatically re-patched on the next DSH start** — no manual intervention needed.

### Why `node:http` and not `undici.Agent`?

The textbook fix is `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`. But `undici` is **not exposed as a requireable package** in Node 24 (it's built-in but not exported). So we replace the global `fetch` that `getDefaultFetch()` picks up — equivalent for this code path, zero new dependencies.

### Why a standard plugin and not a dynamic one?

A **dynamic** Cordis plugin runs in a restricted sandbox with no access to `require`, `http`, `fetch`, or `globalThis`. A **standard** plugin is a regular ESM npm package with full Node access — it lives in the profile's `node_modules` and survives DSH upgrades.

## What Gets Patched (and What Doesn't)

| Route | Behavior |
|-------|----------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http` — no timeout |
| `http://localhost:8000/v1/responses` | ✅ `node:http` — no timeout |
| `https://api.openai.com/v1/chat/completions` | ❌ untouched — real undici `fetch` |
| Any non-OpenAI URL | ❌ untouched — passthrough |

The plugin only intercepts **local** OpenAI-compatible endpoints (`127.0.0.1`, `localhost`, `::1`). Remote APIs are completely unaffected.

## Install

```bash
# Official CLI (recommended)
dsh plugin --profile <name> add dsh-lmstudio-long-prefill@0.4.0

# Or manual
cd <profile-dir>
npm install file:<path-to>/dsh-lmstudio-long-prefill
```

Then **start a new session** (plugin mounts are read at boot).

## Verify

1. Use the same long-context prompt that previously failed at 5 minutes.
2. If it still fails, the failure will now be at a **much longer** wall time (10–30+ min) rather than exactly 5 min — confirming undici `headersTimeout` was the root cause.
3. Check the patch is in place:
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## Works With dsh-compaction-tool

If you also use [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool) (offloads compaction to a fast secondary model), this plugin guarantees that the secondary model's **long compression call** (input = full history = long prefill) won't be killed by the 300-second timeout. The two plugins are complementary.

## Configuration

None. The route classification is by URL; there are no settings to tune. To change which routes get the long-timeout treatment, edit the `OPENAI_PATHS` / `LOCAL_HOSTS` sets in `lib/index.mjs`.

## Uninstall

```bash
cd <profile-dir>
npm uninstall dsh-lmstudio-long-prefill
# Remove from package.json dsh.profile.bundles if present
```

Then restart DSH. The file patch in `node_modules/openai/` will remain (harmless), but no new fetch wrapper is installed.

## Project Structure

```
dsh-lmstudio-long-prefill/
├── lib/index.mjs             # Plugin source (single file, ESM)
├── cordis.patch.yml          # Bundle mount patch
├── README.md / README.zh.md  # This file
└── LICENSE                   # MIT
```

## License

[MIT](./LICENSE) © 2025
