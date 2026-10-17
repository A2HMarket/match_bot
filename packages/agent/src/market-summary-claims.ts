/** Whole-fit claims must agree with the server's essential-condition verdict, not just one price. */
export function claimsCompleteMarketFit(text: string): boolean {
  const claims =
    /(?:完全(?:符合|匹配)|符合(?:你|您)(?:的)?(?:所有|全部|各项)?(?:硬(?:性)?条件|要求|条件)|满足(?:全部|所有)(?:硬(?:性)?)?(?:条件|要求)|fully (?:matches|meets)|meets all (?:your )?(?:requirements|conditions))/gi;
  return [...text.matchAll(claims)].some((match) => {
    const prefix = text.slice(Math.max(0, match.index - 22), match.index);
    if (/(?:地点|房型|区域|日期|时间|月租|房租|单价|价格|水平|室内)(?:都|也)?$/.test(prefix))
      return false;
    return !/(?:不|未|不能|无法|尚未|是否|能否|才算|才能)(?:说|确认|判断|算)?\s*$|(?:not|cannot|can't|whether|would|could)\s+(?:say\s+)?$/i.test(
      prefix,
    );
  });
}

export function claimsUnverifiedTravelFit(text: string): boolean {
  const normalized = text.replace(/[ \t]/g, '');
  const chinese =
    /(?:半(?:个)?小时|\d+分钟|[一二两三四五六七八九十]+分钟)(?:以内|内|单程|路程){0,2}(?:应该|大概率|大概|基本|肯定|一定|绝对)?(?:都|也|就)?(?:够|没问题|能到|到得了|可以到)/g;
  for (const match of normalized.matchAll(chinese)) {
    const before = normalized.slice(Math.max(0, match.index - 24), match.index);
    const after = normalized.slice(
      match.index + match[0].length,
      match.index + match[0].length + 12,
    );
    const isCheck =
      /(?:是否|能否|确认|核实|问清|不能保证|无法保证|不敢保证|不确定)[^。！？；]{0,14}$/.test(
        before,
      ) && !/已(?:经)?(?:确认|核实)[^。！？；]{0,8}$/.test(before);
    const isUnknown = /(?:还|尚)?(?:没法|无法|不能|未能|没有|未)(?:确认|核实)/.test(after);
    if (!isCheck && (/应该|大概率|基本|肯定|一定|绝对/.test(match[0]) || !isUnknown)) return true;
  }
  const english =
    /\b(?:you\s+)?(?:should\s+be able to|can|will|should)\s+(?:get|make it|arrive|reach).{0,24}\bwithin\s+\d+\s*(?:minutes?|mins?)\b/gi;
  return [...text.matchAll(english)].some(
    (match) =>
      !/(?:check|confirm|verify|whether|if)[^.!?\n]{0,24}$/i.test(
        text.slice(Math.max(0, match.index - 36), match.index),
      ),
  );
}
