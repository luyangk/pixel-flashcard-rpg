/**
 * shareIntake.ts —— Plan 8 · T8：把系统"分享进来"的 query 读成一个干净对象（纯函数）。
 *
 * ## 手机上的用法
 * 把 PWA 装到主屏后，在微信/浏览器里对一篇文章点「分享 → 知识侠客」，系统会把
 * 标题/正文/链接按 `manifest.webmanifest` 的 `share_target.params` 拼成 query，
 * 交给我们的 `start_url`。于是"公众号文章"这条最常用的路只需要两步：
 * **分享 → 在采新卡里确认**（正文能带过来就带，带不了就只剩链接，界面会照实说）。
 *
 * ## 为什么只有 Android Chrome 有效
 * `share_target` 是 PWA 的能力，只有**装到主屏**的 Android Chrome 支持；iOS Safari 不支持。
 * README 里如实写了这一点（不承诺做不到的事）。
 *
 * ## 本层只做清洗
 * 读参数、trim、限长、只接受 http(s) 的链接；**不决定**要不要切屏、要不要抓取（那归宿主与 UI）。
 */
import { localDayString } from '@core/reviewLedger'; // eslint-disable-line @typescript-eslint/no-unused-vars

/** 分享正文的长度上限（码点）：query 有长度上限，超长部分由"粘贴"这条路兜底。 */
export const SHARE_TEXT_MAX = 1500;
/** 标题上限（码点）。 */
export const SHARE_TITLE_MAX = 200;

export interface SharedInput {
  readonly url?: string;
  readonly text?: string;
  readonly title?: string;
}

/** 码点安全截断。 */
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

/**
 * 解析 `location.search` 形态的 query。**没有任何可用内容时回 `null`**
 * （宿主据此不做任何事：普通冷启动不该被"分享"逻辑打扰）。
 */
export function parseShareQuery(search: string): SharedInput | null {
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  if (raw.trim().length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const pick = (key: string): string => (params.get(key) ?? '').trim();

  const urlRaw = pick('share_url');
  const url = /^https?:\/\//i.test(urlRaw) ? urlRaw : undefined;
  const textRaw = pick('share_text');
  const text = textRaw.length > 0 ? clip(textRaw, SHARE_TEXT_MAX) : undefined;
  const titleRaw = pick('share_title');
  const title = titleRaw.length > 0 ? clip(titleRaw, SHARE_TITLE_MAX) : undefined;

  if (url === undefined && text === undefined && title === undefined) return null;
  return {
    ...(url === undefined ? {} : { url }),
    ...(text === undefined ? {} : { text }),
    ...(title === undefined ? {} : { title }),
  };
}
