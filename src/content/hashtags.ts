import { query } from '../lib/db.js';

/**
 * แฮชแท็ก
 *
 * แยกจากแคปชั่นโดยตั้งใจ — ร้านค้าใช้แท็กประจำซ้ำๆ (#ชื่อร้าน #ย่าน) เพราะนั่นคือ
 * สิ่งที่คนกดตามและค้นเจอ ถ้าให้ AI คิดใหม่ทุกครั้งจะได้แท็กที่ไม่มีใครติดตาม
 * และสะกดชื่อร้านไม่เหมือนเดิมทุกโพสต์
 *
 * AI มีหน้าที่แค่เสนอแท็กเพิ่มตามเนื้อหาโพสต์ ไม่ใช่แทนที่ชุดประจำ
 */

export type HashtagSet = {
  id: string;
  page_id: string | null;
  name: string;
  tags: string[];
  is_default: boolean;
};

/** Instagram นับแท็กได้ 30 อันต่อโพสต์ เกินนั้นโพสต์ไม่ขึ้น */
export const MAX_TAGS_IG = 30;

export async function listSets(tenantId: string): Promise<HashtagSet[]> {
  return query<HashtagSet>(
    `SELECT id, page_id, name, tags, is_default
       FROM hashtag_sets WHERE tenant_id = $1
      ORDER BY is_default DESC, name`,
    [tenantId],
  );
}

/** ทำความสะอาดแท็กที่คนพิมพ์มา — เติม # ให้ ตัดช่องว่าง ตัดซ้ำ */
export function normalizeTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,\n]+/)) {
    const t = raw.trim().replace(/^#+/, '');
    if (!t) continue;
    const tag = `#${t}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export async function saveSet(args: {
  tenantId: string; id?: string; name: string; tags: string[];
  pageId?: string | null; isDefault?: boolean;
}) {
  if (!args.name.trim()) throw new Error('ตั้งชื่อชุดแท็กด้วย');
  if (args.tags.length === 0) throw new Error('ใส่แท็กอย่างน้อย 1 อัน');
  if (args.tags.length > MAX_TAGS_IG) {
    throw new Error(`ชุดเดียวใส่ได้ไม่เกิน ${MAX_TAGS_IG} แท็ก (ข้อจำกัดของ Instagram)`);
  }

  if (args.id) {
    await query(
      `UPDATE hashtag_sets SET name = $3, tags = $4::text[], page_id = $5, is_default = $6
        WHERE tenant_id = $1 AND id = $2`,
      [args.tenantId, args.id, args.name.trim(), args.tags,
       args.pageId ?? null, args.isDefault ?? false],
    );
  } else {
    await query(
      `INSERT INTO hashtag_sets (tenant_id, name, tags, page_id, is_default)
       VALUES ($1,$2,$3::text[],$4,$5)
       ON CONFLICT (tenant_id, name) DO UPDATE SET tags = EXCLUDED.tags`,
      [args.tenantId, args.name.trim(), args.tags, args.pageId ?? null,
       args.isDefault ?? false],
    );
  }
}

export async function removeSet(tenantId: string, id: string) {
  await query(`DELETE FROM hashtag_sets WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
}

/**
 * ต่อแท็กเข้ากับแคปชั่น
 *
 * วางไว้ท้ายสุดคั่นด้วยบรรทัดว่าง — เป็นแบบที่เพจไทยใช้กันจริง
 * และทำให้แคปชั่นส่วนที่คนอ่านไม่ถูกแท็กบังตอนฟีดตัดข้อความ
 */
export function appendTags(caption: string, tags: string[]): string {
  if (tags.length === 0) return caption;
  const existing = new Set(
    (caption.match(/#[^\s#]+/g) ?? []).map((t) => t.toLowerCase()),
  );
  const add = tags.filter((t) => !existing.has(t.toLowerCase()));
  if (add.length === 0) return caption;
  return `${caption.trimEnd()}\n\n${add.join(' ')}`;
}

export function countTags(caption: string): number {
  return (caption.match(/#[^\s#]+/g) ?? []).length;
}
