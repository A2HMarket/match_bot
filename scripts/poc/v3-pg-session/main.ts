import type { AgentInputItem } from '@openai/agents';
import {
  Agent,
  OpenAIProvider,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
} from '@openai/agents';
import pg from 'pg';
import { PgSession } from './pg-session.js';

setTracingDisabled(true);
setDefaultModelProvider(
  new OpenAIProvider({
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    useResponses: false,
  }),
);

const TIMEOUT_MS = 60_000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(
  'CREATE TABLE IF NOT EXISTS poc_session_items(user_id text, seq int, item jsonb, PRIMARY KEY(user_id, seq))',
);

const session = new PgSession(pool, 'user-42');
await session.clearSession();

const agent = new Agent({
  name: 'poc-v3',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  instructions: 'Answer in one short sentence.',
});

console.log('sessionId =', await session.getSessionId());

// ---- turn 1 -------------------------------------------------------------
const before1 = (await session.getItems()).length;
const r1 = await run(agent, 'I need a van on Sunday from E14.', {
  session,
  signal: AbortSignal.timeout(TIMEOUT_MS),
});
const after1 = (await session.getItems()).length;
console.log('turn 1 answer:', r1.finalOutput);
console.log(`turn 1 appended ${after1 - before1} items (total ${after1})`);

// ---- turn 2: does history carry? ---------------------------------------
const r2 = await run(agent, 'To SE1, about 8 boxes. Where am I moving from?', {
  session,
  signal: AbortSignal.timeout(TIMEOUT_MS),
});
const items2 = await session.getItems();
console.log('turn 2 answer:', r2.finalOutput);
console.log(`turn 2 appended ${items2.length - after1} items (total ${items2.length})`);
console.log('history carried (answer mentions E14):', /E14/i.test(String(r2.finalOutput ?? '')));
console.log('stored items:', items2.length);

// ---- stored item shape --------------------------------------------------
console.log('--- all stored items (compact) ---');
for (const [i, it] of items2.entries()) console.log(i, JSON.stringify(it));
console.log('--- one raw row (item[0]) ---');
console.log(JSON.stringify(items2[0], null, 2));
console.log('--- one raw row (assistant, item[1]) ---');
console.log(JSON.stringify(items2[1], null, 2));

// ---- getItems(limit): is it a "last N" window? -------------------------
const last2 = await session.getItems(2);
console.log('getItems(2) ===', JSON.stringify(last2.map((x) => JSON.stringify(x).slice(0, 60))));

// ---- sessionInputCallback: does it fire for a plain STRING input? ------
let cbCalls = 0;
let cbSeen: { history: number; newItems: number; newItemsJson: string } | undefined;
const r3 = await run(agent, 'And what is my destination postcode?', {
  session,
  signal: AbortSignal.timeout(TIMEOUT_MS),
  sessionInputCallback: (historyItems: AgentInputItem[], newItems: AgentInputItem[]) => {
    cbCalls += 1;
    cbSeen = {
      history: historyItems.length,
      newItems: newItems.length,
      newItemsJson: JSON.stringify(newItems),
    };
    return [...historyItems, ...newItems];
  },
});
console.log('turn 3 answer:', r3.finalOutput);
console.log('sessionInputCallback calls (string input):', cbCalls);
console.log('sessionInputCallback saw:', JSON.stringify(cbSeen));
const items3 = await session.getItems();
console.log(`turn 3 appended ${items3.length - items2.length} items (total ${items3.length})`);

// ---- popItem sanity (SDK itself never calls it; we call it manually) ----
const popped = await session.popItem();
console.log('popItem() returned:', JSON.stringify(popped)?.slice(0, 120));
console.log('items after popItem:', (await session.getItems()).length);

await pool.end();
