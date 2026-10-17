/** A failed answer review is not evidence that the public source API failed. */
export function hasUnrecordedSourceFailureClaim(
  text: string,
  failures: readonly string[] = [],
): boolean {
  if (
    failures.some((failure) =>
      /^(?:market|information|xhs|xiaohongshu|task_sources):/.test(failure),
    )
  )
    return false;
  const claim =
    /(?:搜索|查询|检索|接口|网站|search|query|api|website).{0,24}?(?:没能正常(?:跑起来|运行)|(?:报错|失败|不可用|无法连接)|(?:failed|unavailable|could not (?:run|connect|retrieve)))/i;
  return text.split(/[。！？!?；;\n]/).some((sentence) => {
    const match = claim.exec(sentence);
    if (!match) return false;
    // Only a condition preceding the claim qualifies; a later "if" does not undo a factual claim.
    return !/(?:如果|若是|假如|倘若|(?:^|\s)if\b)/i.test(sentence.slice(0, match.index));
  });
}

/** Published shop details cannot guarantee that the user will obtain an item on arrival. */
export function hasGuaranteedPurchaseClaim(text: string): boolean {
  const claims =
    /走过去就(?:能|可以)买(?:到)?|(?:肯定|保证|一定)(?:有货|买得到|能买到)|(?:you can|you'll|you will) (?:just )?(?:walk|go)[^.!?\n]{0,20}(?:and|to) (?:buy|collect|pick up)/gi;
  return [...text.matchAll(claims)].some((match) => {
    const prefix = text.slice(Math.max(0, match.index - 35), match.index);
    return !/(?:不|未|不能保证|无法保证|不保证|不确定|不能说|别以为)[^，,。\n]{0,8}$|(?:cannot guarantee|can't promise|cannot say)\s*$/i.test(
      prefix,
    );
  });
}
