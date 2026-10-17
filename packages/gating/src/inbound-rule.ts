import { isBlacklisted } from './blacklist.js';

/** Admission is shared by durable ingress and the worker; rejected text is never stored. */
export function inboundRuleReason(p: {
  text: string;
  isPrivate: boolean;
  hasGroup: boolean;
  isGroupActive: boolean;
}): string | null {
  if (!p.text.trim()) return 'empty_text';
  if (p.text.trimStart().startsWith('/')) return 'command';
  if (isBlacklisted(p.text)) return 'blacklist';
  if (!p.isPrivate && !p.hasGroup) return 'group_not_registered';
  if (!p.isPrivate && !p.isGroupActive) return 'group_inactive';
  return null;
}
