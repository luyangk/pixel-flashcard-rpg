/**
 * tests/app/shareIntake.test.ts —— Plan 8 · T8：分享进来的参数解析（纯函数）。
 *
 * 场景：手机 Chrome 把 PWA 装到主屏后，在微信/浏览器里对一篇文章点「分享 → 知识侠客」，
 * 系统会把标题/正文/链接拼成 query 交给我们的 `start_url`。这一层只负责**把 query 读成
 * 一个干净的对象**（其余归 UI）。
 *
 * 判别力：
 * - ST#2 无参数 ⇒ null（宿主据此不切屏：普通打开不该跳到采新卡）；
 * - ST#3 `share_url` 不是 http(s) ⇒ 丢该字段（不能让 `javascript:` 进功能区）；
 * - ST#4 超长正文按**码点**截断（系统分享会塞很长的 text，query 有长度上限）；
 * - ST#5 只有标题也算"有分享内容"（不能因为没链接没正文就当没有）。
 */
import { describe, expect, it } from 'vitest';
import { SHARE_TEXT_MAX, parseShareQuery } from '../../src/app/shareIntake';

const q = (parts: Record<string, string>): string =>
  `?${Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')}`;

describe('parseShareQuery', () => {
  it('ST#1 三个参数都解析出来', () => {
    const got = parseShareQuery(q({ share_url: 'https://x.example/a', share_text: '正文', share_title: '标题' }));
    expect(got).toEqual({ url: 'https://x.example/a', text: '正文', title: '标题' });
  });

  it('ST#2 没有参数 / 全是空 ⇒ null', () => {
    expect(parseShareQuery('')).toBeNull();
    expect(parseShareQuery('?')).toBeNull();
    expect(parseShareQuery('?foo=bar')).toBeNull();
    expect(parseShareQuery(q({ share_url: '   ', share_text: '', share_title: '  ' }))).toBeNull();
  });

  it('ST#3 share_url 只接受 http(s)', () => {
    // 只有一个非法链接 ⇒ 等于什么都没分享（宿主据此**不切屏**，比给个空对象更有用）
    expect(parseShareQuery(q({ share_url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseShareQuery(q({ share_url: 'data:text/html,x' }))).toBeNull();
    expect(parseShareQuery(q({ share_url: 'https://ok.example/x' }))).toEqual({ url: 'https://ok.example/x' });
    // 有别的可用字段时，非法 url 被丢但对象仍成立
    expect(parseShareQuery(q({ share_url: 'file:///etc/passwd', share_title: '标题' }))).toEqual({ title: '标题' });
  });

  it('ST#4 正文按码点截到 SHARE_TEXT_MAX（不劈开代理对）', () => {
    const long = `A${'🐉'.repeat(SHARE_TEXT_MAX + 10)}`;
    const got = parseShareQuery(q({ share_text: long }));
    const text = got?.text ?? '';
    expect([...text].length).toBe(SHARE_TEXT_MAX);
    expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
  });

  it('ST#5 只有标题 / 只有正文 都算有内容', () => {
    expect(parseShareQuery(q({ share_title: '只有标题' }))).toEqual({ title: '只有标题' });
    expect(parseShareQuery(q({ share_text: '只有正文' }))).toEqual({ text: '只有正文' });
  });

  it('ST#6 前导 ? 可有可无（location.search 与手写 query 都能吃）', () => {
    expect(parseShareQuery('share_text=x')).toEqual({ text: 'x' });
    expect(parseShareQuery('?share_text=x')).toEqual({ text: 'x' });
    expect(parseShareQuery('?share_text=%E4%B8%AD%E6%96%87')).toEqual({ text: '中文' });
  });
});
