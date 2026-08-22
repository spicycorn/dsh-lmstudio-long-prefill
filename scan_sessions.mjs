import fs from "node:fs";
import pathMod from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved bit at ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block at ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decodeAll(data) {
  const { frames, tornStart } = scanFrames(data);
  const parts = [];
  let failIdx = -1;
  for (let i = 0; i < frames.length; i++) {
    try {
      parts.push(zlib.zstdDecompressSync(data.subarray(frames[i].start, frames[i].end)));
    } catch (e) {
      failIdx = i;
      break;
    }
  }
  if (failIdx === -1 && tornStart != null) {
    try { parts.push(zlib.zstdDecompress(data.subarray(tornStart))); } catch {}
  }
  return Buffer.concat(parts);
}

const root = process.env.USERPROFILE + "/.dsh/sessions";
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = pathMod.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".jsonl.zstd")) out.push(p);
  }
}
const files = [];
walk(root, files);

for (const f of files) {
  const rel = pathMod.relative(root, f).replace(/[\\/]/g, "__");
  const outFile = "C:/temp_sessions/" + rel;
  try { fs.mkdirSync(pathMod.dirname(outFile), { recursive: true }); } catch {}
  let data;
  try { data = fs.readFileSync(f); } catch (e) { console.log("SKIP", f, e.message); continue; }
  const out = decodeAll(data);
  fs.writeFileSync(outFile, out);
  const text = out.toString("utf8");
  const rtoc = (text.match(/Request timed out/g) || []).length;
  const retries = (text.match(/\{"type":"llm\/retry"/g) || []).length;
  console.log(`${rel} | size=${data.length} decoded=${out.length} "Request timed out" x${rtoc} llm/retry x${retries}`);
}
