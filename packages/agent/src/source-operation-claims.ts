/** A failed answer review is not evidence that the public source API failed. */
export function hasUnrecordedSourceFailureClaim(
  text: string,
  failures: readonly string[] = [],
): boolean {
  if (failures.some((failure) => /^(?:market|information|xhs|task_sources):/.test(failure)))
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
