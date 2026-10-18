/** Error codes and corrective messages only; never export decrypted input or source bodies. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { createPrisma } from '../../../packages/db/src/index.js';
const report = z
  .object({ inputRef: z.string() })
  .parse(JSON.parse(readFileSync('logs/p36/replay-gp-registration.json', 'utf8')));
const url = new URL(loadEnv().DATABASE_URL);
url.pathname = '/matchbot_actor_lab';
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('local_only');
const db = createPrisma(url.toString());
try {
  const rows = await db.decisionTrace.findMany({
    where: { inputRef: report.inputRef, kind: 'gate' },
    select: { output: true },
  });
  for (const row of rows) {
    const parsed = z
      .object({ gate: z.literal('outbound_input'), detail: z.array(z.string()) })
      .safeParse(row.output);
    if (parsed.success) process.stdout.write(JSON.stringify(parsed.data) + '\n');
  }
} finally {
  await db.$disconnect();
}
