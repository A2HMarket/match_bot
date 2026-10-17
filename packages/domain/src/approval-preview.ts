import { z } from 'zod';

const previews = z
  .array(
    z.object({ tool: z.string().regex(/^[a-z_]{1,64}$/), draftText: z.string().min(1).max(4000) }),
  )
  .min(1)
  .max(12);
/** Human approval covers every frozen outbound draft, with no truncation or model-argument fallback. */
export function formatApprovalPreview(input: unknown): string {
  const rows = previews.parse(input);
  return z
    .string()
    .max(4096)
    .parse(
      '🔎 待审批\n\n' +
        rows
          .map((row, index) => `拟发 ${index + 1}/${rows.length} · ${row.tool}\n${row.draftText}`)
          .join('\n\n'),
    );
}
