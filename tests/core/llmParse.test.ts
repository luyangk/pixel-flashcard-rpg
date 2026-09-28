/**
 * tests/core/llmParse.test.ts —— Plan 5 · T1 + Plan 6 · T2：不可信模型输出的严格解析。
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
  CHOICES_MAX,
  CHOICE_TEXT_MAX,
  EGG_MAX,
  extractJson,
  parseCards,
  parseEgg,
  parseNames,
  parseVerdict,
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
      { front: 'f1', back: 'b1', tags: ['历史', '唐诗'], choices: [] },
      { front: 'q2', back: 'a2', tags: [], choices: [] },
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
    if (partial.ok) expect(partial.value).toEqual([{ front: 'ok', back: 'a', tags: [], choices: [] }]);

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

  it('LP#6b 截断按**码点**：emoji 不会被劈成半个字符（`.slice` 实现必红）', () => {
    const emojiField = '🐉'.repeat(300); // 300 个码点 / 600 个 UTF-16 单元
    const got = parseCards(`[{"front":"f","back":"${emojiField}"}]`);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const back = got.value[0].back;
    expect([...back].length).toBe(200); // 码点数被截到上限
    // 没有被劈开的代理对：末尾不能是孤立的高代理
    expect(/[\uD800-\uDBFF]$/.test(back)).toBe(false);
    expect([...back].every((ch) => ch === '🐉')).toBe(true); // 每个字符都完整

    // 称号同样按码点（30 个 emoji 才是上限，而不是 15 个）
    const names = parseNames(JSON.stringify([{ name: '🐉'.repeat(40) }]));
    if (names.ok) expect([...names.value[0].name].length).toBe(30);
  });

  it('LP#7 脏键与原型污染尝试不影响结果、不抛', () => {
    const evil = '[{"front":"f","back":"b","__proto__":{"polluted":true},"constructor":{"x":1}}]';
    const got = parseCards(evil);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value[0]).toEqual({ front: 'f', back: 'b', tags: [], choices: [] });
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

  it('LP#10 安全评审 I-1 的五族不可见字符：双向隔离符/ALM/软连字符/Hangul filler/行间注记全剥', () => {
    // 每族一个代表：U+2066–2069（双向隔离）、U+061C、U+00AD、U+3164、U+FFF9
    const dirty = 'a\u2066b\u2069c\u061cd\u00ade\u3164f\ufff9g';
    const card = parseCards(`[{"front":"${dirty}","back":"b","tags":["x\u00ady"]}]`);
    expect(card.ok).toBe(true);
    if (card.ok) {
      for (const ch of ['\u2066', '\u2069', '\u061c', '\u00ad', '\u3164', '\ufff9']) {
        expect(card.value[0].front.includes(ch), `未剥掉 ${ch}`).toBe(false);
      }
      expect(card.value[0].tags[0]).not.toContain('\u00ad');
    }

    // 彩蛋路径同样（这曾是一份复刻的正则，两处会一起漏——现在同源）
    const egg = parseEgg('正文\u2066ABC\u2069结束\u3164');
    expect(egg.ok).toBe(true);
    if (egg.ok) {
      expect(egg.text).not.toContain('\u2066');
      expect(egg.text).not.toContain('\u3164');
      expect(egg.text).toContain('正文');
    }
  });

  it('LP#11 parseEgg 的 JSON 分支取不到正文时**拒绝**，不把 JSON 原文当彩蛋（评审 m-4）', () => {
    const got = parseEgg('{"error":"rate limited"}');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain('没有正文');
  });

  it('LP#12 opts 显式传 null 也不抛（"永不抛"是文件头写下的契约；评审 m-1）', () => {
    expect(() => parseCards('[{"front":"f","back":"b"}]', null as never)).not.toThrow();
    expect(() => parseNames('["x"]', null as never)).not.toThrow();
    const cards = parseCards('[{"front":"f","back":"b"}]', null as never);
    if (cards.ok) expect(cards.value).toHaveLength(1); // 回落默认上限
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

/* ------------------------------------------------------------------ Plan 6 · T2 */

/**
 * 判卷结果与「卡片自带干扰项」的严格解析（Plan 6 · T2）。
 *
 * 判别力：
 * - PV#2/3 `match` **必须是布尔**：`"true"` / `1` / 缺失一律拒 —— 用
 *   `String(x).includes('true')` 之类的嗅探实现会把 `{"match":"not true"}` 判成"答对"（红）；
 * - PV#4 `missing` 必须逐项净化（null/空串/重复/超长/控制字符）；
 * - PV#4b `missing` 是字符串（不是数组）⇒ 视作没有，不拒（模型的常见偏差）；
 * - PCh#2 `choices` 与 `back` 相同 ⇒ 剔除（否则选项里会出现"正确答案"本身）。
 */
