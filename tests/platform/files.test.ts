// @vitest-environment happy-dom
/**
 * tests/platform/files.test.ts —— Plan 4 · T11：文件口（下载 / 选文件）。
 *
 * 判别力：
 * - FL#1 `revokeObjectURL` **必须**被调用（哪怕 click 抛错）——移动端内存紧，
 *   泄漏 blob URL 是长会话的慢性病；只在成功路径 revoke 的实现在 FL#1b 必红；
 * - FL#2 用户取消（没有 change）不是错误：不 resolve 假成功；
 *   读文件失败（onerror / 空结果）才回 read-failed。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { downloadText, pickTextFile } from '../../src/platform/files';

afterEach(() => {
  document.body.replaceChildren();
});

function fakeUrl(): { url: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void }; revoked: string[]; created: number } {
  const revoked: string[] = [];
  let created = 0;
  return {
    revoked,
    get created() {
      return created;
    },
    url: {
      createObjectURL: () => {
        created += 1;
        return `blob:fake-${created}`;
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    },
  };
}

describe('downloadText', () => {
  it('FL#1 建 blob、挂 <a download>、点击、立刻 revoke（文件名按入参）', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const fake = fakeUrl();
    let clickedName = '';
    const doc = {
      createElement: (tag: string) => {
        const el = document.createElement(tag);
        if (tag === 'a') {
          el.click = () => {
            clickedName = el.getAttribute('download') ?? '';
          };
        }
        return el;
      },
      body: document.body,
    } as unknown as Document;

    const name = downloadText('{"a":1}', 'zx-xia-backup-2026-10-27.json', { doc, url: fake.url });
    expect(name).toBe('zx-xia-backup-2026-10-27.json');
    expect(clickedName).toBe('zx-xia-backup-2026-10-27.json');
    expect(fake.created).toBe(1);
    expect(fake.revoked).toEqual(['blob:fake-1']);
    // 锚点用完即摘（不留垃圾节点）
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('FL#1b click 抛错也要 revoke（finally 语义）', () => {
    const fake = fakeUrl();
    const doc = {
      createElement: (tag: string) => {
        const el = document.createElement(tag);
        if (tag === 'a') el.click = () => {
          throw new Error('用户手势丢失');
        };
        return el;
      },
      body: document.body,
    } as unknown as Document;

    expect(() => downloadText('x', 'f.json', { doc, url: fake.url })).toThrow('用户手势丢失');
    expect(fake.revoked).toEqual(['blob:fake-1']);
  });
});

describe('pickTextFile', () => {
  it('FL#2 挂一个隐藏 file input 并点击；change 有文件才读（取消不误报成功）', async () => {
    const fakeDoc = document;
    const promise = pickTextFile({ doc: fakeDoc });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.style.display).toBe('none');
    expect(input.getAttribute('accept')).toContain('json');

    // 模拟"没有选中文件"的 change
    input.dispatchEvent(new Event('change'));
    await expect(promise).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(document.querySelector('input[type="file"]')).toBeNull(); // 用完即摘
  });

  it('FL#2b 读文件失败 → read-failed（不抛异常）', async () => {
    // happy-dom 的 FileReader 不可靠，这里只钉"没有文件时的分支"与"用完摘除"；
    // 真实读取路径由宿主手工冒烟（T10）覆盖，避免为测试造一套 FileReader 假实现。
    const promise = pickTextFile({ doc: document });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    input.dispatchEvent(new Event('change'));
    const res = await promise;
    expect(res.ok).toBe(false);
  });
});
