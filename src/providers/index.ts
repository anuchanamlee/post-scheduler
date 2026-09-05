import { one } from '../lib/db.js';
import { open } from '../lib/crypto.js';
import { MetaProvider } from './meta/index.js';
import { MockProvider } from './mock.js';
import type { PublishProvider, TargetPage } from './types.js';

/**
 * ทะเบียน provider — จุดเดียวที่รู้ว่ามีผู้ให้บริการกี่เจ้า
 *
 * เพิ่ม TikTok / LINE OA วันหน้า = เขียนคลาสที่ implement PublishProvider แล้วลงทะเบียนที่นี่
 * ถ้าวันหนึ่งกลับไปทำ App Review เต็มรูปแบบ หรือย้ายไป aggregator ก็เปลี่ยนแค่ชั้นนี้
 */

const registry = new Map<string, PublishProvider>();

/** ถอดรหัส System User token ของเพจนั้น — token ไม่เคยออกจากฝั่งเซิร์ฟเวอร์ */
async function resolveTokenForPage(page: TargetPage): Promise<string> {
  const row = await one<{
    token_ciphertext: string;
    token_iv: string;
    token_auth_tag: string;
    key_version: number;
    status: string;
  }>(
    `SELECT c.token_ciphertext, c.token_iv, c.token_auth_tag, c.key_version, c.status
       FROM meta_credentials c
       JOIN page_credentials pc ON pc.credential_id = c.id
      WHERE pc.page_id = $1
      ORDER BY c.updated_at DESC
      LIMIT 1`,
    [page.id],
  );
  if (!row) throw new Error(`ไม่มี credential ผูกกับเพจ ${page.displayName}`);
  if (row.status === 'revoked') throw new Error(`credential ของเพจ ${page.displayName} ถูกเพิกถอนแล้ว`);

  return open({
    ciphertext: row.token_ciphertext,
    iv: row.token_iv,
    authTag: row.token_auth_tag,
    keyVersion: row.key_version,
  });
}

export function getProvider(name: string): PublishProvider {
  const existing = registry.get(name);
  if (existing) return existing;

  let provider: PublishProvider;
  switch (name) {
    case 'meta':
      provider = new MetaProvider(resolveTokenForPage, process.env.META_APP_SECRET);
      break;
    case 'mock':
      provider = new MockProvider();
      break;
    default:
      throw new Error(`ไม่รู้จัก provider "${name}"`);
  }
  registry.set(name, provider);
  return provider;
}

export function listProviders(): string[] {
  return ['meta', 'mock'];
}

export * from './types.js';
export * from './errors.js';
