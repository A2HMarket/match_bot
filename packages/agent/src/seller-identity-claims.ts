/** The public offer contract supplies no verified seller identity; separate post IDs prove neither sameness nor difference. */
export function hasUnqualifiedSellerIdentity(text: string): boolean {
  return text.split(/[。！？!?；;，,\n]/).some((clause) => {
    const claim =
      /(?:不同(?:的)?|同一(?:个|位)?|(?:两|2)(?:个|位|名|家)|(?:另一|另外一|第二)(?:个|位|名|家)?|别的)\s*(?:卖家|发布者|贴主|发帖人|房东|商家|店家|出租方|发起人|组织者)|\b(?:different|same|two|another)\s+(?:sellers?|posters?)\b/i.exec(
        clause,
      );
    if (!claim) return false;
    const before = clause.slice(0, claim.index),
      after = clause.slice(claim.index + claim[0].length);
    return (
      !/(?:是否(?:为|是|来自|属于)?|是不是|如果(?:是|为)?|若是|不代表|不能说明|不能证明|不能确认|无法确认|无法判断|尚未确认|原文称|原文写(?:明)?|帖子称|你希望|你要求|偏好|最好|\b(?:whether|if|unknown|not known|source says|prefer)\b(?:\s+\w+){0,3})[\s“"：:]*$/i.test(
        before,
      ) && !/^\s*(?:还没确认|尚未确认|未确认|是否|不确定|is unknown)/i.test(after)
    );
  });
}
