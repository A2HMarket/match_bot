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
