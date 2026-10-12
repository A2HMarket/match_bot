/** P16：纯广告不等于向 bot/群求助；明确问人、找买家/租客时才保留 Jev 的请求判定。 */
export function isStandaloneMarketAdvertisement(text: string): boolean {
  const request =
    /[?？]|有没有|有人|谁(?:想|要|在|收)|求购|帮(?:我|忙)|能不能|请问|想找|找(?:买家|租客|人)|\b(?:anyone|who|looking for|help me|can you|procuro|alguém)\b|ищу|шукаю|кто|хто/iu;
  if (request.test(text)) return false;
  return /^(?:selling\b|for sale\b|giving away\b|room available\b|room for rent\b|出一|出售|转让|闲置转让|房间出租|整租出租|短租出租|продам|продаю|сдаётся|сдаю|віддам|здається|vendo\b|alugo\b|quarto disponível\b)/iu.test(
    text.trim(),
  );
}

/** P16：目标是对家的帖子方向，不能把“我想买”误当成搜索 BUY。只用当前消息。 */
export function selectMarketTradeType(text: string): 'SELL' | 'BUY' | 'PEER' | 'ANY' {
  const provider =
    /想卖|卖掉|找买家|谁在收|找租客|我是房东|我(?:能|可以)帮带|帮我(?:卖|转租)|\b(?:want to sell|sell my|selling my|anyone want to buy|find (?:a )?(?:buyer|tenant)|looking for (?:a )?buyer|rent out my|I can (?:bring|carry)|I have luggage space|anyone need)\b/iu;
  const spareCapacity =
    /我[^。！？]{0,60}有[^。！？]{0,12}(?:空余|剩余|多余)[^。！？]{0,12}(?:行李|额度)|我[^。！？]{0,50}(?:空余|剩余)行李/i;
  if (provider.test(text) || spareCapacity.test(text)) return 'BUY';
  if (/求.*帮带|找.*帮带|需要.*帮带|someone to (?:bring|carry)/iu.test(text)) return 'SELL';
  if (
    /搭子|伙伴|室友|\broommate\b|想找一起|找人一起|有人一起|\b(?:companion|partner|peers|play together)\b/iu.test(
      text,
    )
  )
    return 'PEER';
  return 'SELL';
}
