# dsh-local-model-long-prefill

**Fix the undici `headersTimeout` abort, the OpenAI SDK per-request timeout (default 600 s → "Request timed out." at exactly +10 min), AND the pi-ai stream idle watchdog for local OpenAI-compatible providers.**

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) plugin that makes long-context Prefill and long generation work reliably with local models (LM Studio, vLLM, Ollama, llama.cpp, etc.) — no more `terminated` at exactly 300 seconds or "Request timed out." at exactly +600 s.

> 🇨🇳 中文文档见 **[README.zh.md](./README.zh.md)**

---

## Problem

Three independent timeout layers kill local model requests during long prefill — whichever deadline is smallest fires first:

1. **undici `headersTimeout`** (300 s) — DSH routes model API calls through the OpenAI SDK → Node's built-in `fetch` (undici). undici has a **300-second `headersTimeout`**: if response headers haven't arrived within 5 minutes, the connection is forcibly aborted (`terminated`).

2. **OpenAI client per-request timeout** (**600 s default**) — even with layer 1 fixed, every request still dies at exactly **+600 seconds**. The OpenAI SDK's `timeout` option defaults to `DEFAULT_TIMEOUT = 600_000 ms`; it wraps each fetch in an abort signal and throws "Request timed out." (`APIConnectionTimeoutError`) when the local model hasn't returned response headers within **10 minutes** — no matter how long prefill legitimately needs. Session logs show this signature clearly: every attempt fails at exactly +600 s, then retries ~470 ms later (25+ identical failures in one session).

3. **pi-ai stream idle watchdog** (**300 000 ms default**) — the `@deepseek-ai/dsh-llm-pi-ai` adapter wraps every stream in an `idleWatchdog`. If no tokens arrive within that window, it aborts with:
   ```
   pi-ai stream idle timeout after 300000ms
   ```

Local small models (3B–7B on consumer GPUs) doing a **long prefill** (long input, full context pass) or **long generation** (many output tokens) routinely exceed all three windows → request dies. Fixing only one layer just moves the failure to the next-smallest deadline — that is exactly what happened when v1.0 fixed undici and requests then started dying at +600 s instead of +300 s.

## Solution

On **every DSH load**, the plugin:

1. **Self-heals the OpenAI SDK patch** — locates every `openai/internal/shims.{mjs,js}` and re-patches `getDefaultFetch` to route local OpenAI-compatible requests through **`node:http`** (no headers/body deadline). Idempotent — a marker comment guards it, so repeated loads are no-ops.

2. **Auto-rewrites `settings.yaml`** — for every provider under `llm-pi-ai.providers` whose `baseURL` points to a local/LAN address (`127.0.0.1`, `localhost`, `10.x`, `172.16–31.x`, `192.168.x`), sets **both** timeout fields to the shared budget of **7 200 000 ms (2 hours)**:
   - `timeoutMs` — forwarded by dsh-llm-pi-ai as `{ timeout }` on every request, overriding the OpenAI SDK's 600 s default (`DEFAULT_TIMEOUT`). Without this field, layer 2 above fires at exactly +10 min no matter what.
   - `streamIdleTimeoutMs` — raises the pi-ai idle watchdog (layer 3). The watchdog re-arms on every received chunk, so a large value cannot mask a stream that is still progressing; it only bounds requests that go completely silent (a hung local server now fails within ~2 h instead of never failing or at an arbitrary SDK deadline).

   Idempotent and **raise-only** — if either field already holds a value ≥ the target, your higher setting wins. A backup (`settings.yaml.bak`) is created before the first rewrite; all other keys are preserved byte-for-byte (verified against real `yaml` round-trips in tests).

3. **Installs a `globalThis.fetch` fallback** (belt-and-suspenders) for OpenAI-compatible routes that bypass the SDK shims.

Because all patches are re-applied on every load, an `npm install` that overwrites the `openai` package is **automatically re-patched on the next DSH start** — no manual intervention needed.

### Why `node:http` and not `undici.Agent`?

The textbook fix is `fetchOptions: { dispatcher: new undici.Agent({ headersTimeout: 0 }) }`. But `undici` is **not exposed as a requireable package** in Node 24 (it's built-in but not exported). So we replace the global `fetch` that `getDefaultFetch()` picks up — equivalent for this code path, zero new dependencies.

### Why auto-rewrite settings.yaml?

Two of the three layers above are configured per-provider in `~/.dsh/settings.yaml` (`timeoutMs`, `streamIdleTimeoutMs`) — and whichever is set to a smaller value fires first, so **both must be raised together**. Previously you had to manually edit each local provider yourself; now the plugin does it automatically on every load (raise-only: your higher values are respected), so there's no need to remember this step at all.

## What Gets Patched (and What Doesn't)

| Route | Behavior |
|-------|----------|
| `http://127.0.0.1:1234/v1/chat/completions` | ✅ `node:http` · both timeouts = 2 h budget |
| `http://192.168.0.110:1234/v1/responses` | ✅ `node:http` · both timeouts = 2 h budget |
| `http://localhost:8000/v1/completions` | ✅ `node:http` · both timeouts = 2 h budget |
| `https://api.openai.com/v1/chat/completions` | ❌ untouched — real undici `fetch`, default watchdog |
| Any non-OpenAI URL | ❌ untouched — passthrough |

The plugin only intercepts **local/LAN** OpenAI-compatible endpoints. Remote APIs are completely unaffected.

## Install

```bash
# Official CLI (recommended)
dsh plugin --profile <name> add dsh-local-model-long-prefill@latest

# Or manual
cd <profile-dir>
npm install file:<path-to>/dsh-local-model-long-prefill
```

Then **start a new session** (plugin mounts are read at boot).

## Verify

1. Check `~/.dsh/settings.yaml` — every local provider should now have **both** fields at or above 7200000 ms (e.g., LM Studio on port 1234):
   ```yaml
   providers:
     lmstudio:
       baseURL: http://localhost:1234/v1
       timeoutMs: 7200000            # OpenAI SDK per-request budget (was defaulting to 600 s)
       streamIdleTimeoutMs: 7200000   # pi-ai idle watchdog (default was 300 s)
   ```
2. Use the same long-context prompt that previously failed at exactly +10 min with "Request timed out." — it should now complete instead of dying on a fixed deadline; any remaining failure will be a genuine model/server issue, not one of these timeout layers.
3. Check the SDK patch is in place:
   ```bash
   node -e "const m = require('openai/internal/shims.js'); console.log('patched:', m.getDefaultFetch.toString().includes('node:http'))"
   ```

## Works With dsh-compaction-tool

If you also use [`dsh-compaction-tool`](https://github.com/deepseek-ai/dsh-compaction-tool) (offloads compaction to a fast secondary model), this plugin guarantees that the secondary model's **long compression call** (input = full history = long prefill) won't be killed by any of these three timeouts. The two plugins are complementary.

## Configuration

The shared timeout budget target for both managed fields (`timeoutMs`, `streamIdleTimeoutMs`) is **7 200 000 ms** (2 hours), defined in `lib/index.mjs` as the constant `DEFAULT_LOCAL_TIMEOUT_MS`; the field list lives in `MANAGED_PROVIDER_FIELDS`. To change it, edit that constant. The rewrite only raises values — any existing value at or above the target is left untouched. Route classification is by URL; the local/LAN host set is `LOCAL_HOSTS` + `isLocalOrLanHost()`.

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

## License

[MIT](./LICENSE) © 2025
