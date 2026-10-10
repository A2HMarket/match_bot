import { describe, expect, it } from 'vitest';
import { createMatchAgent, londonToday } from '../src/agent.js';

describe('londonToday', () => {
  it('gives the weekday and ISO date in London time', () => {
    expect(londonToday(new Date('2026-09-23T12:00:00Z'))).toBe('Wednesday 2026-09-23');
  });
  it('rolls over at London midnight, not UTC midnight (BST)', () => {
    // 23:30 UTC on Saturday is already 00:30 Sunday in London during BST
    expect(londonToday(new Date('2026-09-26T23:30:00Z'))).toBe('Sunday 2026-09-27');
  });
  it('uses GMT in winter', () => {
    expect(londonToday(new Date('2026-12-05T23:30:00Z'))).toBe('Saturday 2026-12-05');
  });
});

describe('generation settings', () => {
  it('registers the verified XHS protocol by default and the research protocol only when enabled', () => {
    for (const enabled of [false, true]) {
      const { agent } = createMatchAgent({
        env: { DEEPSEEK_MODEL: 'deepseek-flash', XHS_RESEARCH_ENABLED: enabled },
        xhsSearch: { find: () => Promise.resolve([]) },
      } as never);
      const search = agent.tools.find((t) => t.type === 'function' && t.name === 'xhs_search');
      if (!search || search.type !== 'function') throw new Error('missing XHS tool');
      expect(search.description).toContain(enabled ? 'Budget: 8 queries' : 'up to 5 notes');
    }
  });
  it('explicitly disables DeepSeek thinking for the structured generation loop', () => {
    const { agent } = createMatchAgent({ env: { DEEPSEEK_MODEL: 'deepseek-flash' } } as never);
    expect(agent.modelSettings).toMatchObject({ providerData: { thinking: { type: 'disabled' } } });
  });
  it('does not send the DeepSeek-specific option to another model', () => {
    const { agent } = createMatchAgent({ env: { DEEPSEEK_MODEL: 'custom-model' } } as never);
    expect(agent.modelSettings.providerData).toBeUndefined();
  });
});
