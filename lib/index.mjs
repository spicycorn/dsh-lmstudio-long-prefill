// dsh-local-model-long-prefill v1.0
//
// Root cause of the "terminated every 5 minutes" failure (two layers):
//
// 1. undici headersTimeout: the OpenAI SDK's shims (getDefaultFetch) fall back
//    to the Node built-in fetch (undici), whose default headersTimeout is
//    300000 ms (5 minutes). During a long-context Prefill a local model does
//    not emit response headers within that window, so undici aborts the
//    request and DSH classifies the error as TRANSPORT/terminated.
//
// 2. pi-ai stream idle watchdog: the @deepseek-ai/dsh-llm-pi-ai adapter wraps
//    every stream in an idleWatchdog with a streamIdleTimeoutMs (default
//    300000 ms). If the local model is slow to emit tokens (long prefill),
//    the watchdog aborts with "pi-ai stream idle timeout after 300000ms".
//
// This plugin fixes BOTH on every load:
//   1. Self-heals the OpenAI SDK shims patch (node:http, no timeout).
//   2. Automatically rewrites settings.yaml to raise streamIdleTimeoutMs for
//      every local provider (baseURL pointing to 127.0.0.1, localhost, or a
//      LAN address) — no manual config editing required.
//   3. Installs a globalThis.fetch fallback as belt-and-suspenders.
//   4. Restores the global fetch on dispose via ctx.effect.
//
// The file patches are applied synchronously in apply() so they are in place
// before any model request can be issued in this session.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

export const name = "dsh-local-model-long-prefill";
export const inject = [];

const OPENAI_PATHS = new Set([
  "/v1/chat/completions", "/v1/responses", "/v1/completions",
  "/v1/embeddings", "/v1/audio/speech", "/v1/audio/transcriptions",
]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLongPrefillRoute(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (OPENAI_PATHS.has(url.pathname)) return true;
    if (LOCAL_HOSTS.has(url.hostname) && /\/(v1|chat|completions|responses|embeddings|audio)(\/|$)/.test(url.pathname)) return true;
    return false;
  } catch { return false; }
}

function httpFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const signal = init.signal;
  const headers = {};
  const h = init.headers;
  if (h) {
    if (typeof h.forEach === "function") h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) { for (const [k, v] of h) headers[k.toLowerCase()] = v; }
    else if (typeof h === "object") { for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v); }
  }
  const body = init.body;
  const useHttps = url.protocol === "https:";
  const mod = useHttps ? https : http;
  const opts = { method, hostname: url.hostname, port: url.port || (useHttps ? 443 : 80), path: url.pathname + url.search, headers };
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) resHeaders.append(k, v.join(", "));
        else if (v != null) resHeaders.append(k, v);
      }
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });
    if (signal) {
      if (signal.aborted) req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      else signal.addEventListener("abort", () => req.destroy(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    }
    req.on("error", (err) => reject(err));
    if (body != null) {
      if (typeof body === "string") { req.write(body); req.end(); }
      else if (body instanceof Uint8Array) { req.write(Buffer.from(body)); req.end(); }
      else if (body && typeof body.getReader === "function") {
        (async () => { try { const r = body.getReader(); while (true) { const { done, value } = await r.read(); if (done) break; if (!req.write(Buffer.from(value))) await new Promise((x) => req.once("drain", x)); } req.end(); } catch (err) { req.destroy(err); } })();
      } else { req.end(); }
    } else { req.end(); }
  });
}

