import { describe, expect, it } from 'vitest';
import { probeCore } from '@core/probe';
import { probePlatform } from '@platform/probe';

describe('path aliases', () => {
  it('resolves @core/* and @platform/* in vitest', () => {
    expect(probeCore()).toBe('core');
    expect(probePlatform()).toBe('platform');
  });
});
