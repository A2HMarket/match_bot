/** Real PostgreSQL + independent child processes + SIGKILL; the only HTTP endpoint is a local fake Telegram server. */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Api } from 'grammy';
import { z } from 'zod';
import { createDeliveryProofStore } from '../../../packages/db/tests/integration/delivery-proof-store.js';
import { createTelegramSender } from '../../../packages/channel-telegram/dist/index.js';
import { createLogger } from '../../../packages/shared/src/index.js';
import { drainOutbound } from '../../../apps/bot/src/outbound-loop.js';

const store = createDeliveryProofStore(),
  logger = createLogger('delivery-proof', 'silent');
const mode = process.argv[2];
if (mode === 'claim') {
  try {
    const rows = await store.repos.outbound.claimPending(1);
    process.stdout.write(JSON.stringify({ pid: process.pid, ids: rows.map((r) => r.id) }));
  } finally {
    await store.close();
  }
} else if (mode === 'before' || mode === 'fenced' || mode === 'accepted') {
  const watchdog = setTimeout(() => process.exit(3), 30000);
  const row = (await store.repos.outbound.claimPending(1, { leaseMs: 1500 }))[0];
  if (!row?.leaseToken) throw new Error('missing committed claim');
  let receipt: unknown = null;
  if (mode === 'fenced')
    await store.repos.outbound.beginSend({ id: row.id, leaseToken: row.leaseToken });
  if (mode === 'accepted') {
    const apiRoot = process.argv[4]!;
    if (new URL(apiRoot).hostname !== '127.0.0.1') throw new Error('local fake transport required');
    const sender = createTelegramSender({
      bot: { api: new Api('synthetic', { apiRoot, timeoutSeconds: 2 }) } as never,
      logger,
    });
    receipt = await sender.send(row, {
      beforeSend: () => store.repos.outbound.beginSend({ id: row.id, leaseToken: row.leaseToken! }),
    });
  }
  writeFileSync(process.argv[3]!, JSON.stringify({ pid: process.pid, id: row.id, receipt }));
  await new Promise((resolve) => setTimeout(resolve, 25000));
  clearTimeout(watchdog);
  await store.close();
  process.exitCode = 3;
} else {
  const output = process.argv[2] ?? '/tmp/matchbot-delivery-process-proof.json';
  const runDir = mkdtempSync(join(tmpdir(), 'matchbot-delivery-proof-'));
  const children: ReturnType<typeof spawn>[] = [],
    ids: string[] = [],
    results: unknown[] = [];
  let acceptedRequests = 0,
    requestCount = 0,
    transportMode: 'normal' | 'rate_limit_once' | 'lose_ack' = 'normal';
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/sendMessage')) {
      response.writeHead(404);
      response.end();
      return;
    }
    request.resume();
    requestCount++;
    if (transportMode === 'rate_limit_once') {
      transportMode = 'normal';
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'synthetic rate limit',
          parameters: { retry_after: 1 },
        }),
      );
      return;
    }
    acceptedRequests++;
    if (transportMode === 'lose_ack') return;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ok: true,
        result: {
          message_id: 9000 + acceptedRequests,
          chat: { id: -999900000001, type: 'supergroup' },
          date: Math.floor(Date.now() / 1000),
          text: 'synthetic',
        },
      }),
    );
  });
  const fingerprint = createHash('sha256');
  for (const path of [
    'packages/db/src/repos/outbound.ts',
    'packages/db/prisma/schema.prisma',
    'packages/db/prisma/migrations/20261016205000_outbound_delivery_ledger/migration.sql',
    'packages/db/tests/integration/delivery-proof-store.ts',
    'packages/domain/dist/drafts.js',
    'packages/channel-telegram/dist/sender.js',
    'apps/bot/src/outbound-loop.ts',
    import.meta.filename,
  ])
    fingerprint.update(relative(process.cwd(), path)).update(readFileSync(path));
  const sourceFingerprint = fingerprint.digest('hex');
  const started = Date.now(),
    watchdog = setTimeout(() => {
      save('timeout', 'fault proof exceeded 45 seconds');
      for (const child of children) child.kill('SIGKILL');
      process.exit(2);
    }, 45000);
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const seed = async (text: string) => {
    const row = await store.seed(text);
    ids.push(row.id);
    return row;
  };
  const save = (status: string, error?: string) =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          status,
          sourceFingerprint,
          nodeVersion: process.version,
          fixtureRows: ids,
          elapsedMs: Date.now() - started,
          boundary:
            'isolated matchbot_delivery_proof DB; synthetic rows; independent Node processes; SIGKILL; real wall-clock lease expiry; local fake Telegram HTTP only; no live Telegram',
          acceptedRequests,
          requestCount,
          results,
          ...(error ? { error } : {}),
        },
        null,
        2,
      ),
    );
  try {
    assert(
      (await store.liveCount()) === 0,
      'dedicated proof DB has live rows from another run; leave them untouched',
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local server address');
    const apiRoot = 'http://127.0.0.1:' + address.port;
    const first = await seed('synthetic parallel claim A'),
      second = await seed('synthetic parallel claim B');
    const exec = promisify(execFile);
    const parallel = await Promise.all(
      [1, 2].map(async () => {
        const result = await exec(
          process.execPath,
          ['--import', 'tsx', import.meta.filename, 'claim'],
          { timeout: 15000, maxBuffer: 65536 },
        );
        return z
          .object({ pid: z.number(), ids: z.array(z.string()) })
          .parse(JSON.parse(result.stdout));
      }),
    );
    assert(parallel[0]!.pid !== parallel[1]!.pid, 'workers were not distinct processes');
    const claimed = parallel.flatMap((p) => p.ids);
    assert(
      claimed.length === 2 &&
        new Set(claimed).size === 2 &&
        claimed.includes(first.id) &&
        claimed.includes(second.id),
      'parallel claims overlapped or lost a row',
    );
    results.push({ scenario: 'independent_parallel_claims', passed: true, workers: parallel });
    await store.remove([first.id, second.id]);
    for (const crash of ['before', 'fenced', 'accepted'] as const) {
      const row = await seed('synthetic crash ' + crash),
        readyPath = join(runDir, crash + '.json');
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', import.meta.filename, crash, readyPath, apiRoot],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(child);
      const deadline = Date.now() + 15000;
      while (!existsSync(readyPath)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error('child did not reach crash point: ' + crash);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const ready = z
        .object({ pid: z.number(), id: z.string(), receipt: z.unknown() })
        .parse(JSON.parse(readFileSync(readyPath, 'utf8')));
      assert(
        ready.id === row.id && ready.pid === child.pid,
        'crash point belongs to another process/row',
      );
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      const exit = await exited;
      assert(exit[1] === 'SIGKILL', 'child was not killed at the requested crash point');
      const beforeRecovery = await store.row(row.id),
        token = beforeRecovery.leaseToken!;
      assert(
        (beforeRecovery.attemptStartedAt !== null) === (crash !== 'before'),
        'incorrect external-send start marker',
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, beforeRecovery.leaseExpiresAt!.getTime() - Date.now() + 10),
        ),
      );
      await store.repos.outbound.recoverExpiredClaims();
      const recovered = await store.row(row.id);
      assert(
        recovered.status === (crash === 'before' ? 'pending' : 'delivery_unknown'),
        'incorrect recovery direction',
      );
      if (crash === 'before') {
        const next = (await store.repos.outbound.claimPending(1))[0]!;
        assert(next.leaseToken !== token, 'new claim reused the old fence');
        assert(
          !(await store.repos.outbound.beginSend({ id: row.id, leaseToken: token })),
          'stale fence started a send',
        );
      } else {
        const sender = createTelegramSender({
          bot: { api: new Api('synthetic', { apiRoot, timeoutSeconds: 2 }) } as never,
          logger,
        });
        const count = acceptedRequests;
        await drainOutbound({ repos: store.repos, sender, logger, defaultPhase: 2 });
        assert(count === acceptedRequests, 'an uncertain send was automatically retried');
        if (crash === 'accepted') {
          assert(count === 1, 'fake Telegram did not accept exactly one send');
          assert(
            await store.repos.outbound.markSent({
              id: row.id,
              leaseToken: token,
              externalMessageId: '9001',
            }),
            'late authoritative fake receipt was rejected',
          );
          const confirmed = await store.row(row.id);
          assert(
            confirmed.status === 'sent' && confirmed.externalMessageId === '9001',
            'confirmed receipt was not persisted',
          );
        }
      }
      results.push({
        scenario: crash,
        pid: child.pid,
        passed: true,
        recoveredStatus: recovered.status,
        acceptedRequests,
        fenceFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 12),
      });
      await store.remove([row.id]);
      save('running');
    }
    const normal = await seed('synthetic normal delivery');
    const sender = createTelegramSender({
      bot: { api: new Api('synthetic', { apiRoot, timeoutSeconds: 2 }) } as never,
      logger,
    });
    await drainOutbound({ repos: store.repos, sender, logger, defaultPhase: 2 });
    const delivered = await store.row(normal.id);
    assert(
      delivered.status === 'sent' &&
        delivered.externalMessageId === String(9000 + acceptedRequests),
      'normal delivery was not confirmed',
    );
    results.push({
      scenario: 'normal_delivery',
      passed: true,
      status: delivered.status,
      receiptStored: !!delivered.externalMessageId,
    });
    await store.remove([normal.id]);

    transportMode = 'rate_limit_once';
    const limited = await seed('synthetic definitive rate rejection');
    await drainOutbound({ repos: store.repos, sender, logger, defaultPhase: 2 });
    const waiting = await store.row(limited.id);
    assert(
      waiting.status === 'pending' && waiting.nextAttemptAt,
      'known rate rejection was not scheduled',
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, waiting.nextAttemptAt!.getTime() - Date.now() + 10)),
    );
    await drainOutbound({ repos: store.repos, sender, logger, defaultPhase: 2 });
    const retried = await store.row(limited.id);
    assert(
      retried.status === 'sent' && retried.attemptCount === 2,
      'known rejection did not retry exactly once',
    );
    results.push({
      scenario: 'definitive_rejection_retry',
      passed: true,
      attemptCount: retried.attemptCount,
      status: retried.status,
    });
    await store.remove([limited.id]);

    transportMode = 'lose_ack';
    const lost = await seed('synthetic accepted but HTTP receipt lost');
    const bounded = createTelegramSender({
      bot: { api: new Api('synthetic', { apiRoot, timeoutSeconds: 0.1 }) } as never,
      logger,
    });
    const countBefore = acceptedRequests;
    await drainOutbound({ repos: store.repos, sender: bounded, logger, defaultPhase: 2 });
    const uncertain = await store.row(lost.id);
    assert(
      acceptedRequests === countBefore + 1 && uncertain.status === 'delivery_unknown',
      'lost HTTP acknowledgement was misclassified',
    );
    await drainOutbound({ repos: store.repos, sender: bounded, logger, defaultPhase: 2 });
    assert(acceptedRequests === countBefore + 1, 'lost acknowledgement was blindly retried');
    results.push({
      scenario: 'lost_http_acknowledgement',
      passed: true,
      status: uncertain.status,
      acceptedOnce: true,
    });
    await store.remove([lost.id]);
    save('passed');
  } catch (error) {
    save('failed', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
    await store.remove(ids);
    await store.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}
