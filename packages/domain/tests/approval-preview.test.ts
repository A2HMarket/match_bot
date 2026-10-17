import { expect, it } from 'vitest';
import { formatApprovalPreview } from '../src/approval-preview.js';
it('shows all frozen drafts exactly and refuses absent, malformed or oversized previews', () => {
  const first = { tool: 'reply_to_request', draftText: '实际正文 [来源](https://example.test)' };
  expect(formatApprovalPreview([first])).toContain(first.draftText);
  const all = formatApprovalPreview([first, { tool: 'notify_user', draftText: '第二段完整正文' }]);
  expect(all).toContain('1/2');
  expect(all).toContain('2/2');
  expect(all).toContain('第二段完整正文');
  expect(() => formatApprovalPreview([])).toThrow();
  expect(() =>
    formatApprovalPreview([{ tool: 'reply_to_request', args: '{"text":"uncompiled"}' }]),
  ).toThrow();
  expect(() =>
    formatApprovalPreview([
      { ...first, draftText: '字'.repeat(4000) },
      { ...first, draftText: '字'.repeat(4000) },
    ]),
  ).toThrow();
  expect(
    formatApprovalPreview([{ ...first, draftText: '字'.repeat(4000) }]).length,
  ).toBeLessThanOrEqual(4096);
});
