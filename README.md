# dsh-lmstudio-long-prefill

Fixes the "terminated every 5 minutes" failure when calling an
OpenAI-compatible local provider (LM Studio, vLLM, Ollama, etc.) through
DSH's `llm-pi-ai` adapter with a long context.

## Root cause

`pi-ai`'s `openai-completions.js` builds the OpenAI SDK client with no
`fetch` or `dispatcher`, so the SDK falls back to `globalThis.fetch` —
which on Node 24 is the built-in undici. undici's default `headersTimeout`
is `300000` ms (5 minutes). During a long-context Prefill the model does
not emit response headers within that window, so undici aborts the
request and DSH classifies the error as `TRANSPORT` / `terminated`.

- The OpenAI SDK's own `timeoutMs` (`openai/client.js:392`) is a
  `setTimeout` that is **cleared as soon as headers arrive**; it only
  bounds time-to-headers at the SDK layer and does **not** override
  undici's internal `headersTimeout`.
- Raising `maxRetries` or the backoff interval does not help: the failure
  is **deterministic** (every attempt dies at 5 minutes), so more retries
  only delay the identical failure.

## What this plugin does

On **every load** the plugin **self-heals the SDK patch**: it locates each
`openai/internal/shims.{mjs,js}` reachable from the runtime (the profile
`node_modules`, the npx-cache DSH install, and the tree the plugin itself lives
in), and if the patch is not already present it rewrites that file's
`getDefaultFetch` to route local OpenAI-compatible requests through `node:http`
(no headers/body deadline). The rewrite is **idempotent** (a marker comment is
the guard, so a second load is a no-op) and **preserves every other export** of
the shims module. This is the fix for the old failure mode — where a patch
hand-applied into `node_modules` would be silently reverted by the next
`npm install`: now the plugin re-applies it on the next DSH start.

It also installs a `globalThis.fetch` fallback (belt-and-suspenders) that:

- **passes through to the real undici `fetch`** for every request whose URL
  is not an OpenAI-compatible route (web tools, other providers, browser
  calls that reach the host — all keep undici's 5-min header bound, which
  is fine for short-lived requests);
- for OpenAI-compatible routes (path ending in `/v1/chat/completions`,
  `/v1/responses`, `/v1/completions`, `/v1/embeddings`, or a local host +
  OpenAI-style path), uses a **`node:http`-backed fetch with no
  headers/body deadline**, so Prefill can take as long as the model needs.

The `globalThis.fetch` fallback is installed on `apply` and **restored on
dispose** (via `ctx.effect`), so `cordis_stop` / `cordis_undefine` clean it up.
The **file patch is deliberately retained** — it is the durable fix, and the
plugin re-applies (or confirms) it on every load, so it survives process
restarts and npm upgrades.

## Install

```powershell
# from the profile directory
cd C:\Users\spicycorn\.dsh\profiles\web
npm install file:C:\projects\dsh_plugins\dsh-lmstudio-long-prefill
dsh plugin --profile web add dsh-lmstudio-long-prefill
```

Or, if you prefer the manual mount line, add this to
`C:\Users\spicycorn\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: lmstudio-long-prefill
      name: 'dsh-lmstudio-long-prefill'
```

Then **start a new session** (settings and plugin mounts are read at boot).

## Verify

1. Use the same long-context prompt that previously failed at 5 minutes.
2. If it still fails, the failure will now be at a **much longer** wall time
   (10–30+ minutes) rather than exactly 5 minutes — that confirms the
   undici `headersTimeout` was the root cause and the wrapper is taking
   effect.
3. If you want to see the wrapper active, add a `console.log` in
   `lib/index.mjs` at the top of `apply` and watch the DSH host log.

## Why a global-fetch swap and not `fetchOptions.dispatcher`?

The textbook fix is to pass `fetchOptions: { dispatcher: new
undici.Agent({ headersTimeout: 0, bodyTimeout: 0 }) }` to the OpenAI SDK
client. That requires the `undici` package to be requireable, which it is
**not** in Node 24 (undici is built-in but not exposed). So we replace the
global `fetch` that `getDefaultFetch()` (`openai/internal/shims.js:9-13`)
picks up, which is equivalent for this code path and needs no new
dependency.

## Why a standard plugin and not a dynamic one?

- A **dynamic** Cordis plugin runs in a restricted sandbox that does not
  expose `require`, `http`, `fetch`, or `globalThis`, so it cannot build
  this fix at all.
- A **standard** plugin is a regular ESM npm package loaded with full Node
  access. It lives in the profile's `node_modules`, is mounted via
  `cordis.patch.yml` into the bundle stack, and is installed with
  `dsh plugin --profile web add <pkg>`. It is **your** package, **your**
  version, mounted by **your** profile — DSH upgrades do not touch it, so
  it survives upgrades.

## Configuration

None. The wrapper is route-classified by URL; there are no settings to
tune. To change which routes get the long-timeout treatment, edit the
`OPENAI_PATHS` / `EXTRA_PATHS` / `LOCAL_HOSTS` sets in `lib/index.mjs`.

## Uninstall

```powershell
cd C:\Users\spicycorn\.dsh\profiles\web
npm uninstall dsh-lmstudio-long-prefill
# and remove the bundle line from package.json's dsh.profile.bundles if
# present, or remove the manual mount line from cordis.patch.yml.
```

Then restart DSH.
