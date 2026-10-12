import type { MatchContext } from './context.js';

/** Fixed public response: no model text, candidate names, claims, contacts or links. */
export function renderRequestStatus(ctx: MatchContext): string | null {
  if (
    !ctx.isRequestStatusRun ||
    !ctx.currentRequest?.isActionable ||
    ctx.answerRecorded ||
    ctx.currentRequest.demand.category === 'job'
  )
    return null;
  const unavailable =
    ctx.sourceFailures?.length &&
    !ctx.marketListings?.length &&
    !ctx.knowledgeSources?.length &&
    !ctx.xhsNotes?.length;
  const zh = ctx.currentRequest.demand.lang !== 'en';
  const intro = zh
    ? unavailable
      ? '这次查询没有完成，不能据此判断没有合适结果。'
      : '这次还没有核实出能可靠推荐的选项，不能把条件未知的线索说成已经匹配。'
    : unavailable
      ? 'This query could not complete; that does not mean no suitable options exist.'
      : 'I have not confirmed an option I can reliably recommend; unknown conditions are not a confirmed match.';
  if (!zh)
    return (
      intro +
      '\n\nPlease verify the exact terms, price, date and location with the provider. Which of your conditions can be flexible so I can search for clearly labelled alternatives?'
    );
  const category = ctx.currentRequest.demand.category;
  const intent = ctx.marketIntent;
  const text = ctx.currentRequest.text;
  const next =
    category === 'housing'
      ? '房型、月租、起租时间和宠物许可需要分别确认；租金下限不等于整月报价。除了当前区域，你还接受哪些相邻区域？我可以按这个范围再查。'
      : category === 'second_hand'
        ? '可先核对具体型号、单品价格与自提地点，再区分符合硬条件的物品和备选。你最多能接受多久的单程自提路程？'
        : intent === 'companion' || /搭子|羽毛球|口语|散步/.test(text)
          ? '地点、日期和活动水平都需要明确；“新生”不代表“初学者”。可以扩大到相邻区域找明确欢迎新手或能约定时间的活动。你最多能接受多久的单程通勤？'
          : intent === 'carry' || /帮带/.test(text)
            ? '下一步应分别确认航班日期、路线、重量与交接方式；方向不符或日期已过的帖子不能作备选。你希望在哪里、通过什么方式交接？'
            : category === 'furniture_service'
              ? '安装起价不能代表你的整单报价。可以把柜体尺寸、数量和内部配件发给商家核对固定总价；你的PAX是几组、总宽度多少，是否需要固定到墙上？'
              : category === 'eot_cleaning' || category === 'man_and_van'
                ? '参考起价不能代表整单报价，档期和服务范围也需要确认。建议按物品数量或房型、楼层、日期索取固定报价，并确认发票等要求。你还有哪些必须包含的服务？'
                : /点心|早茶/.test(text)
                  ? '现价、菜单和营业时段需要以店家最新信息核对，旧菜单不能直接当成当前预算依据。可以把超预算选项单独标出。你只考虑传统粤式茶楼，还是普通点心店也可以？'
                  : '下一步应优先核对官方现价、开放时间或时刻表，把已确认的信息和未知条件分开。你希望先补全哪一项信息？';
  return intro + '\n\n' + next;
}
