/** 从商家自有页面抽联系方式与伦敦证据。纯函数，便于用固定 HTML 测。 */

const LONDON_OUTWARD = /\b(E|EC|N|NW|SE|SW|W|WC)\d{1,2}[A-Z]?\b/;

export function toPlainText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function normPhone(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+44')) return '0' + d.slice(3).replace(/^0/, '');
  if (d.startsWith('44') && d.length > 11) return '0' + d.slice(2);
  return d;
}

/** 英国号码：0 开头 11 位。排除 0800/0808 这类免费号以外不做区分。 */
const isUkPhone = (p: string) => /^0\d{10}$/.test(p);

export interface PageContacts {
  phones: string[];
  whatsapp: string | null;
  instagram: string | null;
  mentionsLondon: boolean;
  siteName: string | null;
}

export function extractContacts(html: string): PageContacts {
  const text = toPlainText(html);
  const tel = [...html.matchAll(/href=["']tel:([^"']+)/gi)].map((m) =>
    normPhone(decodeURIComponent(m[1]!)),
  );
  const inText = (text.match(/(?:\+44\s?\(?0?\)?|\b0)\d[\d\s\-()]{8,13}\d/g) ?? []).map(normPhone);
  const phones = [...new Set([...tel, ...inText])].filter(isUkPhone);

  const wa = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?phone=)\+?(\d{9,15})/i.exec(html)?.[1];
  const ig = /instagram\.com\/([A-Za-z0-9_.]{2,30})\/?["'?#]/i.exec(html)?.[1];
  // 按开引号配对：店名里常有撇号（Polly's），不能把 ' 当成通用结束符
  const rawName = /<meta[^>]+property=["']og:site_name["'][^>]+content=(["'])(.{2,80}?)\1/i.exec(
    html,
  )?.[2];
  const siteName = rawName ? decodeEntities(rawName).trim() : null;

  return {
    phones,
    whatsapp: wa ? normPhone(wa) : null,
    instagram: ig && !['p', 'reel', 'explore', 'accounts', 'sharer'].includes(ig) ? ig : null,
    mentionsLondon: /\bLondon\b/i.test(text) || LONDON_OUTWARD.test(text),
    siteName,
  };
}

/** 「Brand | tagline」「Brand - Services」取第一段作店名。 */
export function nameFromTitle(title: string): string {
  const first = title.split(/\s[|–—•·-]\s|\s\|\s?/)[0]!.trim();
  return (first || title).slice(0, 60);
}

/** 榜单 / 指南 / 「near me」聚合页不是一家商家。 */
export function looksLikeListicle(title: string): boolean {
  return /\b(best|top)\s+\d+|\b\d+\s+(best|top)\b|guide to|near me|compare \d+|find (the )?(most|best)|reviews? of the/i.test(
    title,
  );
}
