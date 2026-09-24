import type { SearchCandidate } from '@matchbot/websearch';
import { z } from 'zod';
import type { AgentDeps } from '../context.js';
import { groupReplyAddressing } from './addressing.js';
import { makeOutboundTool } from './make-outbound-tool.js';

/** 商家名单由代码按编号生成，模型只写开场白：搜索结果里的电话、链接一个字都不经模型之手。 */
export function renderCandidates(cs: SearchCandidate[]): string {
  return cs
    .map((c, i) => {
      const bits = [
        c.contact.phone ? `📞 ${c.contact.phone}` : null,
        c.contact.whatsapp ? `WhatsApp ${c.contact.whatsapp}` : null,
        c.contact.instagram ? `Instagram @${c.contact.instagram}` : null,
      ].filter(Boolean);
      return `${i + 1}. ${c.name}\n   ${bits.join(' · ')}\n   ${c.url}`;
    })
    .join('\n');
}

export function replyWithSearchResultsTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_with_search_results',
    description:
      "SENDS a reply in the group, under the user's message, listing 1-3 web_search results. You write only a one-sentence intro in the user's language; the tool appends the businesses and their contacts itself. Use only refs returned by web_search.",
    parameters: z.object({
      intro: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "One short sentence in the user's language. Do not name businesses or give contacts; they are appended automatically.",
        ),
      refs: z.array(z.string()).min(1).max(3).describe('refs from web_search, e.g. ["w1","w3"]'),
    }),
    toDraft: (ctx, args: { intro: string; refs: string[] }) => {
      const byRef = new Map((ctx.searchResults ?? []).map((c) => [c.ref, c]));
      const picked = [...new Set(args.refs)].map((r) => byRef.get(r));
      if (picked.length === 0 || picked.some((c) => !c)) {
        return Promise.resolve({
          error: 'unknown ref; call web_search and only use refs it returned',
        });
      }
      const cs = picked as SearchCandidate[];
      return Promise.resolve({
        kind: 'recommendation' as const,
        target: ctx.chatId,
        text: `${args.intro.trim()}\n\n${renderCandidates(cs)}`,
        supplierSummaries: cs.map((c) => c.name),
        inputRef: ctx.sourceMessageId,
        disclaimer: 'web' as const,
        ...groupReplyAddressing(ctx),
      });
    },
  });
}
