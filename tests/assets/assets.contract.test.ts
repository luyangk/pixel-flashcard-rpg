/**
 * T9 · 像素素材契约（assets/sprites/*.png）。
 *
 * 为什么要有这个文件：素材是 T11 宿主按**写死的路径**加载的二进制资产，改名/改尺寸/换色型
 * 都不会让 TS 编译报错，只会在运行时变成一张糊图或 404。这里把「路径 / 尺寸 / 色型 / 调色板
 * ≤32 / 禁半透明」钉成可执行契约，任何一条破了测试就红。
 *
 * 判别力（本文件的自我要求）：断言不能只看文件大小或扩展名——那样把 hero.png 换成任意
 * 32×32 的假图也会绿。因此这里**自己解析 PNG**：读 IHDR + 拼 IDAT + zlib.inflateSync 解压 +
 * 逐行反过滤（filter 0–4），拿到真实像素后再数颜色。`decodePng` / `checkSpec` 是纯函数，
 * 可以用内存里伪造的假 PNG 直接单测（见文件末尾 "判别力自检" 组），不依赖磁盘上的真素材。
 *
 * 生成这些素材的脚本：`node scripts/gen-sprites.mjs`（pixel-art-studio 管线，幂等）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPRITES = 'assets/sprites';

const png = (name: string): Buffer => readFileSync(resolve(ROOT, SPRITES, name));

// ---------------------------------------------------------------------------
// PNG 解码（零依赖：只用 node:zlib）
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** bytes per pixel（仅支持 bitDepth 8）。 */
function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // truecolor
    case 3:
      return 1; // indexed（PLTE 索引，8 位）
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // truecolor + alpha
    default:
      throw new Error(`未知 PNG colorType: ${colorType}`);
  }
}

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  /** 逐像素 RGBA，长度 = w*h*4。 */
  rgba: Uint8Array;
}

