/**
 * 发给搜索服务的查询只能是「在找什么 + 区域」。Tavily 条款写明会留存查询并可能用于
 * 训练、且无零留存选项（P14 §3），所以这里在代码层拒绝任何像个人信息的内容，
 * 而不是指望模型照 prompt 自觉。小红书查询也在出网前校验。
 */
export class UnsafeQueryError extends Error {
  constructor(reason: string) {
    super(`search query rejected: ${reason}`);
    this.name = 'UnsafeQueryError';
  }
}

const OUTWARD = /^[A-Z]{1,2}\d{1,2}[A-Z]?$/i;

/** 「在找什么」的出网前校验；返回规范化后的文本。 */
export function assertSafeNeed(raw: string): string {
  const need = raw.trim().replace(/\s+/g, ' ');
  if (need.length < 2 || need.length > 60) throw new UnsafeQueryError('need must be 2-60 chars');
  if (/@|https?:|www\./i.test(need)) throw new UnsafeQueryError('need looks like a handle or URL');
  if (/\d{5,}|\d[\d\s]{8,}\d/.test(need)) throw new UnsafeQueryError('need contains a number');
  if (!/^[\p{L}\p{M}\s&'’,.\-/]+$/u.test(need))
    throw new UnsafeQueryError('need has unexpected characters');
  return need;
}

export function buildSearchQuery(p: { need: string; area?: string | undefined }): string {
  const need = assertSafeNeed(p.need);

  const area = p.area?.trim();
  if (area) {
    const ok = OUTWARD.test(area) || /^[\p{L}\s'’.\-]{2,30}$/u.test(area);
    if (!ok) throw new UnsafeQueryError('area must be an outcode or a place name');
  }
  return [need, area, /london/i.test(`${need} ${area ?? ''}`) ? '' : 'London']
    .filter(Boolean)
    .join(' ');
}

/** 展览名称与时间查询允许短数字；仍拒绝电话、邮箱、账号、URL 与标记，不改变 Tavily 的守卫。 */
export function assertSafeXhsKeyword(raw: string): string {
  const keyword = raw.trim().replace(/\s+/g, ' ');
  if (keyword.length < 2 || keyword.length > 60)
    throw new UnsafeQueryError('keyword must be 2-60 chars');
  if (/@|https?:|www\./i.test(keyword))
    throw new UnsafeQueryError('keyword looks like a handle or URL');
  if (/\d{5,}|\d[\d\s]{8,}\d/.test(keyword))
    throw new UnsafeQueryError('keyword contains a phone or long number');
  if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(keyword))
    throw new UnsafeQueryError('keyword looks like a private full postcode');
  if (!/^[\p{L}\p{M}\d\s+&'’,.\-/:：()（）·「」《》“”"]+$/u.test(keyword))
    throw new UnsafeQueryError('keyword has unexpected characters');
  return keyword;
}
