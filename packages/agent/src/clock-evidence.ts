/** Remove only exact clock equivalents before checking remaining numerical claims. */
export function removeSupportedClockClaims(text: string, support: string): string {
  const known = new Set<string>();
  for (const m of support.matchAll(
    /\b(\d{1,2})(?:[:.]([0-5]\d))?\s*([ap]m)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi,
  )) {
    if (m[3]) {
      const h = Number(m[1]);
      if (h < 1 || h > 12) continue;
      known.add(String((h % 12) + (/pm/i.test(m[3]) ? 12 : 0)) + ':' + (m[2] ?? '00'));
    } else known.add(Number(m[4]) + ':' + m[5]);
  }
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (whole: string, h: string, m: string) =>
    known.has(Number(h) + ':' + m) ? '' : whole,
  );
}
