import { XHS_RESEARCH_LIMITS } from './xhs-research.js';

/** 原文由代码保管，模型只返回编号，避免把综合摘要误当成逐字引文（P14 实测）。 */
export function getXhsPassages(note: { ref: string; desc: string }) {
  const texts = note.desc
    .slice(0, XHS_RESEARCH_LIMITS.excerptChars)
    .split(/(?:[\r\n\u2028\u2029]+|\\[nr])/u);
  const passages: Array<{ id: string; text: string }> = [];
  for (const line of texts) {
    for (let start = 0; start < line.length; start += 300) {
      const text = line.slice(start, start + 300).trim();
      if (text) passages.push({ id: `${note.ref}:p${passages.length + 1}`, text });
    }
  }
  return passages;
}