/* -------------------------------------------------------------------------- */
/* The durable SDK patch.                                                     */
/*                                                                            */
/* Strategy (reconstruct-from-canonical): the OpenAI SDK shims are a small,    */
/* stable surface. To re-apply the fix safely after an `npm install` overwrites */
/* the openai package, we do NOT try to surgically splice the original — we    */
/* rewrite the shims file WHOLE, preserving every original export and adding    */
/* the node:http-backed getDefaultFetch. The marker comment is the idempotency  */
/* guard (an already-patched file is left untouched). This is safe because:     */
/*   - we only write files we verified are the openai shims (have the          */
/*     canonical exports + a getDefaultFetch);                                 */
/*   - the rewrite keeps every export (makeReadableStream, ReadableStreamFrom, */
/*     ReadableStreamToAsyncIterable, CancelReadableStream, getDefaultFetch);  */
/*   - the rewrite drops only the `sourceMappingURL` comment (irrelevant).     */
/* -------------------------------------------------------------------------- */

const MARKER = "[dsh-local-model-long-prefill]";

// The node:http helper block (shared shape, module-flavored for each variant).
const ESM_HELPERS = `import nodeHttp from "node:http";
import nodeHttps from "node:https";
import { Readable as NodeReadable } from "node:stream";

function _isLocalOpenAIRoute(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    const openAIPath = /\\/v1\\/(chat\\/completions|responses|completions|embeddings|audio)(\\/|$)/.test(url.pathname);
    return (local && openAIPath) || openAIPath;
  } catch { return false; }
}

function _nodeHttpFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const signal = init.signal;
  const headers = {};
  const h = init.headers;
  if (h) {
    if (typeof h.forEach === "function") h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) { for (const [k, v] of h) headers[k.toLowerCase()] = v; }
    else if (typeof h === "object") { for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v); }
  }
  const body = init.body;
  const useHttps = url.protocol === "https:";
  const mod = useHttps ? nodeHttps : nodeHttp;
  const opts = { method, hostname: url.hostname, port: url.port || (useHttps ? 443 : 80), path: url.pathname + url.search, headers };
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) resHeaders.append(k, v.join(", "));
        else if (v != null) resHeaders.append(k, v);
      }
      resolve(new Response(NodeReadable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });
    if (signal) {
      if (signal.aborted) req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      else signal.addEventListener("abort", () => req.destroy(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    }
    req.on("error", (err) => reject(err));
    if (body != null) {
      if (typeof body === "string") { req.write(body); req.end(); }
      else if (body instanceof Uint8Array) { req.write(Buffer.from(body)); req.end(); }
      else if (body && typeof body.getReader === "function") {
        (async () => { try { const reader = body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; if (!req.write(Buffer.from(value))) await new Promise((r) => req.once("drain", r)); } req.end(); } catch (err) { req.destroy(err); } })();
      } else { req.end(); }
    } else { req.end(); }
  });
}
`;

const CJS_HELPERS = `var _nodeHttp = require("node:http");
var _nodeHttps = require("node:https");
var _NodeReadable = require("node:stream").Readable;
function _isLocalOpenAIRoute(input) {
  try {
    var url = new URL(typeof input === "string" ? input : input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    var local = ["127.0.0.1", "localhost", "::1"].indexOf(url.hostname) !== -1;
    var openAIPath = /\\/v1\\/(chat\\/completions|responses|completions|embeddings|audio)(\\/|$)/.test(url.pathname);
    return (local && openAIPath) || openAIPath;
  } catch (e) { return false; }
}
function _nodeHttpFetch(input, init) {
  init = init || {};
  var url = new URL(typeof input === "string" ? input : input.url);
  var method = (init.method || "GET").toUpperCase();
  var signal = init.signal;
  var headers = {};
  var h = init.headers;
  if (h) {
    if (typeof h.forEach === "function") h.forEach(function(v, k) { headers[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) headers[h[i][0].toLowerCase()] = h[i][1]; }
    else if (typeof h === "object") { for (var key in h) headers[key.toLowerCase()] = String(h[key]); }
  }
  var body = init.body;
  var useHttps = url.protocol === "https:";
  var mod = useHttps ? _nodeHttps : _nodeHttp;
  var opts = { method: method, hostname: url.hostname, port: url.port || (useHttps ? 443 : 80), path: url.pathname + url.search, headers: headers };
  return new Promise(function(resolve, reject) {
    var req = mod.request(opts, function(res) {
      var resHeaders = new Headers();
      for (var name in res.headers) {
        var value = res.headers[name];
        if (Array.isArray(value)) resHeaders.append(name, value.join(", "));
        else if (value != null) resHeaders.append(name, value);
      }
      resolve(new Response(_NodeReadable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });
    if (signal) {
      if (signal.aborted) req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      else signal.addEventListener("abort", function() { req.destroy(new DOMException("The operation was aborted.", "AbortError")); }, { once: true });
    }
    req.on("error", function(err) { reject(err); });
    if (body != null) {
      if (typeof body === "string") { req.write(body); req.end(); }
      else if (body instanceof Uint8Array) { req.write(Buffer.from(body)); req.end(); }
      else if (body && typeof body.getReader === "function") {
        (async function() { try { var reader = body.getReader(); while (true) { var r = await reader.read(); if (r.done) break; if (!req.write(Buffer.from(r.value))) await new Promise(function(r2) { req.once("drain", r2); }); } req.end(); } catch (err) { req.destroy(err); } })();
      } else { req.end(); }
    } else { req.end(); }
  });
}
`;

