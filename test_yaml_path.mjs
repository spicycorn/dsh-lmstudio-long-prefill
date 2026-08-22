// Test harness for patchSettingsYaml (yaml-package path) in lib/index.mjs.
import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";
import { execSync } from "node:child_process";

const tmpHome = fs.mkdtempSync(pathMod.join(os.tmpdir(), "dshtest-yaml-"));
const src = fs.readFileSync(new URL("./lib/index.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
let modSrc = src.replace(/import \{ homedir \} from "node:os";/, `const homedir = () => ${JSON.stringify(tmpHome)};`);
modSrc += `\nexport { patchSettingsYaml };\n`;

// Install the yaml package next to the module so createRequire resolves it.
execSync(`npm install --no-audit --no-fund --loglevel=error yaml`, { cwd: tmpHome, stdio: "inherit" });

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
  if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// Real-world shape: herdsman with streamIdleTimeoutMs=1800000 after models list, no timeoutMs.
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
  const out = plugin.patchSettingsYaml(logFn);
  check("yaml result=updated", out === "updated", `got ${out}`);
  console.log("--- yaml output ---\n" + fs.readFileSync(p, "utf8") + "\n---------------------");
  for (const l of logs) console.log("log:", l);
  const next = fs.readFileSync(p, "utf8");
  check("yaml timeoutMs added", /timeoutMs: 7200000/.test(next));
  check("yaml streamIdle raised to target once", (next.match(/streamIdleTimeoutMs:/g) || []).length === 1 && /streamIdleTimeoutMs: 7200000/.test(next));
  // Other sections preserved?
  const { createRequire } = await import("node:module");
  const req2 = createRequire(pathMod.join(tmpHome, "probe.js"));
  const yamlPkg = req2("yaml");
  const data = yamlPkg.parse(next);
  check("yaml other keys intact", data["agent-default-model"]?.provider === "herdsman" && Array.isArray(data["llm-pi-ai"].providers.herdsman.models) && data["ui-onboarding"].welcomeNoticeVersion === "x");
  // Idempotency: second run must be a no-op.
  const out2 = plugin.patchSettingsYaml(logFn);
  check("yaml idempotent already-ok", out2 === "already-ok", `got ${out2}`);
}

// Remote provider untouched by yaml path too.
{
  logs.length = 0;
  const p = makeSettings([
    "llm-pi-ai:",
    "  providers:",
    "    remote-openai:",
    "      apiKeyEnv: OPENAI_API_KEY",
    "      baseURL: https://api.openai.com/v1",
    "",
  ].join("\n"));
  const out = plugin.patchSettingsYaml(logFn);
  check("yaml no-local-providers → already-ok (no write)", out === "already-ok" || /updated/.test(out) ? !/timeoutMs|streamIdleTimeoutMs/.test(fs.readFileSync(p, "utf8")) : false, `got ${out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
