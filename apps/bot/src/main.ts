import { createLogger, loadEnv } from '@matchbot/shared';

const env = loadEnv();
const log = createLogger('bot', env.LOG_LEVEL);
log.info({ phase: env.DEFAULT_PHASE }, 'bot skeleton started; grammY wiring pending');