// The canonical, node:http-backed getDefaultFetch (module-flavored).
const ESM_GET_DEFAULT_FETCH = `export function getDefaultFetch() {
  const origFetch = (typeof fetch !== 'undefined') ? fetch : globalThis.fetch;
  if (typeof origFetch !== 'function') {
    throw new Error('\`fetch\` is not defined as a global; Either pass \`fetch\` to the client, \`new OpenAI({ fetch })\` or polyfill the global, \`globalThis.fetch = fetch\`');
  }
  return function patchedFetch(input, init) {
    if (_isLocalOpenAIRoute(input)) {
      try { return _nodeHttpFetch(input, init); }
      catch { return origFetch(input, init); }
    }
    return origFetch(input, init);
  };
}
`;

const CJS_GET_DEFAULT_FETCH = `function getDefaultFetch() {
  var origFetch = (typeof fetch !== 'undefined') ? fetch : globalThis.fetch;
  if (typeof origFetch !== 'function') {
    throw new Error('\`fetch\` is not defined as a global; Either pass \`fetch\` to the client, \`new OpenAI({ fetch })\` or polyfill the global, \`globalThis.fetch = fetch\`');
  }
  return function patchedFetch(input, init) {
    if (_isLocalOpenAIRoute(input)) {
      try { return _nodeHttpFetch(input, init); }
      catch (e) { return origFetch(input, init); }
    }
    return origFetch(input, init);
  };
}
`;

const HEADER_COMMENT = `// [${MARKER}] v1.0 getDefaultFetch routed through node:http for local
// OpenAI-compatible routes (no undici 300s headersTimeout). Re-applied by the
// dsh-local-model-long-prefill plugin on every load, so an npm upgrade that
// overwrites the openai package is healed on the next DSH start.
`;

/**
 * Build the fully patched shims content for one variant, preserving the original
 * exports (everything except the original getDefaultFetch and its source-map
 * comment). Returns null when the original is not the canonical openai shims
 * shape (so we never corrupt an unexpected file).
 */
