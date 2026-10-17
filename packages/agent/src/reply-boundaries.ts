/** PRD §13: this read-only agent has neither background watchers nor contact/booking receipts. */
export function hasUnsupportedActionClaim(text: string): boolean {
  if (/我(?:也|还)?会(?:先|优先|帮你|替你|代你)*(?:问(?!你|您)|联系|预约|订票)/.test(text))
    return true;
  return /我(?:也|还)?(?:会|可以|来)(?:帮你|替你)?(?:继续|持续|定期|每天|随时)?(?:留意|盯着|监控|跟进|关注)|\bI(?:'ll| will| can)\s+(?:keep an eye|monitor|watch for|follow up)|我(?:已经|已|刚刚|刚)?(?:帮你|替你)?(?:联系(?:了|过)|预约(?:了|好了)|订(?:了|好了)票)|\bI (?:have )?(?:already )?(?:contacted|booked|reserved)\b/i.test(
    text,
  );
}

export function hasUnsupportedModelAction(args: unknown): boolean {
  if (args === null || typeof args !== 'object') return false;
  const text = 'text' in args && typeof args.text === 'string' ? args.text : '';
  const intro = 'intro' in args && typeof args.intro === 'string' ? args.intro : '';
  const question = 'question' in args && typeof args.question === 'string' ? args.question : '';
  // Only model-authored prose. A public source quoting its author's actions is untrusted data, not ours.
  return [text, intro, question].some(hasUnsupportedActionClaim);
}
