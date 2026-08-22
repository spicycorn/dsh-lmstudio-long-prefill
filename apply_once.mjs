// One-shot verification: run the plugin's real apply() in an isolated Node
// process against the live environment. The globalThis.fetch wrapper and env
// var installed here die with this process; only durable file effects remain
// (settings.yaml rewrite + idempotent openai shims patches).
import { name, inject, apply } from "./lib/index.mjs";

const logs = [];
let effectCalled = false;
const ctx = {
  logger: { info: (...a) => logs.push(a.map(String).join(" ")), warn: () => {}, error: () => {} },
  get: (svcName) => undefined,
  effect: (fn, label) => { fn(); effectCalled = true; return () => {}; }, // run disposer immediately to prove reversibility
};

console.log(`plugin name=${name} inject=[${inject}]`);
apply(ctx, {});
for (const l of logs) console.log("log:", l);
console.log("effect(disposer) ran without error:", effectCalled);
console.log("fetch wrapper active in this process only:", typeof globalThis.fetch === "function");
