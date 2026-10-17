import { z } from 'zod';

/** Only published, labelled calendar terms are compared; this is no guarantee of current availability. */
export function assessHousingMoveIn(
  text: string,
  wanted: { from: string; to: string },
): { status: 'met' | 'mismatch'; evidence: string; decisive: true } | undefined {
  const dates: Array<{ date: string; line: string }> = [];
  for (const line of text.split('\n')) {
    if (
      /预计|大约|暂定|可能|计划|待确认|需确认|不确定|不能|不可|不是|后|如果|tentative|expected|maybe|after|subject to/i.test(
        line,
      )
    )
      continue;
    for (const match of line.matchAll(
      /(?:入住|起租|可租|available from|move[- ]?in(?: date)?)\s*(?:时间|日期)?\s*[:：]?\s*(?:从|自|on|from)?\s*(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})(?:日|号)?/gi,
    )) {
      const date = match[1] + '-' + match[2]!.padStart(2, '0') + '-' + match[3]!.padStart(2, '0');
      if (z.iso.date().safeParse(date).success) dates.push({ date, line });
    }
  }
  if (new Set(dates.map((row) => row.date)).size !== 1) return undefined;
  const row = dates[0]!;
  if (row.date >= wanted.from && row.date <= wanted.to)
    return { status: 'met', evidence: row.line, decisive: true };
  return row.date > wanted.to
    ? { status: 'mismatch', evidence: row.line, decisive: true }
    : undefined;
}
