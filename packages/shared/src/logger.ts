import pino from 'pino';

export type Logger = pino.Logger;

/** 统一结构化日志。字段名遵守 AGENTS.md §4：snake_case、不打印 PII 原文。 */
export function createLogger(name: string, level: string = 'info'): Logger {
  return pino({ name, level, redact: ['text', 'phone', '*.text', '*.phone'] });
}
