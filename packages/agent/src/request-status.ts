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
      ? '这次查询没能完成，还不能判断有没有合适的。'
      : '还没核实到能推荐的合适线索，有些关键条件还不清楚。'
    : unavailable
      ? 'This query could not complete; that does not mean no suitable options exist.'
      : "I haven't confirmed a suitable lead yet; some important details are still unclear.";
  const task =
    ctx.task?.ownerUserId === ctx.userId &&
    ctx.task.scope.chatId === ctx.chatId &&
    ctx.task.scope.channel === (ctx.channel ?? 'telegram')
      ? ctx.task
      : undefined;
  if (task?.constraints.some((c) => c.key === 'max_travel_minutes'))
    return (
      intro +
      (zh
        ? '\n\n通勤范围就按你前面说的，不用再补。接下来要核对具体地点和适用条件，再看哪些线索值得继续聊。'
        : '\n\nYour travel limit is retained; you do not need to repeat it. The next step is to verify the source location and suitability, then compare using the same conditions. Missing facts are not a confirmed match.')
    );
  if (
    task?.category === 'housing' &&
    task.constraints.some((c) => c.key === 'area' && c.strength === 'hard')
  )
    return (
      intro +
      (zh
        ? '\n\n区域和条件就按你前面说的。房型、费用、起租和宠物许可还需要核实，确认后才好比较。'
        : '\n\nYour required area and conditions are retained. The next step is to verify the room type, rent, move-in terms and pet permission without treating missing facts as a match.')
    );
  const knownObstacle =
    /急用|现在就要|出门不方便|出不了门|走不了|行动不便|urgent|cannot leave|can't (?:leave|get out)|unable to go out/i.test(
      ctx.currentRequest.text,
    );
  if (!zh)
    return (
      intro +
      (knownObstacle
        ? '\n\nYour practical difficulty is retained; you do not need to repeat it. The next step is to verify a feasible channel within those limits, keeping unknown availability explicit.'
        : '\n\nWhat is making this difficult right now: finding a suitable channel, timing, or getting there?')
    );
  const category = ctx.currentRequest.demand.category;
  const intent = ctx.marketIntent;
  const text = ctx.currentRequest.text;
  const next =
    category === 'housing'
      ? '房型、月租、起租时间和宠物许可需要分别确认；租金下限不等于整月报价。除了当前区域，你还接受哪些相邻区域？我可以按这个范围再查。'
      : category === 'second_hand'
        ? '先核对型号、实际价格和取货地点，再看哪件值得继续聊。你最多能接受多久的单程自提路程？'
        : intent === 'companion' || /搭子|羽毛球|口语|散步/.test(text)
          ? '地点、时间和是否适合新手还要确认。也可以看看相邻区域有没有明确欢迎新手的活动。你最多能接受多久的单程通勤？'
          : intent === 'carry' || /帮带/.test(text)
            ? '下一步应分别确认航班日期、路线、重量与交接方式；方向不符或日期已过的帖子不能作备选。你希望在哪里、通过什么方式交接？'
            : category === 'furniture_service'
              ? '安装起价不能代表你的整单报价。可以把柜体尺寸、数量和内部配件发给商家核对固定总价；你的PAX是几组、总宽度多少，是否需要固定到墙上？'
              : category === 'eot_cleaning' || category === 'man_and_van'
                ? '参考起价不能代表整单报价，档期和服务范围也需要确认。建议按物品数量或房型、楼层、日期索取固定报价，并确认发票等要求。你还有哪些必须包含的服务？'
                : /点心|早茶/.test(text)
                  ? '现价、菜单和营业时段需要以店家最新信息核对，旧菜单不能直接当成当前预算依据。可以把超预算选项单独标出。你只考虑传统粤式茶楼，还是普通点心店也可以？'
                  : knownObstacle
                    ? '你已经说过的困难不用再补。接下来要按这些限制核对可行渠道和实际可用情况，不能把未知说成确定。'
                    : '你现在主要卡在找不到渠道，还是时间、出行不方便？这会影响先找哪种办法；已经说过的条件不用重复。';
  return intro + '\n\n' + next;
}