describe('parseVerdict —— 判卷结果（Plan 6 · T2）', () => {
  it('PV#1 标准结果：对/错 + 理由 + 缺失要点', () => {
    const got = parseVerdict('{"match":true,"reason":"抓住了要点","missing":[]}');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.match).toBe(true);
    expect(got.value.reason).toBe('抓住了要点');
    expect(got.value.missing).toEqual([]);

    const bad = parseVerdict('```json\n{"match":false,"reason":"漏了作者","missing":["作者","朝代"]}\n```');
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.value.match).toBe(false);
    expect(bad.value.missing).toEqual(['作者', '朝代']);
  });

  it('PV#2 match 不是布尔 ⇒ 拒绝（字符串 "true" / 数字 1 / null）', () => {
    for (const raw of ['{"match":"true"}', '{"match":1}', '{"match":null}', '{"match":[]}']) {
      const got = parseVerdict(raw);
      expect(got.ok, raw).toBe(false);
      if (!got.ok) expect(got.reason).toContain('判定');
    }
  });

  it('PV#3 缺 match ⇒ 拒绝；非 JSON / 空串也不抛', () => {
    for (const raw of ['{"reason":"x"}', '不是 JSON', '', '   ', '{"match"']) {
      expect(parseVerdict(raw).ok).toBe(false);
    }
    expect(() => parseVerdict(null as never)).not.toThrow();
    expect(() => parseVerdict(undefined as never)).not.toThrow();
  });

  it('PV#4 missing 逐项净化：null/空串/重复/超长/控制字符', () => {
    const got = parseVerdict(
      '{"match":false,"reason":"差一点","missing":["作者",null,"作者","","  ",3,"' + '长'.repeat(200) + '"]}',
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.missing).toHaveLength(2); // 去重 + 剔空 + 非字符串剔除
    expect(got.value.missing[0]).toBe('作者');
    expect(Array.from(got.value.missing[1]).length).toBeLessThanOrEqual(60);
  });

  it('PV#4b missing 是字符串或缺失 ⇒ 视作没有要点（不因此拒绝）', () => {
    for (const raw of ['{"match":true}', '{"match":true,"missing":"作者"}', '{"match":true,"missing":null}']) {
      const got = parseVerdict(raw);
      expect(got.ok, raw).toBe(true);
      if (got.ok) expect(got.value.missing).toEqual([]);
    }
  });

  it('PV#4c missing 超过 5 条 ⇒ 只留 5 条（上限本身就是"不可信"的一部分）', () => {
    const raw = JSON.stringify({ match: false, missing: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const got = parseVerdict(raw);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.missing).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('PV#5 理由里的方向控制符被剥掉、超长按码点截断', () => {
    const got = parseVerdict(`{"match":false,"reason":"反着写\\u202e再来","missing":[]}`);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.reason).not.toContain('\u202e');
    const long = parseVerdict(JSON.stringify({ match: true, reason: '甲'.repeat(300) }));
    if (long.ok) expect(Array.from(long.value.reason).length).toBeLessThanOrEqual(120);
  });

  it('PV#6 理由缺失 ⇒ 空串（不是 undefined），保证 UI 直接可用', () => {
    const got = parseVerdict('{"match":true}');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.reason).toBe('');
  });
});

describe('parseCards —— 卡片自带的干扰项 choices（Plan 6 · T2）', () => {
  it('PCh#1 choices 正常项被保留（≤5 条、每条 ≤200 码点）', () => {
    const got = parseCards('[{"front":"f","back":"b","choices":["错1","错2","错3"]}]');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value[0]?.choices).toEqual(['错1', '错2', '错3']);

    const many = parseCards(
      JSON.stringify([{ front: 'f', back: 'b', choices: Array.from({ length: 12 }, (_, i) => `w${i}`) }]),
    );
    if (many.ok) expect(many.value[0]?.choices).toHaveLength(CHOICES_MAX);
  });

  it('PCh#2 与 back 相同 / 空串 / 非字符串 / 重复的干扰项逐项剔除', () => {
    const got = parseCards(
      JSON.stringify([
        { front: 'f', back: '正确', choices: ['正确', ' ', '错1', '错1', 7, null, '错2'] },
      ]),
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value[0]?.choices).toEqual(['错1', '错2']);
  });

  it('PCh#3 choices 缺失或不是数组 ⇒ 空数组（旧模型/旧调用方一字不改）', () => {
    for (const raw of ['[{"front":"f","back":"b"}]', '[{"front":"f","back":"b","choices":"错"}]', '[{"front":"f","back":"b","choices":null}]']) {
      const got = parseCards(raw);
      expect(got.ok, raw).toBe(true);
      if (got.ok) expect(got.value[0]?.choices).toEqual([]);
    }
  });

  it('PCh#4 choices 里超长项按码点截断、控制字符被剥', () => {
    const long = '乙'.repeat(300);
    const got = parseCards(JSON.stringify([{ front: 'f', back: 'b', choices: [`${long}\u202e`] }]));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const c = got.value[0]?.choices?.[0] ?? '';
    expect(Array.from(c).length).toBeLessThanOrEqual(CHOICE_TEXT_MAX);
    expect(c).not.toContain('\u202e');
  });
});
