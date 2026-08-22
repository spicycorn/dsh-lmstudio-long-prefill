import fs from "node:fs";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

function scanFrames(buffer, maxFrames) {
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
    if (maxFrames && frames.length === maxFrames) return { frames };
  }
  return { frames };
}

const path = process.argv[2];
const outFile = process.argv[3] || "C:/temp_session_out.jsonl";
const data = fs.readFileSync(path);
console.log("file size:", data.length);
let { frames, tornStart } = scanFrames(data);
let failIdx = -1;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  try {
    zlib.zstdDecompressSync(data.subarray(f.start, f.end));
  } catch (e) {
    failIdx = i;
    console.log(`first failing frame: ${i} at byte ${f.start}: ${e.message}`);
    break;
  }
}

const parts = [];
for (let i = 0; i < frames.length && i !== failIdx; i++) {
  const f = frames[i];
  try {
    const out = zlib.zstdDecompressSync(data.subarray(f.start, f.end));
    parts.push(out);
  } catch (e) {
    console.log(`frame ${i} at byte ${f.start}: ${e.message}`);
    break;
  }
}
if (failIdx === -1 && tornStart != null) {
  try {
    const out = zlib.zstdDecompress(data.subarray(tornStart));
    parts.push(out);
    console.log("torn final frame decoded OK");
  } catch (e) {
    console.log("torn final frame failed:", e.message, "— partial data lost at byte", tornStart);
  }
}
const combined = Buffer.concat(parts);
fs.writeFileSync(outFile, combined);
console.log("wrote", outFile, combined.length, "bytes");
