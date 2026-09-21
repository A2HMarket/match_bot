// PoC V2 进程 1：跑到 needsApproval 中断，把 RunState 序列化落盘。
import { run } from '@openai/agents';
import { writeFileSync } from 'node:fs';
import { buildAgent } from './agent.js';

const STATE_PATH = '/tmp/poc-v2-state.json';

const result = await run(buildAgent(), 'I need a van Sunday E14 to SE1, 8 boxes', {
  signal: AbortSignal.timeout(60_000),
});

console.log(
  'interruptions:',
  JSON.stringify(
    result.interruptions.map((i) => ({
      type: i.type,
      rawItemType: i.rawItem.type,
      tool: 'name' in i.rawItem ? i.rawItem.name : undefined,
      args: 'arguments' in i.rawItem ? i.rawItem.arguments : undefined,
      callId: 'callId' in i.rawItem ? i.rawItem.callId : undefined,
    })),
  ),
);
if (result.interruptions.length === 0) throw new Error('expected an interruption');

const snapshot = result.state.toString();
writeFileSync(STATE_PATH, snapshot);
console.log('state saved to', STATE_PATH);
console.log('bytes (utf8) =', Buffer.byteLength(snapshot, 'utf8'), ' chars =', snapshot.length);

const parsed = JSON.parse(snapshot) as Record<string, unknown>;
console.log('$schemaVersion =', parsed['$schemaVersion']);
console.log('top-level keys =', Object.keys(parsed).join(','));
console.log(
  'snapshot contains original user text?',
  snapshot.includes('E14 to SE1'),
  '| contains tool arguments text?',
  snapshot.includes('reply_in_group'),
);
