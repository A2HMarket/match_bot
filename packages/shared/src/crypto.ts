import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * run_states.snapshot 落库前加密（AGENTS.md §6）。AES-256-GCM；密钥由 SNAPSHOT_KEY 经
 * sha256 派生，任意长度口令均可。格式：`v1.<iv b64>.<tag b64>.<ciphertext b64>`。
 */
export function encrypt(text: string, key: string): string {
  const k = createHash('sha256').update(key, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string, key: string): string {
  const [v, iv, tag, data] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('unrecognized encrypted payload format');
  const k = createHash('sha256').update(key, 'utf8').digest();
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
