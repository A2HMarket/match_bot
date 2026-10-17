import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actorLabConfigSchema,
  loadActorLabConfig,
  ACTOR_PROFILES,
} from '../src/actor-lab-config.js';
const config = () => ({
  groupId: '-123',
  groupTitle: 'A2H 测试群',
  matchBotId: '999999',
  matchBotUsername: 'match_bot',
  controlDatabaseUrl: 'postgresql://local:local@127.0.0.1:5432/matchbot_actor_lab',
  actors: ACTOR_PROFILES.map((p, i) => ({
    id: String(111111 + i),
    username: `actor_${i}_bot`,
    token: `${111111 + i}:${'x'.repeat(32)}`,
    role: p.role,
    goal: p.goal,
    style: p.style,
    firstMessage: p.firstMessage,
  })),
});
describe('private actor configuration', () => {
  it('provides finite defaults and rejects cross-database or identity confusion', () => {
    expect(actorLabConfigSchema.parse(config()).maxMessages).toBe(6);
    for (const controlDatabaseUrl of [
      'postgresql://local:local@remote:5432/matchbot_actor_lab',
      'postgresql://local:local@localhost:5432/matchbot',
    ])
      expect(actorLabConfigSchema.safeParse({ ...config(), controlDatabaseUrl }).success).toBe(
        false,
      );
    const duplicate = config();
    duplicate.actors[1] = duplicate.actors[0]!;
    expect(actorLabConfigSchema.safeParse(duplicate).success).toBe(false);
    expect(actorLabConfigSchema.safeParse({ ...config(), matchBotId: '111111' }).success).toBe(
      false,
    );
    expect(actorLabConfigSchema.safeParse({ ...config(), maxMessages: 13 }).success).toBe(false);
  });
  it('requires private file permissions and hides invalid token values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'actor-lab-test-')),
      path = join(dir, 'private.json');
    try {
      writeFileSync(path, JSON.stringify(config()), { mode: 0o600 });
      expect(loadActorLabConfig(path).actors).toHaveLength(3);
      chmodSync(path, 0o644);
      expect(() => loadActorLabConfig(path)).toThrow('actor_config_must_be_private_0600');
      chmodSync(path, 0o600);
      writeFileSync(path, '{"token":"SECRET"}');
      expect(() => loadActorLabConfig(path)).toThrow('invalid_actor_lab_configuration');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
