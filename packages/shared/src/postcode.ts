/**
 * UK postcode 归一化。存储与比较一律使用归一化后的形式：
 * - full: 大写、无空格，如 "E149AB"
 * - outward: 区级前缀，如 "E14"
 */
const OUTWARD_RE = /^([A-Z]{1,2}\d[A-Z\d]?)/;

export interface Postcode {
  full: string;
  outward: string;
}

export function normalizePostcode(raw: string): Postcode | null {
  const full = raw.toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?(\d[A-Z]{2})?$/.test(full)) return null;
  const m = OUTWARD_RE.exec(full);
  if (!m?.[1]) return null;
  return { full, outward: m[1] };
}
