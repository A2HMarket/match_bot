import { demandDraftSchema, type DemandCategory, type DemandDraft } from '@matchbot/domain';
import { z } from 'zod';
import type { MatchContext } from './context.js';

export const currentRequestSchema = z.object({
  text: z.string().min(1).max(6000),
  demand: demandDraftSchema,
  isActionable: z.boolean(),
});
export type CurrentRequest = z.infer<typeof currentRequestSchema>;

function categoryFor(
  text: string,
  previous?: DemandDraft,
  requested?: DemandCategory,
): DemandCategory {
  if (/招聘|找工作|求职|job search|vacancy/i.test(text)) return 'job';
  if (
    /GP|NHS|机场|希思罗|heathrow|看展|展览|火锅|点心|早茶|超市|亲子|博物馆|散步|羽毛球|口语|搭子|帮带/i.test(
      text,
    )
  )
    return 'other';
  if (/退租.*清洁|清洁.*退租|end.of.tenancy|eot cleaning/i.test(text)) return 'eot_cleaning';
  if (/搬家|man.{0,8}van|need.{0,8}van|moving service/i.test(text)) return 'man_and_van';
  if (/安装|组装|assemble|assembly/i.test(text)) return 'furniture_service';
  if (/租房|房源|整租|单间|室友|合租|月租|roommate|rent|housing/i.test(text)) return 'housing';
  if (
    /打印机|小绿锅|书桌|办公椅|显示器|二手|想卖|求购|printer|monitor|desk|second.hand/i.test(text)
  )
    return 'second_hand';
  return requested ?? previous?.category ?? 'other';
}

/** P22：新请求只从本条原文建评估快照；指代旧回复时才保留同一需求背景。 */
export function bindCurrentRequest(ctx: MatchContext, input: string): void {
  const refinement =
    !!ctx.replyToBotText &&
    /^(?:这台|这家|这个|那台|它|那家|价格呢|有无线吗|does it|what about)/i.test(input.trim());
  const quoted = refinement ? ctx.replyToBotText : undefined;
  const budget = input.match(
    /(?:预算|每件|每人|月租|budget)[^\d]{0,8}(\d+(?:\.\d+)?)|(?:£)(\d+(?:\.\d+)?)/i,
  );
  const area = input.match(/\b(?:SE|SW|NW|EC|WC|E|W|N)\d{1,2}[A-Z]?\b/i)?.[0].toUpperCase();
  const need = input.trim() + (quoted ? '；引用回复：' + quoted : '');
  const demand: DemandDraft = {
    category: categoryFor(input + (quoted ?? ''), undefined, ctx.requestCategory),
    confidence: 1,
    need: need.slice(0, 80),
    ...(/\p{Script=Han}/u.test(input)
      ? { lang: 'zh' }
      : /^[\x00-\x7F]*$/.test(input)
        ? { lang: 'en' }
        : {}),
    ...(budget ? { budgetPence: Math.round(Number(budget[1] ?? budget[2]) * 100) } : {}),
    ...(area ? { fromPostcode: area } : {}),
  };
  ctx.currentRequest = currentRequestSchema.parse({
    text: input,
    demand,
    isActionable:
      /[?？]|吗|呢|想|找|推荐|怎么|哪里|有没有|有什么|有哪些|可以|预算|帮|求|需要|收|买|找人|need|find|buy|where|how|help|looking|recommend/i.test(
        input,
      ),
  });
  ctx.demand = demand;
  delete ctx.demandId;
}
