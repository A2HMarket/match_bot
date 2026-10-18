/** Representation equivalence only; entity binding and factual entailment remain separate gates. */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function claims(text: string, referenceCount: number): string[] {
  const typed: string[] = [];
  let rest = text
    .replace(/\bA2H\b/gi, '')
    .replace(/(?:第|这|那)(\d{1,2})(?:条|套|项)/g, (whole: string, value: string) =>
      Number(value) > 0 && Number(value) <= referenceCount ? '' : whole,
    )
    .replace(/(^|\n)\s*\d{1,2}(?:\.\s+|[、)）]\s*)/g, '$1')
    .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, (value) => value.replaceAll(',', ''));
  rest = rest.replace(
    /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?=\D|$)/g,
    (whole: string, year: string, month: string, day: string) => {
      const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== whole)
        return whole;
      typed.push('month:' + Number(month));
      return `${year} ${Number(day)}`;
    },
  );
  const clock = (hour: number, minute: number) => {
    typed.push(`time:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    return ' ';
  };
  rest = rest.replace(
    /\b(1[0-2]|0?[1-9])(?:[:.](\d{2}))?\s*(am|pm)\b/gi,
    (whole: string, h: string, m: string | undefined, period: string) => {
      if (Number(m ?? 0) > 59) return whole;
      return clock((Number(h) % 12) + (period.toLowerCase() === 'pm' ? 12 : 0), Number(m ?? 0));
    },
  );
  rest = rest.replace(
    /\b([01]?\d|2[0-3])[:：]([0-5]\d)\b/g,
    (_whole: string, h: string, m: string) => clock(Number(h), Number(m)),
  );
  rest = rest.replace(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi,
    (month) => {
      typed.push('month:' + (MONTHS.indexOf(month.toLowerCase()) + 1));
      return ' ';
    },
  );
  rest = rest.replace(/(1[0-2]|0?[1-9])\s*月/g, (_whole: string, month: string) => {
    typed.push('month:' + Number(month));
    return ' ';
  });
  return [...typed, ...(rest.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)))];
}

export function unsupportedNumericClaims(
  text: string,
  support: string,
  referenceCount = 0,
): string[] {
  const available = new Set(claims(support, 0));
  return [...new Set(claims(text, referenceCount).filter((value) => !available.has(value)))];
}
