import { describe, expect, it } from 'vitest';
import { getXhsPassages } from '../src/xhs-evidence.js';

describe('source-owned XHS passages', () => {
  it('assigns stable IDs without rewriting punctuation or losing content', () => {
    const note = {
      ref: 'x3',
      desc: '介绍第一段。\n\t\n⏳展期：2026.10.03 — 2027.01.31\n📍展厅：Sainsbury Wing',
    };
    const passages = getXhsPassages(note);
    expect(passages).toEqual([
      { id: 'x3:p1', text: '介绍第一段。' },
      { id: 'x3:p2', text: '⏳展期：2026.10.03 — 2027.01.31' },
      { id: 'x3:p3', text: '📍展厅：Sainsbury Wing' },
    ]);
    expect(getXhsPassages(note)).toEqual(passages);
    expect(passages.every((p) => note.desc.includes(p.text))).toBe(true);
  });
  it('bounds large paragraphs and uses only the returned excerpt', () => {
    const passages = getXhsPassages({ ref: 'x1', desc: '字'.repeat(2300) });
    expect(passages.every((p) => p.text.length <= 300)).toBe(true);
    expect(passages.map((p) => p.text).join('')).toBe('字'.repeat(2000));
  });
  it('recognizes escaped and Unicode line breaks from real notes without combining dates and venue', () => {
    const desc = '📍地址：V&A\\n▪️展期：2026年11月8日结束\u2028▪️票价：工作日 £28 / 周末 £30';
    const passages = getXhsPassages({ ref: 'x2', desc });
    expect(passages.map((p) => p.text)).toEqual([
      '📍地址：V&A',
      '▪️展期：2026年11月8日结束',
      '▪️票价：工作日 £28 / 周末 £30',
    ]);
    expect(passages.every((p) => desc.includes(p.text))).toBe(true);
  });
});
