// dsh-lmstudio-long-prefill v0.4
//
// Root cause of the "terminated every 5 minutes" failure: the OpenAI SDK's
// shims (getDefaultFetch) fall back to the Node built-in fetch (undici), whose
// default headersTimeout is 300000 ms (5 minutes). During a long-context
// Prefill a local model does not emit response headers within that window, so
// undici aborts the request and DSH classifies the error as TRANSPORT/terminated.
//
// The durable fix is a patch applied to the OpenAI SDK's shims.mjs (ESM) and
// shims.js (CJS): their getDefaultFetch is rewritten to route local
// OpenAI-compatible requests through node:http (no headers/body deadline).
//
// This plugin makes that fix SELF-HEALING. On every load it:
//   1. Locates every openai/internal/shims.{mjs,js} reachable from the runtime.
//   2. Applies the patch if it is not already present (idempotent — a marker
//      comment guards it, so repeated loads are no-ops). This is what guarantees
//      the patch is (re)applied even after `npm install` overwrites the openai
//      package: the next plugin load re-patches it.
//   3. Installs a globalThis.fetch fallback for OpenAI-compatible routes as
//      belt-and-suspenders (covers a request path that bypasses the SDK shims).
//   4. Restores the global fetch on dispose via ctx.effect (the file patch is
//      deliberately retained — it is the durable fix and is re-applied on load).
//
// The file patch is applied synchronously in apply() so it is in place before any
// model request can be issued in this session.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

export const name = "dsh-lmstudio-long-prefill";
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

const MARKER = "[dsh-lmstudio-long-prefill]";

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

