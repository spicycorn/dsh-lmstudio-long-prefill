import fs from "node:fs";
const f = process.argv[2];
const lines = fs.readFileSync(f, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (!l) continue;
  let o; try { o = JSON.parse(l); } catch { console.log(i + 1, "UNPARSEABLE", l.slice(0, 60)); continue; }
  let t = "?";
  try { const d = new Date(o.time ?? NaN); if (!isNaN(d.getTime())) t = d.toISOString().slice(5, 23); else t = String(o.time).padStart(19); } catch {}
  const type = o.type || "(no-type)";
  let extra = "";
  try {
    const d = o.data ?? {};
    if (type === "llm/retry") extra = `turn=${d.turn} step=${d.step} retry=${d.retry}/${d.maxRetries} delayMs=${Math.round(d.delayMs)} provider=${d.provider} msg="${d.failure?.message}"`;
    else if (type === "llm/retry-started") extra = `turn=${d.turn} step=${d.step} retry=${d.retry}`;
    else if (type === "assistant/chunk" && d.chunk?.type === "finish") { const r = d.chunk.reason; extra = `turn=${d.turn} step=${d.step} reason=${r.kind}${r.failure ? ' "' + r.failure.message + '"' : ""}`; }
    else if (["user/message", "assistant/message"].includes(type)) { const c = Array.isArray(d?.message?.content) ? d.message.content.map(b => b.text || `[${b.type}]`).join(" ") : String(d?.text ?? ""); extra = `: ${(c.slice(0, 90)).replace(/\n/g, " ")}`; }
    else if (type === "llm/request") extra = ` provider=${d.provider ?? ""} model=${d.model ?? ""}${d.inputTokens ? ` inTok≈${d.inputTokens}` : ""}`;
    else if (["tool/call", "tool/result"].includes(type)) { const m = d?.message; let nm=""; try{nm=m?.content?.find(b=>b.type==="text")?.name ?? "";}catch{} extra=` ${String(nm).slice(0,30)}`; }
  } catch {}
  console.log(`${i + 1}\t${type.padEnd(24)}\t${t}${extra ? "\t" + extra : ""}`);
}
