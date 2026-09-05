import { one, query } from '../lib/db.js';
import { storage } from '../lib/storage.js';

/**
 * คลังรูป — ของทุกใบที่ลูกค้าเคยทำหรืออัปโหลด
 *
 * ทำไมต้องมี: รูปสินค้ากับโปสเตอร์คือของที่ร้านลงแรงทำเอง ใช้ครั้งเดียวแล้วหาไม่เจอ
 * = ต้องทำใหม่ทุกครั้ง เดือนหน้าจัดโปรเดิมก็ถ่ายรูปใหม่ทั้งที่ของเดิมยังใช้ได้
 *
 * "ประวัติภาพย้อนหลัง" กับ "ดาวน์โหลดไฟล์ความละเอียดสูง" เป็นสองข้อที่เขียนไว้ใน
 * ข้อเสนอแพ็กเกจ 1 — รอบนี้ทำให้มีจริง
 */

export type LibraryItem = {
  id: string;
  url: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  bytes: string | null;
  original_name: string | null;
  created_at: Date;
  kind: 'poster' | 'ai' | 'upload';
  /** เทมเพลตที่ใช้ ถ้าเป็นโปสเตอร์ */
  template_id: string | null;
  /** ใช้อยู่ในโพสต์กี่ชิ้น — ของที่ใช้อยู่ห้ามลบ */
  used_in: number;
  /** ยังมีโพสต์ที่ยังไม่ออกใช้รูปนี้อยู่ไหม */
  in_use_pending: boolean;
  variants: Array<{ aspect_ratio: string; url: string }>;
};

export async function listLibrary(
  tenantId: string,
  filter: 'all' | 'poster' | 'ai' | 'upload' = 'all',
  limit = 60,
): Promise<LibraryItem[]> {
  const rows = await query<LibraryItem>(
    `SELECT a.id, a.public_url AS url, a.storage_key, a.width, a.height,
            a.bytes::text, a.original_name, a.created_at,
            -- ภาพ AI ต้องแยกให้เห็นในคลัง เจ้าของร้านต้องรู้ว่าใบไหนไม่ใช่ของถ่ายจริง
            CASE WHEN d.id IS NOT NULL THEN 'poster'
                 WHEN ai.id IS NOT NULL THEN 'ai'
                 ELSE 'upload' END AS kind,
            d.template_id,
            COALESCE(u.n, 0)::int AS used_in,
            COALESCE(u.pending, false) AS in_use_pending,
            COALESCE((
              SELECT json_agg(json_build_object('aspect_ratio', v.aspect_ratio,
                                                'url', v.public_url)
                              ORDER BY v.aspect_ratio)
                FROM media_variants v WHERE v.asset_id = a.id
            ), '[]') AS variants
       FROM media_assets a
       LEFT JOIN poster_designs d ON d.asset_id = a.id
       LEFT JOIN ai_images ai ON ai.asset_id = a.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n,
                bool_or(p.status NOT IN ('posted', 'cancelled', 'failed', 'missed')) AS pending
           FROM post_media pm
           JOIN scheduled_posts p ON p.id = pm.post_id
          WHERE pm.asset_id = a.id
       ) u ON true
      WHERE a.tenant_id = $1
        AND a.status = 'ready'
        -- รูปที่เป็นวัตถุดิบของโปสเตอร์ ไม่ต้องโชว์ซ้ำกับตัวโปสเตอร์เอง
        AND NOT EXISTS (SELECT 1 FROM poster_designs pd WHERE pd.photo_asset_id = a.id)
        AND ($2 = 'all'
             OR ($2 = 'poster' AND d.id IS NOT NULL)
             OR ($2 = 'ai' AND ai.id IS NOT NULL)
             OR ($2 = 'upload' AND d.id IS NULL AND ai.id IS NULL))
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [tenantId, filter, limit],
  );
  return rows;
}

export async function libraryCounts(tenantId: string) {
  const r = await one<{
    total: string; posters: string; ai_images: string; uploads: string; bytes: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE d.id IS NOT NULL)::text AS posters,
            count(*) FILTER (WHERE ai.id IS NOT NULL)::text AS ai_images,
            count(*) FILTER (WHERE d.id IS NULL AND ai.id IS NULL)::text AS uploads,
            COALESCE(sum(a.bytes), 0)::text AS bytes
       FROM media_assets a
       LEFT JOIN poster_designs d ON d.asset_id = a.id
       LEFT JOIN ai_images ai ON ai.asset_id = a.id
      WHERE a.tenant_id = $1 AND a.status = 'ready'`,
    [tenantId],
  );
  return {
    total: Number(r?.total ?? 0),
    posters: Number(r?.posters ?? 0),
    aiImages: Number(r?.ai_images ?? 0),
    uploads: Number(r?.uploads ?? 0),
    bytes: Number(r?.bytes ?? 0),
  };
}

/**
 * ลบรูปออกจากคลัง
 *
 * ห้ามลบของที่ยังมีโพสต์รอส่งใช้อยู่ — ไม่งั้นถึงเวลาโพสต์แล้วรูปหาย
 * ลบไฟล์จริงออกจากที่เก็บด้วย ไม่ใช่แค่ซ่อนแถวใน DB (ค่าเก็บของยังเดินอยู่)
 */
export async function deleteAsset(tenantId: string, assetId: string) {
  const asset = await one<{ storage_key: string; pending: boolean }>(
    `SELECT a.storage_key,
            COALESCE((
              SELECT bool_or(p.status NOT IN ('posted','cancelled','failed','missed'))
                FROM post_media pm JOIN scheduled_posts p ON p.id = pm.post_id
               WHERE pm.asset_id = a.id
            ), false) AS pending
       FROM media_assets a
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, assetId],
  );
  if (!asset) throw new Error('ไม่พบรูปนี้');
  if (asset.pending) {
    throw new Error('ลบไม่ได้ — ยังมีโพสต์ที่ยังไม่ออกใช้รูปนี้อยู่ ยกเลิกโพสต์นั้นก่อน');
  }

  const variants = await query<{ storage_key: string }>(
    `SELECT storage_key FROM media_variants WHERE asset_id = $1`, [assetId]);

  // ลบแถวก่อน ถ้าไฟล์ลบไม่สำเร็จก็ยังดีกว่าปล่อยให้แถวชี้ไปไฟล์ที่หายแล้ว
  await query(`DELETE FROM media_assets WHERE tenant_id = $1 AND id = $2`, [tenantId, assetId]);

  for (const key of [asset.storage_key, ...variants.map((v) => v.storage_key)]) {
    await storage().delete(key).catch(() => { /* ไฟล์หายไปแล้วก็ถือว่าสำเร็จ */ });
  }
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
