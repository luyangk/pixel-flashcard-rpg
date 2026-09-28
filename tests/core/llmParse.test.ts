/**
 * tests/core/llmParse.test.ts —— Plan 5 · T1：不可信模型输出的严格解析。
 *
 * 判别力（每条都对着"宽松实现会怎样红"写）：
 * - LP#2 前后废话/围栏：用贪婪正则取 JSON 的实现会把说明文字一起吃进去 ⇒ 解析失败 ⇒ 红；
 * - LP#3 超长与控制字符：不剥控制字符、不截断的实现会把这些原样带进存档；
 * - LP#5 条数封顶：不封顶的实现会把 500 条全收下（并让 UI 卡住）；
 * - LP#7 脏键/原型：`{"__proto__": ...}` 不该影响结果，也不该抛。
 */
import { describe, expect, it } from 'vitest';
import {
  CARDS_MAX,
  EGG_MAX,
  extractJson,
  parseCards,
  parseEgg,
  parseNames,
} from '../../src/core/llmParse';

describe('extractJson —— 从废话里取第一段完整 JSON', () => {
  it('LP#1 纯 JSON、```json 围栏、前后夹说明都取得到', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual({ ok: true, value: [{ a: 1 }] });
    expect(extractJson('好的，这是结果：\n[{"a":1}]\n希望有用！')).toEqual({ ok: true, value: [{ a: 1 }] });
  });

  it('LP#2 嵌套与字符串里的括号不会截错（贪婪正则实现在这条上红）', () => {
    const text = '说明：[{"front":"集合 {a,b} 的写法","back":"用花括号列元素"}] 结束';
    const got = extractJson(text);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual([{ front: '集合 {a,b} 的写法', back: '用花括号列元素' }]);

    // 字符串里出现转义引号也要稳
    const esc = extractJson('[{"front":"他说\\"你好\\"","back":"b"}]');
    expect(esc.ok).toBe(true);
    if (esc.ok) expect(esc.value).toEqual([{ front: '他说"你好"', back: 'b' }]);
  });

  it('LP#2b 括号不配对 / 没有 JSON / 空串 → ok:false 且给人话', () => {
    for (const bad of ['[{"a":1}',
      '这里没有 JSON',
      '',
      '   ',
    ]) {
      const got = extractJson(bad);
      expect(got.ok, JSON.stringify(bad)).toBe(false);
      if (!got.ok) expect(got.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('parseCards —— 卡片候选', () => {
  it('LP#3 正常解析；字段别名（question/answer）也认；tags 去重去空', () => {
    const got = parseCards(
      '[{"front":"f1","back":"b1","tags":["历史","历史","","唐诗"]},{"question":"q2","answer":"a2"}]',
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value).toEqual([
      { front: 'f1', back: 'b1', tags: ['历史', '唐诗'] },
      { front: 'q2', back: 'a2', tags: [] },
    ]);
    expect(got.truncated).toBe(false);
  });

  it('LP#3b 超长字段被截断、控制字符与零宽字符被剥掉（宽松实现原样入库 ⇒ 红）', () => {
    const long = '字'.repeat(500);
    const got = parseCards(`[{"front":"a\\u0000b\\u200bc","back":"${long}"}]`);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value[0].front).toBe('a b c'); // \u0000 与零宽 → 空格（再折叠）
    expect([...got.value[0].back].length).toBe(200);
  });

  it('LP#4 半截卡（缺 front 或 back / 空串）被丢弃；全丢 ⇒ ok:false', () => {
    const partial = parseCards('[{"front":"f","back":""},{"front":"","back":"b"},{"front":"ok","back":"a"}]');
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.value).toEqual([{ front: 'ok', back: 'a', tags: [] }]);

    const allBad = parseCards('[{"front":"","back":""},null,42]');
    expect(allBad.ok).toBe(false);
    if (!allBad.ok) expect(allBad.reason).toContain('一条可用的都没有');
  });

  it('LP#5 条数封顶并在返回值里申报截断（不封顶的实现收下 500 条 ⇒ 红）', () => {
    const many = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ front: `f${i}`, back: `b${i}` })));
    const got = parseCards(many);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value).toHaveLength(CARDS_MAX);
    expect(got.truncated).toBe(true); // 如实申报，不静默丢

    const custom = parseCards(many, { max: 3 });
    if (custom.ok) expect(custom.value).toHaveLength(3);
  });

  it('LP#6 非数组的单个对象按"一张卡"处理（模型偶尔如此）；标量数组长度也算', () => {
    const single = parseCards('{"front":"f","back":"b"}');
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.value).toHaveLength(1);

    const strings = parseCards('["不是对象","也不是对象"]');
    expect(strings.ok).toBe(false); // 字符串不是卡
  });

  it('LP#7 脏键与原型污染尝试不影响结果、不抛', () => {
    const evil = '[{"front":"f","back":"b","__proto__":{"polluted":true},"constructor":{"x":1}}]';
    const got = parseCards(evil);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value[0]).toEqual({ front: 'f', back: 'b', tags: [] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // 也不是所有输入都能让本模块抛
    for (const weird of [null as unknown as string, undefined as unknown as string, 42 as unknown as string]) {
      expect(() => parseCards(weird)).not.toThrow();
    }
  });
});

describe('parseNames —— 称号候选', () => {
  it('LP#8 支持字符串数组与对象数组两种形状；空/超长被清掉', () => {
    const asStrings = parseNames('["烟火篇·卷灵","长安篇·卷灵",""]');
    expect(asStrings.ok).toBe(true);
    if (asStrings.ok) expect(asStrings.value).toEqual([{ name: '烟火篇·卷灵' }, { name: '长安篇·卷灵' }]);

    const asObjects = parseNames('{"names":1}');
    expect(asObjects.ok).toBe(false); // 没有可用名字

    const long = parseNames(JSON.stringify([{ name: '称'.repeat(60) }]));
    if (long.ok) expect([...long.value[0].name].length).toBe(30);
  });

  it('LP#8b 条数封顶 5 条', () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => `名字${i}`));
    const got = parseNames(many);
    if (got.ok) {
      expect(got.value).toHaveLength(5);
      expect(got.truncated).toBe(true);
    }
  });
});

describe('parseEgg —— 彩蛋正文（唯一允许纯文本的入口）', () => {
  it('LP#9 纯文本、围栏、JSON 包装、带前缀都能取到正文', () => {
    expect(parseEgg('闪电与雷声本是同一件事。')).toEqual({ ok: true, text: '闪电与雷声本是同一件事。' });
    expect(parseEgg('```\n彩蛋：李杜并称。\n```')).toEqual({ ok: true, text: '李杜并称。' });
    expect(parseEgg('{"text":"包装在 JSON 里的正文"}')).toEqual({ ok: true, text: '包装在 JSON 里的正文' });
    expect(parseEgg('图鉴彩蛋：《庄子》每下愈况。')).toEqual({ ok: true, text: '《庄子》每下愈况。' });
  });

  it('LP#9b 空/纯空白/超长：前者拒，后者截断', () => {
    expect(parseEgg('   ').ok).toBe(false);
    expect(parseEgg('```\n```').ok).toBe(false);
    const long = parseEgg('字'.repeat(500));
    if (long.ok) expect([...long.text].length).toBe(EGG_MAX);
  });

  it('LP#9c 控制字符被剥掉（含方向控制符——它能在屏上伪装文本顺序）', () => {
    const got = parseEgg('正文\u202e反着写\u0000 结束');
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.text).not.toContain('\u202e');
      expect(got.text).not.toContain('\u0000');
      expect(got.text).toContain('正文');
    }
  });
});