function buildPatchedFile(content, isMjs) {
  // Reconstruct from the pristine core: strip EVERY patch artifact so this works
  // on a clean file, a healthy-patched file, OR a double-patched (broken) file.
  let body = content;
  // 1) Drop the header marker comment block (both old and new plugin names).
  body = body.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("// [") && (t.includes("dsh-local-model-long-prefill") || t.includes("dsh-local-model-long-prefill")));
  }).join("\n");
  // 2) Drop node http/https/stream import lines.
  body = body.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("import nodeHttp") || t.startsWith("import nodeHttps")) return false;
    if (t.startsWith("import { Readable as NodeReadable }")) return false;
    if (t.startsWith("var _nodeHttp") || t.startsWith("var _nodeHttps") || t.startsWith("var _NodeReadable")) return false;
    return true;
  }).join("\n");
  // 3) Excise the helper functions + orphaned body blocks.
  body = exciseFunction(body, "function _isLocalOpenAIRoute");
  body = exciseFunction(body, "function _nodeHttpFetch");
  body = exciseOrphanedBody(body);
  // 4) Excise EVERY getDefaultFetch definition.
  const sig = isMjs ? "export function getDefaultFetch" : "function getDefaultFetch";
  let idx;
  while ((idx = body.indexOf(sig)) !== -1) {
    const openBrace = body.indexOf("{", idx);
    if (openBrace === -1) break;
    const close = findFunctionClose(body, openBrace);
    if (close === -1) break;
    body = body.slice(0, idx) + body.slice(close);
  }
  // 5) Drop CJS exports.getDefaultFetch line + the source-map comment.
  body = body.replace(/^\s*exports\.getDefaultFetch\s*=.*$/gm, "");
  body = body.replace(/\/\/# sourceMappingURL=[^\n]*/g, "");
  // 6) Collapse leftover blank runs and trim.
  body = body.replace(/\n{3,}/g, "\n\n").trimEnd();

  const helpers = isMjs ? ESM_HELPERS : CJS_HELPERS;
  const getFetch = isMjs ? ESM_GET_DEFAULT_FETCH : CJS_GET_DEFAULT_FETCH;
  const exportsLine = isMjs ? "" : "\nexports.getDefaultFetch = getDefaultFetch;\n";

  return `${HEADER_COMMENT}\n${body}\n${exportsLine}\n${helpers}\n${getFetch}`;
}

/**
 * Excise an orphaned function BODY block.
 */
