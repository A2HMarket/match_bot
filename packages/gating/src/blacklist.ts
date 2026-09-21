/** 换汇 / 虚拟币 / 代付 硬拒（PRD §4.3）。关键词表是第一道，Jev is_sensitive 是第二道。 */
const PATTERNS: RegExp[] = [
  /换汇|換匯|换钱|人民币换|换英镑|换镑/i,
  /\b(usdt|usdc|btc|eth|crypto|bitcoin|binance)\b/i,
  /обмен\s*валют|обменяю|курс\s*фунт/i,
  /câmbio|troco\s+libras/i,
  /代付|帮付|pay (on|for) my behalf|pay for me and/i,
];
export function isBlacklisted(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
