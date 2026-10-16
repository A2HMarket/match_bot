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
  it('serializes dependent task steps and requires the final outbound tool even without XHS', () => {
    const deps = {
      env: { DEEPSEEK_MODEL: 'deepseek-flash' },
      answerRequests: true,
      taskRequests: true,
    };
    expect(
      createMatchAgent(deps as never, { phase: 0 }).agent.modelSettings.parallelToolCalls,
    ).toBe(false);
    const final = createMatchAgent(deps as never, { phase: 0, finalAnswerOnly: true }).agent;
    expect(final.modelSettings.toolChoice).toBe('required');
    expect(final.tools.map((t) => (t.type === 'function' ? t.name : ''))).toEqual([
      'reply_to_request',
    ]);
  });
  it('uses separate small internal tools for task creation, updates, clarification and acknowledgement', () => {
    const { agent } = createMatchAgent({ env: { DEEPSEEK_MODEL: 'deepseek-flash' } } as never, {
      phase: 0,
      taskPlanningOnly: true,
      taskRefs: ['task-a'],
    });
    expect(agent.tools.map((t) => (t.type === 'function' ? t.name : ''))).toEqual([
      'start_task',
      'update_task',
      'clarify_task',
      'acknowledge_task',
    ]);
    const update = agent.tools.find((t) => t.type === 'function' && t.name === 'update_task');
    if (!update || update.type !== 'function') throw new Error('missing update tool');
    expect(update.parameters.properties).not.toHaveProperty('category');
    expect(update.parameters.properties).not.toHaveProperty('patch');
  });
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
