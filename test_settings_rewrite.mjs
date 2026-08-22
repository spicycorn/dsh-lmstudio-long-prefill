// Test harness for the settings.yaml rewrite logic in lib/index.mjs.
import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";

const tmpHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), "dshtest-"));
// Redirect homedir() by patching process env? The plugin uses node:os.homedir().
// We can't easily monkeypatch ESM imports, so instead we copy the function under test.

const src = fs.readFileSync("C:/projects/dsh_plugins/dsh-local-model-long-prefill/lib/index.mjs", "utf8");

// Extract just what we need by evaluating a modified module: replace homedir() usage with our tmp home.
let modSrc = src.replace(/import \{ homedir \} from "node:os";/, `const homedir = () => ${JSON.stringify(tmpHome)};`);
modSrc += `\nexport { patchSettingsYamlLineBased, MANAGED_PROVIDER_FIELDS, DEFAULT_LOCAL_TIMEOUT_MS };\n`;

// Write to a temp file and import it.
const modPath = pathMod.join(tmpHome, "plugin-under-test.mjs");
fs.writeFileSync(modPath, modSrc);
const plugin = await import("file:///" + modPath.split(pathMod.sep).join("/"));

function makeSettings(content) {
  fs.mkdirSync(pathMod.join(tmpHome, ".dsh"), { recursive: true });
  const p = pathMod.join(tmpHome, ".dsh", "settings.yaml");
  if (content !== undefined) fs.writeFileSync(p, content);
  else try { fs.unlinkSync(p); } catch {}
  return p;
}

const logs = [];
const logFn = (...a) => logs.push(a.map(String).join(" "));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// ---- Case A: current real-world shape (streamIdle after models list; no timeoutMs) ----
{
  logs.length = 0;
  const p = makeSettings([
    "ui-onboarding:",
    "  welcomeNoticeVersion: x",
    "llm-pi-ai:",
    "  providers:",
    "    herdsman:",
    "      apiKeyEnv: HERDSMAN_API_KEY",
    "      api: openai-completions",
    "      baseURL: http://192.168.0.110:8080/v1",
    "      models:",
    "        - id: Qwen3.8-27B",
    "        - id: Qwen3.5_4b",
    "      streamIdleTimeoutMs: 1800000",
    "agent-default-model:",
    "  provider: herdsman",
    "",
  ].join("\n"));
  const out = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("A result=updated", out === "updated", `got ${out}`);
  const next = fs.readFileSync(p, "utf8");
  console.log("--- A output ---\n" + next + "\n-----------------");
  check("A timeoutMs inserted once", (next.match(/timeoutMs:/g) || []).length === 1 && /timeoutMs: 7200000/.test(next));
  check("A streamIdle raised in place, single occurrence", (next.match(/streamIdleTimeoutMs:/g) || []).length === 1 && /streamIdleTimeoutMs: 7200000/.test(next));
  // Idempotency second run
  const out2 = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("A idempotent already-ok", out2 === "already-ok", `got ${out2}`);
}

// ---- Case B: provider with neither field (both missing) + a remote provider that must be untouched ----
{
  logs.length = 0;
  const p = makeSettings([
    "llm-pi-ai:",
    "  providers:",
    "    lmstudio-local:",
    "      api: openai-completions",
    "      baseURL: http://127.0.0.1:1234/v1",
    "    remote-openai:",
    "      apiKeyEnv: OPENAI_API_KEY",
    "      baseURL: https://api.openai.com/v1",
    "",
  ].join("\n"));
  const out = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("B result=updated", out === "updated", `got ${out}`);
  const next = fs.readFileSync(p, "utf8");
  console.log("--- B output ---\n" + next + "\n-----------------");
  // local provider gets both fields in order timeoutMs then streamIdleTimeoutMs
  const localBlock = next.split("remote-openai:")[0];
  check("B both inserted", /timeoutMs: 7200000/.test(localBlock) && /streamIdleTimeoutMs: 7200000/.test(localBlock));
  const tIdx = localBlock.indexOf("timeoutMs:"), sIdx = localBlock.indexOf("streamIdleTimeoutMs:");
  check("B order timeout before streamIdle", tIdx !== -1 && sIdx > tIdx, `t=${tIdx} s=${sIdx}`);
  // remote untouched
  const remotePart = next.split("remote-openai:").join("\n@@\n") ; 
  check("B remote provider has no managed fields", !/timeoutMs|streamIdleTimeoutMs/.test(next.slice(next.indexOf("remote-openai:"))));
}

// ---- Case C: values already above target are respected (never lowered) ----
{
  logs.length = 0;
  const p = makeSettings([
    "llm-pi-ai:",
    "  providers:",
    "    big-local:",
    "      baseURL: http://192.168.1.50:8000/v1",
    "      timeoutMs: 99999999",
    "      streamIdleTimeoutMs: 7300000",
    "",
  ].join("\n"));
  const out = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("C already-ok (values above target untouched)", out === "already-ok", `got ${out}`);
}

// ---- Case D: quoted numeric value recognized and raised in place (no duplicate) ----
{
  logs.length = 0;
  const p = makeSettings([
    "llm-pi-ai:",
    "  providers:",
    "    q-local:",
    "      baseURL: http://127.0.0.1:8080/v1",
    '      timeoutMs: "600000"',
    "",
  ].join("\n"));
  const out = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("D result=updated", out === "updated", `got ${out}`);
  const next = fs.readFileSync(p, "utf8");
  console.log("--- D output ---\n" + next + "\n-----------------");
  check("D single timeoutMs line with target value", (next.match(/timeoutMs:/g) || []).length === 1 && /timeoutMs: 7200000/.test(next));
}

// ---- Case E: no settings file → not-found; empty providers section handled by yaml path only, but line-based on missing llm-pi-ai returns already-ok without write ----
{
  logs.length = 0;
  const p = makeSettings("agent-default-model:\n  provider: x\n");
  const out = plugin.patchSettingsYamlLineBased(fs.readFileSync(p, "utf8"), p, logFn);
  check("E no providers → already-ok", out === "already-ok", `got ${out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