/** 手写 PNG 解码：签名 → 块遍历（IHDR/PLTE/IDAT）→ inflate → 反过滤 → 转 RGBA。 */
function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是 PNG（签名不匹配）');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let seenIhdr = false;

  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (off + 12 + len > buf.length) throw new Error(`PNG 块 ${type} 越界`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
      seenIhdr = true;
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!seenIhdr) throw new Error('缺 IHDR');
  if (bitDepth !== 8) throw new Error(`只支持 bitDepth 8，实际 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG（interlace≠0）');

  const bpp = bytesPerPixel(colorType);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) {
    throw new Error(`IDAT 解压后长度不足：${raw.length} < ${(stride + 1) * height}`);
  }
  const img = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(pos);
    pos += 1;
    const row = img.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`未知 PNG filter 类型 ${filter}`);
      }
      row[i] = (row[i] + add) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    const d = i * 4;
    switch (colorType) {
      case 0: {
        const g = img[s];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
        break;
      }
      case 2:
        rgba[d] = img[s];
        rgba[d + 1] = img[s + 1];
        rgba[d + 2] = img[s + 2];
        rgba[d + 3] = 255;
        break;
      case 3: {
        if (!palette) throw new Error('索引色 PNG 缺 PLTE');
        const idx = img[s];
        rgba[d] = palette[idx * 3];
        rgba[d + 1] = palette[idx * 3 + 1];
        rgba[d + 2] = palette[idx * 3 + 2];
        rgba[d + 3] = 255;
        break;
      }
      case 4: {
        const g = img[s];
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = img[s + 1];
        break;
      }
      default: {
        rgba[d] = img[s];
        rgba[d + 1] = img[s + 1];
        rgba[d + 2] = img[s + 2];
        rgba[d + 3] = img[s + 3];
        break;
      }
    }
  }
  return { width, height, bitDepth, colorType, interlace, rgba };
}

interface PixelStats {
  /** 不透明像素用到的不同 RGB（十进制打包）。 */
  colors: number;
  /** a==0 像素里出现过的不同 RGBA（>1 说明透明区藏了不可见色，白占调色板）。 */
  transparentVariants: number;
  /** 0<a<255 的像素数（水墨像素风禁半透明）。 */
  semiAlpha: number;
  /** a>0 的像素数。 */
  opaque: number;
}

function pixelStats(p: DecodedPng): PixelStats {
  const colors = new Set<number>();
  const transparent = new Set<number>();
  let semiAlpha = 0;
  let opaque = 0;
  const { rgba } = p;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0) {
      transparent.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
      continue;
    }
    if (a < 255) semiAlpha += 1;
    opaque += 1;
    colors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  return { colors: colors.size, transparentVariants: transparent.size, semiAlpha, opaque };
}

interface SeamStats {
  /** 缝上的平均通道差 / 图内平均通道差。 */
  energyRatio: number;
  /** 缝上的"硬边"（单通道差 ≥64）占比 / 图内硬边占比。 */
  hardEdgeRatio: number;
}

/** 可平铺判据：接缝处的梯度统计应当与图内相邻像素的梯度统计同量级（标定见用例注释）。 */
function seamStats(p: DecodedPng): SeamStats {
  const diff = (x0: number, y0: number, x1: number, y1: number): number => {
    const a = (y0 * p.width + x0) * 4;
    const b = (y1 * p.width + x1) * 4;
    return Math.max(
      Math.abs(p.rgba[a] - p.rgba[b]),
      Math.abs(p.rgba[a + 1] - p.rgba[b + 1]),
      Math.abs(p.rgba[a + 2] - p.rgba[b + 2]),
    );
  };
  const seam: number[] = [];
  const interior: number[] = [];
  for (let y = 0; y < p.height; y++) seam.push(diff(p.width - 1, y, 0, y));
  for (let x = 0; x < p.width; x++) seam.push(diff(x, p.height - 1, x, 0));
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x + 1 < p.width; x++) interior.push(diff(x, y, x + 1, y));
  }
  for (let x = 0; x < p.width; x++) {
    for (let y = 0; y + 1 < p.height; y++) interior.push(diff(x, y, x, y + 1));
  }
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  const hard = (a: number[]): number => a.filter((v) => v >= 64).length / a.length;
  const meanInterior = mean(interior);
  const hardInterior = hard(interior);
  return {
    energyRatio: mean(seam) / meanInterior,
    hardEdgeRatio: hardInterior === 0 ? Number.POSITIVE_INFINITY : hard(seam) / hardInterior,
  };
}

// ---------------------------------------------------------------------------
// 契约声明
// ---------------------------------------------------------------------------

/**
 * 色型/透明度口径：
 * - `required`：sprite（hero/mob/boss）——必须 RGBA，且有透明背景、不能全透明；
 * - `rgba`：整幅插画（暗线三幕）——必须 RGBA（T8/T11 按带 alpha 的图加载），但允许满幅不透明；
 * - `forbidden`：平铺背景——必须是不带 alpha 通道的 RGB；
 * - `any`：不约束色型（序章占位替换件）。
 */
type Alpha = 'required' | 'rgba' | 'forbidden' | 'any';

interface Spec {
  /** 相对 assets/sprites 的文件名。 */
  file: string;
  size: number;
  alpha: Alpha;
  /** 人类可读用途，失败信息里出现。 */
  use: string;
  /** 调色板上限，默认 32（PRD §7）。 */
  maxColors?: number;
}

const SPRITE_SPECS: Spec[] = [
  { file: 'hero.png', size: 32, alpha: 'required', use: '侠客立绘，面向右' },
  { file: 'mob-1.png', size: 32, alpha: 'required', use: '小怪变体 1（数据虫）' },
  { file: 'mob-2.png', size: 32, alpha: 'required', use: '小怪变体 2（爬虫）' },
  { file: 'mob-3.png', size: 32, alpha: 'required', use: '小怪变体 3（弹窗故障体）' },
  { file: 'mob-4.png', size: 32, alpha: 'required', use: '小怪变体 4（空指针傀）' },
  { file: 'boss-1.png', size: 64, alpha: 'required', use: '锦绣篇·卷灵' },
  { file: 'boss-2.png', size: 64, alpha: 'required', use: '巴别篇·卷灵' },
  { file: 'boss-3.png', size: 64, alpha: 'required', use: '烟火篇·卷灵' },
  { file: 'boss-4.png', size: 64, alpha: 'required', use: '长安篇·卷灵' },
  { file: 'bg-arena.png', size: 64, alpha: 'forbidden', use: '数据荒原背景（无缝平铺）' },
  { file: 'prologue-01-cloud-age.png', size: 64, alpha: 'any', use: '序章一·云端盛世' },
  { file: 'prologue-02-data-flood.png', size: 64, alpha: 'any', use: '序章二·数据溢出' },
  { file: 'prologue-03-great-forgetting.png', size: 64, alpha: 'any', use: '序章三·大遗忘' },
  { file: 'prologue-04-cloud-down.png', size: 64, alpha: 'any', use: '序章四·云端失效' },
  { file: 'prologue-05-old-art.png', size: 64, alpha: 'any', use: '序章五·古法' },
  { file: 'prologue-06-teaching.png', size: 64, alpha: 'any', use: '序章六·授艺' },
  { file: 'prologue-07-departure.png', size: 64, alpha: 'any', use: '序章七·出发' },
  { file: 'prologue-08-title.png', size: 64, alpha: 'any', use: '序章八·标题画面' },
  // 暗线三幕（LORE §5.3，assets/narrative/arc.json 的 art 路径）
  { file: 'arc-1.png', size: 64, alpha: 'rgba', use: '暗线一幕·源头（残片指向远方微光）' },
  { file: 'arc-2.png', size: 64, alpha: 'rgba', use: '暗线二幕·真相（知识投下的影子）' },
  { file: 'arc-3.png', size: 64, alpha: 'rgba', use: '暗线三幕·留白（侠客立于门前，门缝一线光）' },
];

/** 纯函数：返回违规清单（空数组 = 通过）。 */
function checkSpec(fileName: string, buf: Buffer, spec: Spec): string[] {
  const bad: string[] = [];
  const p = decodePng(buf);
  const s = pixelStats(p);
  const maxColors = spec.maxColors ?? 32;
  const needsRgba = spec.alpha === 'required' || spec.alpha === 'rgba';

  if (p.width !== spec.size || p.height !== spec.size) {
    bad.push(`${fileName}: 尺寸 ${p.width}×${p.height} ≠ 要求 ${spec.size}×${spec.size}（${spec.use}）`);
  }
  if (p.colorType !== 6 && needsRgba) {
    bad.push(`${fileName}: 需要 RGBA（colorType 6），实际 ${p.colorType}`);
  }
  if (p.colorType === 6 && spec.alpha === 'forbidden') {
    bad.push(`${fileName}: 需要不透明 RGB（colorType 2），实际带 alpha 通道`);
  }
  if (spec.alpha === 'required' && s.opaque === 0) {
    bad.push(`${fileName}: 全透明，sprite 无内容`);
  }
  if (spec.alpha === 'required' && s.opaque === p.width * p.height) {
    bad.push(`${fileName}: 无任何透明像素，sprite 会带底色方块`);
  }
  if (s.colors > maxColors) {
    bad.push(`${fileName}: 调色板 ${s.colors} 色 > 上限 ${maxColors}`);
  }
  if (s.transparentVariants > 1) {
    bad.push(`${fileName}: 透明区有 ${s.transparentVariants} 种隐藏 RGB（应统一为 0,0,0,0）`);
  }
  if (s.semiAlpha > 0) {
    bad.push(`${fileName}: 存在 ${s.semiAlpha} 个半透明像素（像素风禁半透明过渡）`);
  }
  return bad;
}

/** HTML 里出现的资源引用（assets/**），用于「改了文件名没改引用」的防呆。 */
function assetRefsInHtml(html: string): string[] {
  const out: string[] = [];
  const re = /assets\/[A-Za-z0-9._\-/]+\.(?:png|jpe?g|webp|gif|svg|ogg|mp3|wav|json)/g;
  for (const m of html.match(re) ?? []) out.push(m);
  return out;
}

/**
 * 从叙事 JSON 里**扫**出全部 art 引用（不硬编码文件名）：
 * 给 prologue.json / arc.json 增加第 9 屏或第 4 幕时，这条断言自动覆盖新条目——
 * 这正是 m-9（arc.json 引用了不存在的 arc-N.png）想要的回归钉子。
 */
function artPathsIn(json: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'art' && typeof value === 'string') out.push(value);
        else visit(value);
      }
    }
  };
  visit(json);
  return out;
}

/** 引用解析：返回不存在的那些（空数组 = 全部可加载）。 */
function missingRefs(root: string, refs: string[]): string[] {
  return refs.filter((ref) => !existsSync(resolve(root, ref)));
}

function readNarrative(file: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, 'assets/narrative', file), 'utf8'));
}

// ---------------------------------------------------------------------------
// 契约用例
// ---------------------------------------------------------------------------

describe('assets/sprites 契约（存在性 / 尺寸 / 色型 / 调色板）', () => {
  it('全部 18 张 PNG 存在且各自满足规格', () => {
    const failures: string[] = [];
    for (const spec of SPRITE_SPECS) {
      const buf = png(spec.file);
      expect(buf.length, `${spec.file} 不应为空`).toBeGreaterThan(0);
      failures.push(...checkSpec(spec.file, buf, spec));
    }
    expect(failures).toEqual([]);
  });

  it('hero 32×32、mob 32×32、boss/bg/prologue 64×64（尺寸表逐条复核）', () => {
    for (const spec of SPRITE_SPECS) {
      const p = decodePng(png(spec.file));
      expect([spec.file, p.width, p.height]).toEqual([spec.file, spec.size, spec.size]);
    }
  });

  it('hero/mob/boss 是带 alpha 的 RGBA 且调色板 ≤32', () => {
    const combat = SPRITE_SPECS.filter((s) => s.file.startsWith('hero') || s.file.startsWith('mob') || s.file.startsWith('boss'));
    expect(combat).toHaveLength(9);
    for (const spec of combat) {
      const p = decodePng(png(spec.file));
      expect(p.colorType, `${spec.file} colorType`).toBe(6);
      expect(pixelStats(p).colors, `${spec.file} 颜色数`).toBeLessThanOrEqual(32);
    }
  });

  it('bg-arena 无 alpha 通道且完全不透明（T11 平铺铺满舞台，不能有洞）', () => {
    const p = decodePng(png('bg-arena.png'));
    expect(p.colorType).toBe(2);
    const s = pixelStats(p);
    expect(s.semiAlpha).toBe(0);
    expect(s.transparentVariants).toBe(0);
  });

  it('bg-arena 四周接缝在统计意义上不可见（可平铺判据，阈值已标定）', () => {
    const st = seamStats(decodePng(png('bg-arena.png')));
    // 为什么不是"逐像素比第 63 列与第 0 列"：无缝平铺时接缝是**内容的延续**，裂纹/碎石本来就
    // 跨缝，要求两侧像素相等是错的期望（第一版就栽在这里）。可平铺图真正可测的性质是统计性的：
    // 把 2×2 拼起来后，"缝上的梯度"不该比"图内相邻像素的梯度"更剧烈。
    //   硬边 = 单通道差 ≥ 64 的相邻像素对。
    // 标定（本仓库实测）：真图 E比=0.88、硬边比=0.75；把"只在左边界糊一块暗色、右边界留白"
    // 的假图当 bg-arena 时升到 2.64 / 2.99。阈值 1.5 既不误杀又有牙（见下一条用例）。
    expect(st.energyRatio).toBeLessThanOrEqual(1.5);
    expect(st.hardEdgeRatio).toBeLessThanOrEqual(1.5);
  });

  it('暗线三幕是 RGBA 且调色板 ≤32（T8 的 codex 按带 alpha 的插画加载）', () => {
    const arcs = SPRITE_SPECS.filter((s) => s.file.startsWith('arc-'));
    expect(arcs).toHaveLength(3);
    for (const spec of arcs) {
      const p = decodePng(png(spec.file));
      expect(p.colorType, `${spec.file} colorType`).toBe(6);
      expect(pixelStats(p).colors, `${spec.file} 颜色数`).toBeLessThanOrEqual(32);
    }
  });

  it('目检拼图 _contact-sheet.png 存在', () => {
    expect(png('_contact-sheet.png').length).toBeGreaterThan(1000);
  });
});

describe('引用完整性（index.html / prologue.json / arc.json / 清单）', () => {
  it('prologue.json 的每个 art 路径都真实存在，且用的是钉死的 8 个文件名', () => {
    const script = readNarrative('prologue.json') as { scenes: { id: string; art: string }[] };
    expect(script.scenes).toHaveLength(8);
    for (const scene of script.scenes) {
      expect(() => readFileSync(resolve(ROOT, scene.art)), `prologue.json 引用的 ${scene.art} 不存在`).not.toThrow();
    }
    const expected = SPRITE_SPECS.filter((s) => s.file.startsWith('prologue-')).map((s) => `${SPRITES}/${s.file}`);
    expect(script.scenes.map((s) => s.art)).toEqual(expected);
  });

  it('arc.json 的每个 art 路径都真实存在（扫 JSON，不硬编码文件名；T8 评审 m-9 的回归钉子）', () => {
    const refs = artPathsIn(readNarrative('arc.json'));
    expect(refs.length, 'arc.json 里应有 3 幕的 art 引用，扫到的数量不对').toBe(3);
    expect(missingRefs(ROOT, refs), 'arc.json 引用了不存在的素材').toEqual([]);
    // 反向也钉住：契约里声明的 arc-N 必须都被 arc.json 引用（防止"图出了但没接线"）。
    const declared = SPRITE_SPECS.filter((s) => s.file.startsWith('arc-')).map((s) => `${SPRITES}/${s.file}`);
    expect(new Set(refs)).toEqual(new Set(declared));
  });

  it('index.html 引用的每个 assets 路径都存在（当前为 0 条，防呆性质）', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    for (const ref of assetRefsInHtml(html)) {
      expect(() => readFileSync(resolve(ROOT, ref)), `index.html 引用的 ${ref} 不存在`).not.toThrow();
    }
  });

  it('契约覆盖的素材清单与生成器产出一致（新增素材忘了加契约 → 这里红）', () => {
    const listed = new Set(SPRITE_SPECS.map((s) => s.file));
    const gen = readFileSync(resolve(ROOT, 'scripts/gen-sprites.mjs'), 'utf8');
    const declared = [...gen.matchAll(/['"]([a-z0-9_-]+\.png)['"]/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      if (name === '_contact-sheet.png') continue;
      expect(listed.has(name), `gen-sprites.mjs 产出 ${name} 但契约未覆盖`).toBe(true);
    }
  });

  it('生成脚本与 README 都在位（素材可复现，不是手工 P 图）', () => {
    expect(() => readFileSync(resolve(ROOT, 'scripts/gen-sprites.mjs'))).not.toThrow();
    const readme = readFileSync(resolve(ROOT, 'assets/README.md'), 'utf8');
    expect(readme).toContain('node scripts/gen-sprites.mjs');
    for (const spec of SPRITE_SPECS) expect(readme).toContain(spec.file);
  });
});

// ---------------------------------------------------------------------------
// 判别力自检：用内存里伪造的假 PNG 证明断言真的会红（不依赖磁盘素材）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 伪造一张 8 位 RGBA PNG（filter 0），用于判别力取证。 */
function fakeRgbaPng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      row[1 + x * 4] = r;
      row[2 + x * 4] = g;
      row[3 + x * 4] = b;
      row[4 + x * 4] = a;
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 伪造一张 8 位不透明 RGB PNG（filter 0），用于判别力取证。 */
function fakeRgbPng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('判别力自检（解码器 + 规格判据对假图必须报红）', () => {
  const heroSpec: Spec = { file: 'hero.png', size: 32, alpha: 'required', use: '假图取证' };

  it('解码器读得回真实像素（往返自证）', () => {
    const buf = fakeRgbaPng(4, 3, (x, y) => [x * 10, y * 20, 7, x === 0 && y === 0 ? 0 : 255]);
    const p = decodePng(buf);
    expect([p.width, p.height, p.colorType]).toEqual([4, 3, 6]);
    expect(Array.from(p.rgba.subarray(0, 4))).toEqual([0, 0, 7, 0]);
    const i = (0 * 4 + 1) * 4;
    expect(Array.from(p.rgba.subarray(i, i + 4))).toEqual([10, 0, 7, 255]);
  });

  it('尺寸不对的假图 → 报违规', () => {
    const buf = fakeRgbaPng(16, 16, () => [20, 20, 20, 255]);
    const bad = checkSpec('hero.png', buf, heroSpec);
    expect(bad.some((b) => b.includes('尺寸'))).toBe(true);
  });

  it('33 色的假图 → 报违规（阈值判据真的有牙）', () => {
    // 33 个不重复 RGB，塞进 32×32，其中一列留透明。
    const colors = Array.from({ length: 33 }, (_, i) => [i * 7, 255 - i * 5, 40 + i * 3] as const);
    const buf = fakeRgbaPng(32, 32, (x, y) => {
      if (x === 0) return [0, 0, 0, 0];
      const c = colors[(y * 31 + x) % 33];
      return [c[0], c[1], c[2], 255];
    });
    const stats = pixelStats(decodePng(buf));
    expect(stats.colors).toBeGreaterThan(32);
    const bad = checkSpec('hero.png', buf, heroSpec);
    expect(bad.some((b) => b.includes('调色板'))).toBe(true);
  });

  it('32 色的假图 → 不报调色板违规（不误杀）', () => {
    const colors = Array.from({ length: 32 }, (_, i) => [i * 7, 200 - i * 5, 40 + i * 3] as const);
    const buf = fakeRgbaPng(32, 32, (x, y) => {
      if (x === 0) return [0, 0, 0, 0];
      const c = colors[(y * 31 + x) % 32];
      return [c[0], c[1], c[2], 255];
    });
    const bad = checkSpec('hero.png', buf, heroSpec);
    expect(bad.filter((b) => b.includes('调色板'))).toEqual([]);
  });

  it('无透明像素 / 半透明像素 / 带 alpha 的背景 → 各自报违规', () => {
    const solid = fakeRgbaPng(32, 32, () => [10, 10, 10, 255]);
    expect(checkSpec('hero.png', solid, heroSpec).some((b) => b.includes('无任何透明像素'))).toBe(true);

    const semi = fakeRgbaPng(32, 32, (x) => [10, 10, 10, x === 0 ? 0 : 128]);
    expect(checkSpec('hero.png', semi, heroSpec).some((b) => b.includes('半透明'))).toBe(true);

    const bgBuf = fakeRgbaPng(64, 64, () => [10, 10, 10, 255]);
    const bgSpec: Spec = { file: 'bg-arena.png', size: 64, alpha: 'forbidden', use: '假图取证' };
    expect(checkSpec('bg-arena.png', bgBuf, bgSpec).some((b) => b.includes('不透明 RGB'))).toBe(true);
  });

  it('把 bg-arena 换成"只在边界内侧糊暗块、对边留白"的假图 → 平铺判据报红', () => {
    const paper: [number, number, number] = [216, 207, 184];
    const cut = fakeRgbPng(64, 64, (x, y) => {
      if (x < 9 && y >= 18 && y < 46) return [14, 17, 22];
      if (y < 4 && x >= 20 && x < 40) return [16, 20, 26];
      return paper;
    });
    const st = seamStats(decodePng(cut));
    expect(st.energyRatio).toBeGreaterThan(1.5);
    expect(st.hardEdgeRatio).toBeGreaterThan(1.5);
  });

  it('叙事 JSON 扫描器：缺失的 art 引用会被发现（m-9 的内存复现，不依赖磁盘）', () => {
    const fakeArc = {
      acts: [
        { act: 1, art: 'assets/sprites/arc-1.png' },
        { act: 4, art: 'assets/sprites/arc-4.png' },
      ],
    };
    const refs = artPathsIn(fakeArc);
    expect(refs).toEqual(['assets/sprites/arc-1.png', 'assets/sprites/arc-4.png']);
    expect(missingRefs(ROOT, refs)).toEqual(['assets/sprites/arc-4.png']);
    // 任意层级的 art 都要扫到（prologue.json 是 { scenes: [...] }，未来嵌套更深也不能漏）
    expect(artPathsIn({ scenes: [{ art: 'a.png' }], meta: { art: 'b.png' } })).toEqual(['a.png', 'b.png']);
  });

  it('index.html 引用扫描器：坏引用会被发现（扫描器非空转）', () => {
    const refs = assetRefsInHtml('<img src="assets/sprites/hero.png"><link href="assets/x.css">');
    expect(refs).toEqual(['assets/sprites/hero.png']);
    expect(() => readFileSync(resolve(ROOT, refs[0]))).not.toThrow();
    expect(() => readFileSync(resolve(ROOT, 'assets/sprites/definitely-missing.png'))).toThrow();
  });
});
