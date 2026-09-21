import { createHash } from 'node:crypto';

/** messages.text 30 天后置空，只留哈希用于去重与审计（架构 §9）。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
