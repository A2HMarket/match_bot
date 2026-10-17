/** Real child process: closing the worker must release every owned connection. */
import { createWorker } from '../../src/worker.js';
import { QUEUE_NAMES } from '../../src/contracts.js';
import { z } from 'zod';
const redisUrl = z.string().url().parse(process.argv[2]);
const worker = createWorker(QUEUE_NAMES.cron, redisUrl, () => Promise.resolve());
await worker.pause(true);
await worker.close();
process.stdout.write('worker closed\n');
// Natural process exit is the assertion. Do not force process.exit or disconnect test-only resources.