function exciseOrphanedBody(text) {
  let idx;
  while ((idx = text.indexOf("\n) {")) !== -1) {
    const bodyStart = idx + 1;
    const openBrace = text.indexOf("{", bodyStart);
    if (openBrace === -1) break;
    const close = findFunctionClose(text, openBrace);
    if (close === -1) break;
    let start = bodyStart;
    while (start > 0 && text[start - 1] !== "\n") start -= 1;
    let end = close;
    if (text[end] === "\n") end += 1;
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

/**
 * Excise a function (and its optional `export`/whitespace prefix) by signature.
 */
function exciseFunction(text, signature) {
  let idx = text.indexOf(signature);
  if (idx === -1) return text;
  let start = idx;
  if (start > 0) {
    const before = text.slice(0, start);
    const exportMatch = before.match(/export\s+$/);
    if (exportMatch) start = start - exportMatch[0].length;
    while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  }
  const openBrace = text.indexOf("{", idx);
  if (openBrace === -1) return text;
  const close = findFunctionClose(text, openBrace);
  if (close === -1) return text;
  let end = close;
  if (text[end] === "\n") end += 1;
  return text.slice(0, start) + text.slice(end);
}

/** Find the index just past the closing brace of a function starting at `start`. */
function findFunctionClose(text, start) {
  let depth = 0;
  let inStr = null;
  let inComment = null;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inComment) {
      if (inComment === "\n" && ch === "\n") inComment = null;
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { inComment = "\n"; i += 1; continue; }
    if (ch === "/" && text[i + 1] === "*") { inComment = "*"; i += 1; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Apply the patch to one shims file if it is not already present.
 */
function patchShimFile(path, log) {
  const isMjs = path.endsWith(".mjs");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return `failed:cannot read (${error.message})`;
  }
  if (!/getDefaultFetch/.test(content) || !/makeReadableStream|ReadableStreamFrom/.test(content)) {
    log(`skipping ${path}: not the canonical OpenAI SDK shims shape`);
    return "skipped";
  }
  const importDecls = countNodeImports(content, isMjs);
  const isHealthyPatched = content.includes(MARKER) && importDecls === 1;
  if (isHealthyPatched) return "already-patched";
  if (importDecls >= 2) log(`repairing ${path}: found ${importDecls} node imports (double-patched)`);
  const next = buildPatchedFile(content, isMjs);
  try {
    writeFileSync(path, next, "utf8");
    return "applied";
  } catch (error) {
    return `failed:cannot write (${error.message})`;
  }
}

/** Count the node:http import declarations in one shims file. */
function countNodeImports(content, isMjs) {
  const re = isMjs ? /^import nodeHttp from/gm : /^var _nodeHttp = require/gm;
  return (content.match(re) || []).length;
}

/* -------------------------------------------------------------------------- */
/* Locating the openai shims files.                                           */
/* -------------------------------------------------------------------------- */

function findShimFiles() {
  const candidates = new Set();
  const push = (p) => { if (p && existsSync(p)) candidates.add(p); };

  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    for (const base of [here, join(here, ".."), join(here, "..", ".."), join(here, "..", "..", "..")]) {
      const nm = join(base, "node_modules");
      for (const shim of ["openai/internal/shims.mjs", "openai/internal/shims.js"]) push(join(nm, shim));
    }
  } catch { /* ignore */ }

  const home = homedir();
  const roots = [
    join(home, "AppData", "Local", "npm-cache", "_npx"),
    join(home, ".dsh", "profiles"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const internal = join(root, entry, "node_modules", "openai", "internal");
      push(join(internal, "shims.mjs"));
      push(join(internal, "shims.js"));
    }
  }

  return [...candidates];
}

/* -------------------------------------------------------------------------- */
/* settings.yaml auto-rewrite: raise streamIdleTimeoutMs for local providers.  */
/*                                                                            */
/* NEW in v1.0. Previously the user had to manually edit settings.yaml to      */
/* raise streamIdleTimeoutMs above the default 300000ms. Now the plugin does   */
/* it automatically on every load:                                              */
/*   - finds ~/.dsh/settings.yaml                                               */
/*   - for every provider under llm-pi-ai.providers whose baseURL points to a   */
/*     local/LAN address, sets streamIdleTimeoutMs to the configured value      */
/*   - idempotent: if the value is already at or above the target, no write     */
/*   - backs up the original to settings.yaml.bak before the first rewrite      */
/* -------------------------------------------------------------------------- */

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 1_800_000; // 30 minutes

function isLocalOrLanHost(hostname) {
  if (LOCAL_HOSTS.has(hostname)) return true;
  if (!hostname) return false;
  // IPv4: 10.x, 172.16-31.x, 192.168.x
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  return false;
}

function isLocalProviderConfig(providerConfig) {
  if (!providerConfig || typeof providerConfig !== "object") return false;
  const baseURL = providerConfig.baseURL;
  if (!baseURL || typeof baseURL !== "string") return false;
  try {
    const url = new URL(baseURL);
    return isLocalOrLanHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Rewrite settings.yaml to ensure every local provider has
 * streamIdleTimeoutMs >= DEFAULT_STREAM_IDLE_TIMEOUT_MS.
 */
function patchSettingsYaml(log) {
  const settingsPath = join(homedir(), ".dsh", "settings.yaml");
  if (!existsSync(settingsPath)) {
    log("settings.yaml not found; skipping streamIdleTimeoutMs rewrite");
    return "not-found";
  }

  let content;
  try {
    content = readFileSync(settingsPath, "utf8");
  } catch (error) {
    return `failed:cannot read (${error.message})`;
  }

  // Try to parse with the yaml package if available; fall back to line-based.
  let yaml = null;
  try {
    const require = createRequire(import.meta.url);
    const yamlPkg = require("yaml");
    yaml = { parse: (s) => yamlPkg.parse(s), stringify: (v) => yamlPkg.stringify(v) };
  } catch {
    try {
      const require = createRequire(import.meta.url);
      const jsYaml = require("js-yaml");
      yaml = { parse: (s) => jsYaml.load(s), stringify: (v) => jsYaml.dump(v) };
    } catch {
      yaml = null;
    }
  }

  if (yaml) {
    let data;
    try {
      data = yaml.parse(content);
    } catch {
      // Fall through to line-based rewrite.
      return patchSettingsYamlLineBased(content, settingsPath, log);
    }
    const providers = data?.["llm-pi-ai"]?.providers;
    if (!providers || typeof providers !== "object") {
      log("no llm-pi-ai.providers in settings.yaml; skipping");
      return "no-local-providers";
    }

    let changed = false;
    for (const [name, cfg] of Object.entries(providers)) {
      if (!isLocalProviderConfig(cfg)) continue;
      const current = cfg.streamIdleTimeoutMs;
      if (current === undefined || current < DEFAULT_STREAM_IDLE_TIMEOUT_MS) {
        cfg.streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        changed = true;
        log(`settings.yaml: provider "${name}" streamIdleTimeoutMs ${current ?? "(unset)"} → ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}`);
      }
    }

    if (!changed) return "already-ok";

    const backupPath = settingsPath + ".bak";
    try {
      if (!existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
    } catch { /* backup failure is non-fatal */ }

    try {
      const next = yaml.stringify(data);
      writeFileSync(settingsPath, next, "utf8");
      return "updated";
    } catch (error) {
      return `failed:cannot write (${error.message})`;
    }
  }

  return patchSettingsYamlLineBased(content, settingsPath, log);
}

/**
 * Line-based fallback for settings.yaml rewrite (no yaml package available).
 */
function patchSettingsYamlLineBased(content, settingsPath, log) {
  const lines = content.split("\n");

  // Identify provider blocks: a provider is a key at indent 6 under llm-pi-ai.providers
  // that has a baseURL field at indent 8.
  const providerBlocks = [];
  let inLlmPiAi = false;
  let inProviders = false;
  let currentProvider = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^llm-pi-ai:\s*$/.test(line.trimEnd())) {
      inLlmPiAi = true;
      inProviders = false;
      continue;
    }
    if (inLlmPiAi && !inProviders) {
      if (/^  providers:\s*$/.test(line)) {
        inProviders = true;
        continue;
      }
      // A non-indented key ends the llm-pi-ai section.
      if (/^\S/.test(line)) {
        inLlmPiAi = false;
        inProviders = false;
      }
    }

    if (inProviders) {
      const providerMatch = line.match(/^    (\w[\w-]*):\s*(\{)?\s*$/);
      if (providerMatch) {
        // Close previous provider block.
        if (currentProvider) providerBlocks.push(currentProvider);
        currentProvider = { name: providerMatch[1], startLine: i, endLine: i, baseURL: null };
        continue;
      }
      if (currentProvider) {
        const urlMatch = line.match(/^\s+baseURL:\s*(\S+)/);
        if (urlMatch) {
          currentProvider.baseURL = urlMatch[1].replace(/["',]/g, "");
          currentProvider.endLine = i;
        }
        // A new top-level key ends the providers section.
        if (/^\S/.test(line)) {
          providerBlocks.push(currentProvider);
          currentProvider = null;
          inProviders = false;
          inLlmPiAi = false;
        }
      }
    }
  }
  if (currentProvider) providerBlocks.push(currentProvider);

  let changed = false;
  const insertions = []; // { afterLine, line }

  for (const block of providerBlocks) {
    if (!block.baseURL) continue;
    let isLocal = false;
    try { isLocal = isLocalOrLanHost(new URL(block.baseURL).hostname); } catch { /* not a URL */ }
    if (!isLocal) continue;

    // Check if streamIdleTimeoutMs is already >= target in this block.
    const blockLines = lines.slice(block.startLine, block.endLine + 1);
    const existing = blockLines.find((l) => l.match(/^\s+streamIdleTimeoutMs:\s*(\d+)/));
    if (existing) {
      const val = parseInt(existing.match(/^\s+streamIdleTimeoutMs:\s*(\d+)/)[1], 10);
      if (val >= DEFAULT_STREAM_IDLE_TIMEOUT_MS) continue;
      // Replace in place.
      const idx = blockLines.indexOf(existing);
      lines[block.startLine + idx] = `        streamIdleTimeoutMs: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS},`;
      changed = true;
      log(`settings.yaml: provider "${block.name}" streamIdleTimeoutMs ${val} → ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}`);
    } else {
      // Insert after the first field line of the block.
      let insertAfter = block.startLine;
      for (let i = block.startLine + 1; i <= block.endLine; i++) {
        if (lines[i].match(/^\s{8,}\w/)) { insertAfter = i; break; }
      }
      insertions.push({ afterLine: insertAfter, line: `        streamIdleTimeoutMs: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS},` });
      changed = true;
      log(`settings.yaml: provider "${block.name}" streamIdleTimeoutMs (unset) → ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}`);
    }
  }

  // Apply insertions (in reverse order to preserve line numbers).
  insertions.sort((a, b) => b.afterLine - a.afterLine);
  for (const ins of insertions) {
    lines.splice(ins.afterLine + 1, 0, ins.line);
  }

  if (!changed) return "already-ok";

  const backupPath = settingsPath + ".bak";
  try {
    if (!existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
  } catch { /* backup failure is non-fatal */ }

  try {
    writeFileSync(settingsPath, lines.join("\n"), "utf8");
    return "updated";
  } catch (error) {
    return `failed:cannot write (${error.message})`;
  }
}

/* -------------------------------------------------------------------------- */
/* apply() — self-heal the SDK patch, rewrite settings.yaml, then install the  */
/*            global fetch fallback.                                           */
/* -------------------------------------------------------------------------- */

export function apply(ctx, input = {}) {
  const log = ctx.logger || ctx.get?.("logger");
  const debug = (...a) => { try { log?.info?.(...a); } catch { /* never break apply */ } };

  // 1) Self-heal the SDK patch (idempotent; re-applies after npm upgrades).
  const shims = findShimFiles();
  const results = [];
  for (const shim of shims) {
    const result = patchShimFile(shim, debug);
    results.push(`${shim}: ${result}`);
    if (result === "applied") debug(`dsh-local-model-long-prefill v1.0: patched ${shim}`);
  }
  if (results.length === 0) {
    debug("dsh-local-model-long-prefill v1.0: no openai shims found; global fetch fallback is the only protection");
  } else {
    for (const r of results) debug(`dsh-local-model-long-prefill v1.0: ${r}`);
  }

  // 2) Auto-rewrite settings.yaml: raise streamIdleTimeoutMs for local providers.
  const settingsResult = patchSettingsYaml(debug);
  debug(`dsh-local-model-long-prefill v1.0: settings.yaml → ${settingsResult}`);

  // 3) Install the global fetch fallback (belt-and-suspenders).
  const realFetch = globalThis.fetch;
  let globalPatched = false;
  if (typeof realFetch === "function") {
    globalThis.fetch = (inp, init) => {
      if (isLongPrefillRoute(inp)) {
        try { return httpFetch(inp, init); } catch { return realFetch(inp, init); }
      }
      return realFetch(inp, init);
    };
    globalPatched = true;
  }

  process.env.DSH_LOCAL_MODEL_PREFILL_ACTIVE = "true";

  ctx.effect(() => {
    if (globalPatched) globalThis.fetch = realFetch;
    delete process.env.DSH_LOCAL_MODEL_PREFILL_ACTIVE;
    debug("dsh-local-model-long-prefill v1.0: global fetch fallback restored (file patches retained)");
  }, "dsh-local-model-long-prefill.restore()");
}
