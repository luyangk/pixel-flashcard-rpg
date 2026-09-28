#!/usr/bin/env node
/**
 * gen-narrative-placeholders.mjs —— Plan 4 · T6：序章 8 屏插画的**灰阶占位**（64×64 PNG）。
 *
 * 为什么是脚本：占位图是 T6 的交付物之一（Step 3「静态插画占位」），但真正的美术资产由
 * T9 的 `scripts/gen-sprites.mjs`（pixel-art-studio 管线）**原地替换**同一批路径。把生成
 * 过程入库，占位件才可复现、可审查，也不会让 T9 的替换对象来源不明。
 *
 * 规格刻意与 T9 的素材契约对齐：64×64（∈ {16,32,64}²）、灰度无索引、调色板只有几个灰阶
 * （T9 契约的 ≤32 色轻松满足）。纯 Node（zlib + 手写 PNG 块），零依赖——本机 /sdcard 是
 * noexec，任何 `npm i` 都会踩 vitest 启动坑（T5 教训），占位件不值得为此冒险。
 *
 * 用法：`node scripts/gen-narrative-placeholders.mjs`
 * （幂等：每次按 assets/narrative/prologue.json 的 scenes 覆盖写出 art 路径。）
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SIZE = 64;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 8 位灰度 PNG（colortype 0）：每行前置 filter 0。 */
function grayscalePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1); // [filter, ...px]
    for (let x = 0; x < size; x++) row[x + 1] = pixelAt(x, y);
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** 一块"画框 + 画面 + 底部对话框"的灰阶色块，每屏一个基色（保证 8 张目检可辨）。 */
function placeholder(i) {
  const base = 46 + i * 20;
  return grayscalePng(SIZE, (x, y) => {
    if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) return clamp(base - 22); // 外框
    if (y >= SIZE - 12) return clamp(base - 10); // 底部对话框条
    if (x >= 12 && x < SIZE - 12 && y >= 10 && y < SIZE - 26) return clamp(base + 26); // 画面主体
    return clamp(base);
  });
}

const script = JSON.parse(readFileSync(join(ROOT, 'assets/narrative/prologue.json'), 'utf8'));
const out = [];
for (let i = 0; i < script.scenes.length; i++) {
  const scene = script.scenes[i];
  const target = join(ROOT, scene.art);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, placeholder(i));
  out.push(`${scene.art} (${SIZE}×${SIZE})`);
}
console.log(`prologue placeholders written: ${out.length}`);
for (const line of out) console.log(`  ${line}`);
