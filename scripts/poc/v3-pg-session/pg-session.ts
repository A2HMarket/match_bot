import type { AgentInputItem, Session } from '@openai/agents';
import pg from 'pg';

/**
 * Minimal Postgres-backed implementation of the SDK's `Session` interface.
 * Real signature (node_modules/@openai/agents-core/dist/memory/session.d.ts):
 *   getSessionId(): Promise<string>
 *   getItems(limit?: number): Promise<AgentInputItem[]>
 *   addItems(items: AgentInputItem[]): Promise<void>
 *   popItem(): Promise<AgentInputItem | undefined>   // note: undefined, not null
 *   clearSession(): Promise<void>
 * plus five OPTIONAL hooks (prepareHistoryItemForModelInput,
 * prepareHistoryItemsForPersistenceComparison, preserveReasoningItemIdsForPersistence,
 * replaceHistoryWithCompaction) that we do not implement.
 */
export class PgSession implements Session {
  constructor(
    private readonly pool: pg.Pool,
    private readonly userId: string,
  ) {}

  async getSessionId(): Promise<string> {
    return this.userId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    // "last N in chronological order" per the SDK doc comment on getItems.
    const sql = limit
      ? 'SELECT item FROM (SELECT seq, item FROM poc_session_items WHERE user_id=$1 ORDER BY seq DESC LIMIT $2) t ORDER BY seq'
      : 'SELECT item FROM poc_session_items WHERE user_id=$1 ORDER BY seq';
    const params = limit ? [this.userId, limit] : [this.userId];
    const r = await this.pool.query(sql, params);
    return r.rows.map((x) => x.item as AgentInputItem);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    for (const item of items) {
      await this.pool.query(
        'INSERT INTO poc_session_items(user_id, seq, item) VALUES ($1, (SELECT COALESCE(MAX(seq),0)+1 FROM poc_session_items WHERE user_id=$1), $2)',
        [this.userId, JSON.stringify(item)],
      );
    }
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const r = await this.pool.query(
      'DELETE FROM poc_session_items WHERE user_id=$1 AND seq=(SELECT MAX(seq) FROM poc_session_items WHERE user_id=$1) RETURNING item',
      [this.userId],
    );
    return (r.rows[0]?.item as AgentInputItem) ?? undefined;
  }

  async clearSession(): Promise<void> {
    await this.pool.query('DELETE FROM poc_session_items WHERE user_id=$1', [this.userId]);
  }
}
