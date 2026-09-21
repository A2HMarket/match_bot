// PoC V2 进程 2：反序列化 → addInput → approve → run；再用同一份快照二次恢复，
// 验证 SDK 是否拦截重放（预期不拦截 → 必须靠我们自己的 run_states 原子消费）。
import { RunState, run } from '@openai/agents';
import type { Agent } from '@openai/agents';
import { readFileSync } from 'node:fs';
import { buildAgent, sent } from './agent.js';

const STATE_PATH = '/tmp/poc-v2-state.json';
const raw = readFileSync(STATE_PATH, 'utf8');
const TIMEOUT = { signal: AbortSignal.timeout(90_000) } as const;

const describe = (items: readonly { rawItem: unknown }[]) =>
  items.map((i) => {
    const r = i.rawItem as { name?: string; arguments?: string; callId?: string };
    return { tool: r.name, callId: r.callId, args: (r.arguments ?? '').slice(0, 160) };
  });

// ---------- 第一次恢复 ----------
console.log('=== RESUME #1 (with addInput) ===');
const agent = buildAgent();
const state = await RunState.fromString<unknown, Agent<unknown, 'text'>>(agent, raw);
console.log('rehydrated interruptions =', state.getInterruptions().length);
state.addInput('Also, my budget is £120 max.');
console.log('pendingInput =', JSON.stringify(state.pendingInput));
for (const i of state.getInterruptions()) state.approve(i);

let result = await run(agent, state, TIMEOUT);
let round = 1;
console.log(`round ${round}: sent=${sent.length} interruptions=${result.interruptions.length}`);
console.log(`round ${round}: new interruptions ->`, JSON.stringify(describe(result.interruptions)));

// 继续批准直到 run 结束（证明"批准一次不等于跑完"）
while (result.interruptions.length > 0 && round < 4) {
  round += 1;
  for (const i of result.interruptions) result.state.approve(i);
  result = await run(agent, result.state, TIMEOUT);
  console.log(`round ${round}: sent=${sent.length} interruptions=${result.interruptions.length}`);
  console.log(
    `round ${round}: new interruptions ->`,
    JSON.stringify(describe(result.interruptions)),
  );
}
console.log('final #1:', result.finalOutput);
console.log('sent #1 (each truncated to 200 chars):');
sent.forEach((s, n) => console.log(`  [${n}] ${s.slice(0, 200).replace(/\n/g, ' ⏎ ')}`));
console.log(
  'addInput reached the model? ->',
  sent.some((s) => /120/.test(s)),
);
console.log(
  'history roles =',
  JSON.stringify(
    result.history.map(
      (h) => (h as { role?: string; type?: string }).role ?? (h as { type?: string }).type,
    ),
  ),
);
console.log(
  'budget message present in history? ->',
  JSON.stringify(result.history).includes('budget is £120'),
);

const sentAfterFirst = sent.length;

// ---------- 第二次恢复同一快照 ----------
console.log('\n=== RESUME #2 (same snapshot again, no addInput) ===');
try {
  const again = await RunState.fromString<unknown, Agent<unknown, 'text'>>(agent, raw);
  for (const i of again.getInterruptions()) again.approve(i);
  const r2 = await run(agent, again, TIMEOUT);
  console.log('SECOND RESUME RAN — SDK did NOT block the replay.');
  console.log(
    `sent count before=${sentAfterFirst} after=${sent.length} (tool executed again = ${sent.length > sentAfterFirst})`,
  );
  console.log(
    'second final:',
    typeof r2.finalOutput === 'string' ? r2.finalOutput.slice(0, 200) : r2.finalOutput,
  );
} catch (err) {
  console.log(
    'SECOND RESUME REJECTED by SDK:',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
}

// ---------- agent 图一致性 ----------
console.log('\n=== fromString with a DIFFERENT agent graph ===');
try {
  const { Agent: AgentCtor } = await import('@openai/agents');
  const wrong = new AgentCtor({
    name: 'poc-v2-renamed',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    instructions: 'x',
  });
  await RunState.fromString(wrong, raw);
  console.log('DIFFERENT AGENT GRAPH accepted by fromString');
} catch (err) {
  console.log(
    'DIFFERENT AGENT GRAPH rejected:',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
}

// ---------- 改了 instructions 但同名的 agent ----------
console.log('\n=== fromString with same name but different instructions/tools ===');
try {
  const { Agent: AgentCtor } = await import('@openai/agents');
  const tweaked = new AgentCtor({
    name: 'poc-v2',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    instructions: 'COMPLETELY DIFFERENT INSTRUCTIONS',
  });
  const s = await RunState.fromString(tweaked, raw);
  console.log(
    'accepted; interruptions =',
    s.getInterruptions().length,
    '(name is the only binding key)',
  );
} catch (err) {
  console.log('rejected:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}
