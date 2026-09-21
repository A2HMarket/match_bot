import { createLogger, loadEnv } from '@matchbot/shared';

const env = loadEnv();
const log = createLogger('worker', env.LOG_LEVEL);
log.info({ phase: env.DEFAULT_PHASE }, 'worker skeleton started; BullMQ wiring pending');
