/**
 * tests/assets/narrative.contract.test.ts —— Plan 4 · T8/T11：叙事内容资产的契约。
 *
 * 为什么需要（T8 评审 I-4）：`arc.json`（三幕）与 `eggs.json`（彩蛋）此前**没有任何测试
 * import**，于是"幕数 = 3"这条事实散落在三处独立硬编码里——`arc.json` 的条目数、
 * `validateSave` 的 `arcSeen ≤ 3` 上界、`bossFlow.ARC_MILESTONES` 的长度。加第四幕
 * （或把某一幕写成四句）会静默串版而全绿。本文件把它们**互相钉住**。
 *
 * 对照先例：prologue.json（tests/ui/prologue.test.ts 逐字校验）、beats.json
 * （tests/ui/beats.test.ts）、fake-words.json（tests/ui/result.test.ts）都有内容契约。
 *
 * 纯文本/字节级检查，不依赖 DOM，故用 node 环境（vitest 全局默认）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSave } from '@core/saveMigrate';
import { ARC_MILESTONES } from '../../src/app/bossFlow';
import arcJson from '../../assets/narrative/arc.json';
import eggsJson from '../../assets/narrative/eggs.json';
import presetJson from '../../assets/content/preset.json';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 叙事文本的单句上限（LORE §6：叙事半文半白 ≤30 字；按码点数，emoji 也算一个）。 */
const MAX_LINE = 30;

/** 造一份合法新档（只为验证 arcSeen 的取值域；剧情无关）。 */
function saveWithArcSeen(arcSeen: unknown): unknown {
  return {
    schemaVersion: 1,
    decks: [],
    cards: [],
    settings: {
      bossThresholdTier: 30,
      sm2Params: { initialEase: 2.5, minEase: 1.3, firstInterval: 10 / 60, secondInterval: 6 },
      battle: { defaultPoolSize: 15 },
      progress: { exp: 0 },
      story: { prologueSeen: true, beatIndex: 0, arcSeen },
      leaderboard: [],
      // Plan 6 · T5：作答模式与每日额度进档（迁移器为缺席档补同款缺省；
      // 夹具代表"当前形状的完整档"，缺席会让形状断言把归一化误读成丢字段——
      // 与上面 leaderboard 在 T7 时的理由逐字相同）。
      answerMode: 'choice',
      llmQuota: { day: '', cards: 0, judges: 0 },
    },
    meta: { savedAt: 0, plays: 0 },
  };
}

describe('assets/narrative/arc.json —— 三幕暗线（LORE §5.3）', () => {
  const acts = arcJson.acts;

  it('AN#1 幕数与 bossFlow.ARC_MILESTONES 一致，编号从 1 连续递增', () => {
    expect(acts.length).toBe(ARC_MILESTONES.length);
    expect(acts.map((a) => a.act)).toEqual(acts.map((_, i) => i + 1));
  });

  it('AN#2 每幕 2–3 句，每句 ≤30 码点，且不含具体卡片内容该有的口吻（无问句/答案体）', () => {
    for (const act of acts) {
      expect(Array.isArray(act.lines), `第 ${act.act} 幕缺 lines`).toBe(true);
      expect(act.lines.length, `第 ${act.act} 幕句数`).toBeGreaterThanOrEqual(2);
      expect(act.lines.length, `第 ${act.act} 幕句数`).toBeLessThanOrEqual(3);
      for (const line of act.lines) {
        expect(typeof line).toBe('string');
        expect(line.trim().length).toBeGreaterThan(0);
        expect([...line].length, `超长：${line}`).toBeLessThanOrEqual(MAX_LINE);
        expect(line.endsWith('？'), `叙事句不该带问句体：${line}`).toBe(false);
      }
      expect(act.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('AN#3 每幕插画路径真实存在（T8 评审 m-9 的回归钉：路径写死了却没文件就是 404）', () => {
    for (const act of acts) {
      expect(act.art.startsWith('assets/'), `art 应为仓库相对路径：${act.art}`).toBe(true);
      expect(existsSync(join(REPO_ROOT, act.art)), `缺幕插画：${act.art}`).toBe(true);
    }
  });

  it('AN#4 内容幕数与 arcSeen 取值域**互相钉住**（加第四幕而不同步上界 ⇒ 这里红）', () => {
    const max = acts.length;
    expect(validateSave(saveWithArcSeen(max)).ok, `arcSeen=${max} 应为合法上界`).toBe(true);
    expect(validateSave(saveWithArcSeen(0)).ok).toBe(true);
    expect(validateSave(saveWithArcSeen(max + 1)).ok, 'arcSeen 超过幕数应被拒').toBe(false);
  });
});

describe('assets/narrative/eggs.json —— 图鉴彩蛋（LORE §5.4）', () => {
  it('EG#1 键集合恰为内容种子里的领域 id（改名/加领域而不同步 ⇒ 这里红）', () => {
    const presetIds = presetJson.decks.map((d) => d.id).sort();
    expect(Object.keys(eggsJson.eggs).sort()).toEqual(presetIds);
  });

  it('EG#2 每条都非空、是纯阅读向短文（不许出现游戏数值口径的词，但"经验"这种日常词不算）', () => {
    for (const [id, text] of Object.entries(eggsJson.eggs)) {
      expect(typeof text, id).toBe('string');
      expect(text.trim().length, id).toBeGreaterThan(10);
      expect(text.length, `${id} 太长，图鉴条目应是短文`).toBeLessThanOrEqual(200);
      // 只判**游戏数值口径**的词：第一版把 "这条经验" 里的日常义 "经验" 也判成违规（假红），
      // 故收紧为带数值语境的形态（经验值 / 经验+ / 伤害 / 战力 / 血量 / HP）。
      expect(/经验值|经验\s*[+＋]|伤害|战力|血量|\bHP\b/.test(text), `${id} 疑似带游戏数值口径`).toBe(false);
    }
  });

  it('EG#3 引导领域（生活常识）必须有彩蛋——它是新玩家唯一会先净化的领域', () => {
    expect(typeof eggsJson.eggs['preset-life']).toBe('string');
    expect(eggsJson.eggs['preset-life'].length).toBeGreaterThan(0);
  });
});