const HEADER_COMMENT = `// [${MARKER}] v0.4 getDefaultFetch routed through node:http for local
// OpenAI-compatible routes (no undici 300s headersTimeout). Re-applied by the
// dsh-lmstudio-long-prefill plugin on every load, so an npm upgrade that
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
  // Artifacts removed: the header comment, the node http/https/stream imports,
  // the _isLocalOpenAIRoute / _nodeHttpFetch helpers, every getDefaultFetch
  // definition (original + patched), the CJS getDefaultFetch export line, and the
  // source-map comment. What remains is the original stream shims.
  let body = content;
  // 1) Drop the header marker comment block (first comment group after the
  //    Stainless line). Remove any line that is part of our header.
  body = body.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("// [") && t.includes("dsh-lmstudio-long-prefill"));
  }).join("\n");
  // 2) Drop node http/https/stream import lines (ESM `import ...` and CJS `var _...`).
  body = body.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("import nodeHttp") || t.startsWith("import nodeHttps")) return false;
    if (t.startsWith("import { Readable as NodeReadable }")) return false;
    if (t.startsWith("var _nodeHttp") || t.startsWith("var _nodeHttps") || t.startsWith("var _NodeReadable")) return false;
    return true;
  }).join("\n");
  // 3) Excise the helper functions (each has a distinct signature), plus any
  //    ORPHANED body block left by a previously-buggy repair (a line that is just
  //    ") {" with a following brace-balanced body). This makes the rebuild safe on
  //    a file that is already partially broken.
  body = exciseFunction(body, "function _isLocalOpenAIRoute");
  body = exciseFunction(body, "function _nodeHttpFetch");
  body = exciseOrphanedBody(body);
  // 4) Excise EVERY getDefaultFetch definition (original + any patched copies).
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
  // CJS: the other exports are declared at the top of `body`; add the
  // getDefaultFetch export there too (it is a function declaration below).
  const exportsLine = isMjs ? "" : "\nexports.getDefaultFetch = getDefaultFetch;\n";

  return `${HEADER_COMMENT}\n${body}\n${exportsLine}\n${helpers}\n${getFetch}`;
}

/**
 * Excise an orphaned function BODY block: a line that is exactly ") {" (a
 * dangling parameter-list close from a signature that was already removed) with
 * a following brace-balanced body. Removes the block so a previously-broken file
 * can be cleanly rebuilt.
 */
function exciseOrphanedBody(text) {
  let idx;
  while ((idx = text.indexOf("\n) {")) !== -1) {
    // The block starts at the ") {" and ends at its matching close.
    const bodyStart = idx + 1;
    const openBrace = text.indexOf("{", bodyStart);
    if (openBrace === -1) break;
    const close = findFunctionClose(text, openBrace);
    if (close === -1) break;
    // Walk back to the start of the line (drop the leading ") {") and forward past
    // the trailing newline.
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
 * No-op when the signature is not present.
 */
function exciseFunction(text, signature) {
  let idx = text.indexOf(signature);
  if (idx === -1) return text;
  // Walk back over an `export ` prefix if present.
  let start = idx;
  if (start > 0) {
    const before = text.slice(0, start);
    const exportMatch = before.match(/export\s+$/);
    if (exportMatch) start = start - exportMatch[0].length;
    while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  }
  // Find the function body's opening brace (skipping the parameter list), then
  // its matching close. This correctly excises the WHOLE function including the
  // signature and body, leaving no orphaned `) { ... }` fragment.
  const openBrace = text.indexOf("{", idx);
  if (openBrace === -1) return text;
  const close = findFunctionClose(text, openBrace);
  if (close === -1) return text;
  // Trim the trailing newline after the function.
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
 * Apply the patch to one shims file if it is not already present. Returns one of
 * "applied", "already-patched", "skipped", "failed:<reason>".
 */
function patchShimFile(path, log) {
  const isMjs = path.endsWith(".mjs");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return `failed:cannot read (${error.message})`;
  }
  // The file must be the OpenAI SDK shims (export getDefaultFetch + at least one
  // of the canonical stream shims). Otherwise skip — never corrupt a foreign file.
  if (!/getDefaultFetch/.test(content) || !/makeReadableStream|ReadableStreamFrom/.test(content)) {
    log(`skipping ${path}: not the canonical OpenAI SDK shims shape`);
    return "skipped";
  }
  // A healthy patch declares the node:http import EXACTLY once. Two or more means
  // the file was double-patched (e.g. by a stale run) and is broken — "Identifier
  // 'nodeHttp' has already been declared" — so rebuild it from the pristine core.
  const importDecls = countNodeImports(content, isMjs);
  const isHealthyPatched = content.includes(MARKER) && importDecls === 1;
  if (isHealthyPatched) return "already-patched";
  if (importDecls >= 2) log(`repairing ${path}: found ${importDecls} node imports (double-patched)`);
  const next = buildPatchedFile(content, isMjs);
  try {
    writeFileSync(path, next, "utf8");
    return isHealthyPatched ? "already-patched" : "applied";
  } catch (error) {
    return `failed:cannot write (${error.message})`;
  }
}

/** Count the node:http import declarations in one shims file (ESM or CJS).
 *  Anchored to line-start so the header comment's "node:http" mention is not
 *  miscounted as an import (which would break idempotency on a healthy file). */
function countNodeImports(content, isMjs) {
  const re = isMjs ? /^import nodeHttp from/gm : /^var _nodeHttp = require/gm;
  return (content.match(re) || []).length;
}

/* -------------------------------------------------------------------------- */
/* Locating the openai shims files.                                           */
/* -------------------------------------------------------------------------- */

/**
 * Find every openai/internal/shims.{mjs,js} reachable from the runtime: from
 * the module this plugin was loaded from, the profile node_modules, and the
 * npx-cache DSH install. Returns a de-duplicated list of absolute file paths.
 */
function findShimFiles() {
  const candidates = new Set();
  const push = (p) => { if (p && existsSync(p)) candidates.add(p); };

  // 1) Resolve relative to this module (works for both the file: install and a
  //    published package living in the profile's node_modules).
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    for (const base of [here, join(here, ".."), join(here, "..", ".."), join(here, "..", "..", "..")]) {
      const nm = join(base, "node_modules");
      for (const shim of ["openai/internal/shims.mjs", "openai/internal/shims.js"]) push(join(nm, shim));
    }
  } catch { /* ignore */ }

  // 2) The known npx-cache DSH install and the profile node_modules.
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
/* apply() — self-heal the SDK patch, then install the global fetch fallback. */
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
    if (result === "applied") debug(`dsh-lmstudio-long-prefill v0.4: patched ${shim}`);
  }
  if (results.length === 0) {
    debug("dsh-lmstudio-long-prefill v0.4: no openai shims found; global fetch fallback is the only protection");
  } else {
    for (const r of results) debug(`dsh-lmstudio-long-prefill v0.4: ${r}`);
  }

  // 2) Install the global fetch fallback (belt-and-suspenders).
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

  process.env.DSH_LMSTUDIO_PREFILL_ACTIVE = "true";

  ctx.effect(() => {
    if (globalPatched) globalThis.fetch = realFetch;
    delete process.env.DSH_LMSTUDIO_PREFILL_ACTIVE;
    debug("dsh-lmstudio-long-prefill v0.4: global fetch fallback restored (file patch retained)");
  }, "dsh-lmstudio-long-prefill.restore()");
}
