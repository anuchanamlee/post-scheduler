import { one, query, tx } from '../lib/db.js';
import { seal } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';

/**
 * เชื่อมต่อเพจกับ token
 *
 * เดิมขั้นตอนนี้ทำผ่าน SQL ตาม runbook — ใช้ได้ตอนที่คนตั้งค่าคือคนเขียนระบบ
 * แต่ทุกครั้งที่ token พัง (ลูกค้าเพิกถอนสิทธิ์ · BM ถูกระงับ) ต้องมีคนเปิด psql
 * ซึ่งแปลว่าลูกค้าแก้เองไม่ได้เลย และเราต้องว่างพอดีทุกครั้ง
 *
 * token ไม่เคยถูกอ่านกลับมาแสดง — เข้ารหัสตอนบันทึก ถอดเฉพาะตอนยิง API เท่านั้น
 */

export type ConnectionInput = {
  tenantId: string;
  platform: 'facebook' | 'instagram';
  remoteId: string;
  displayName: string;
  token: string;
  provider?: string;
  appId?: string;
  businessId?: string;
  systemUserId?: string;
};

/** เพิ่มเพจใหม่พร้อม token — สร้างทั้งเพจและ credential ในทีเดียว */
export async function connectPage(input: ConnectionInput) {
  if (!input.remoteId.trim()) throw new Error('ต้องใส่ ID ของเพจหรือบัญชี Instagram');
  if (!input.token.trim()) throw new Error('ต้องใส่ access token');
  if (!input.displayName.trim()) throw new Error('ตั้งชื่อเรียกเพจด้วย');

  const sealed = seal(input.token.trim());

  return tx(async (client) => {
    const page = await client.query<{ id: string }>(
      `INSERT INTO social_pages (tenant_id, platform, provider, remote_id, display_name)
       VALUES ($1, $2::platform, $3, $4, $5)
       ON CONFLICT (tenant_id, platform, remote_id)
         DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true
       RETURNING id`,
      [input.tenantId, input.platform, input.provider ?? 'meta',
       input.remoteId.trim(), input.displayName.trim()],
    );

    const cred = await client.query<{ id: string }>(
      `INSERT INTO meta_credentials
         (tenant_id, label, token_ciphertext, token_iv, token_auth_tag, key_version,
          app_id, business_id, system_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unchecked') RETURNING id`,
      [input.tenantId, `token ของ ${input.displayName.trim()}`,
       sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion,
       input.appId ?? null, input.businessId ?? null, input.systemUserId ?? null],
    );

    // เพจหนึ่งใช้ token ล่าสุดเสมอ — ของเก่าเก็บไว้เป็นประวัติแต่ไม่ผูกแล้ว
    await client.query(`DELETE FROM page_credentials WHERE page_id = $1`, [page.rows[0].id]);
    await client.query(
      `INSERT INTO page_credentials (page_id, credential_id) VALUES ($1,$2)`,
      [page.rows[0].id, cred.rows[0].id],
    );

    return { pageId: page.rows[0].id, credentialId: cred.rows[0].id };
  });
}

/** เปลี่ยน token ของเพจที่มีอยู่ — ใช้ตอน token เดิมพัง */
export async function replaceToken(tenantId: string, pageId: string, token: string) {
  if (!token.trim()) throw new Error('ต้องใส่ access token ตัวใหม่');

  const page = await one<{ display_name: string }>(
    `SELECT display_name FROM social_pages WHERE tenant_id = $1 AND id = $2`,
    [tenantId, pageId],
  );
  if (!page) throw new Error('ไม่พบเพจนี้');

  const sealed = seal(token.trim());
  return tx(async (client) => {
    const cred = await client.query<{ id: string }>(
      `INSERT INTO meta_credentials
         (tenant_id, label, token_ciphertext, token_iv, token_auth_tag, key_version, status)
       VALUES ($1,$2,$3,$4,$5,$6,'unchecked') RETURNING id`,
      [tenantId, `token ของ ${page.display_name}`,
       sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
    );
    await client.query(`DELETE FROM page_credentials WHERE page_id = $1`, [pageId]);
    await client.query(
      `INSERT INTO page_credentials (page_id, credential_id) VALUES ($1,$2)`,
      [pageId, cred.rows[0].id],
    );
    return cred.rows[0];
  });
}

/**
 * ตรวจว่า token ยังใช้ได้จริงไหม แล้วบันทึกผล
 * ให้คนกดเองได้ ไม่ต้องรอให้โพสต์ล้มก่อนถึงจะรู้
 */
export async function verifyConnection(tenantId: string, pageId: string) {
  const page = await one<{
    id: string; platform: string; provider: string; remote_id: string;
    display_name: string; timezone: string;
  }>(
    `SELECT id, platform::text, provider, remote_id, display_name, timezone
       FROM social_pages WHERE tenant_id = $1 AND id = $2`,
    [tenantId, pageId],
  );
  if (!page) throw new Error('ไม่พบเพจนี้');

  const provider = getProvider(page.provider);
  const result = await provider.checkCredential({
    id: page.id,
    platform: page.platform as 'facebook' | 'instagram',
    provider: page.provider,
    remoteId: page.remote_id,
    displayName: page.display_name,
    timezone: page.timezone,
  });

  await query(
    `UPDATE meta_credentials c
        SET status = $2::credential_status, last_checked_at = now(),
            last_error_code = $3, last_error_message = $4, updated_at = now()
       FROM page_credentials pc
      WHERE pc.credential_id = c.id AND pc.page_id = $1`,
    [pageId, result.ok ? 'healthy' : 'invalid',
     result.code ?? null, result.ok ? null : (result.message ?? 'ตรวจไม่ผ่าน')],
  );

  return result;
}

/** ปิดเพจไม่ให้ใช้งาน — ไม่ลบ เพราะโพสต์เก่ายังอ้างถึงอยู่ */
export async function disconnectPage(tenantId: string, pageId: string) {
  const pending = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM post_targets t
       JOIN scheduled_posts p ON p.id = t.post_id
      WHERE t.tenant_id = $1 AND t.page_id = $2 AND t.status = 'pending'
        AND p.status NOT IN ('cancelled', 'missed')`,
    [tenantId, pageId],
  );
  if (Number(pending?.n ?? 0) > 0) {
    throw new Error(
      `ยังมีโพสต์ ${pending!.n} ชิ้นรอส่งไปเพจนี้ — ยกเลิกหรือย้ายปลายทางก่อน`,
    );
  }

  await query(
    `UPDATE social_pages SET is_active = false WHERE tenant_id = $1 AND id = $2`,
    [tenantId, pageId],
  );
}
