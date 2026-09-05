import { one, query } from '../lib/db.js';

/**
 * โควตาและค่าใช้จ่าย AI ของลูกค้าหนึ่งราย
 *
 * เดิมอยู่ใน caption.ts ตัวเดียว — ย้ายออกมาเมื่อมีการสร้างภาพ เพราะสองอย่างนี้
 * กินเงินก้อนเดียวกันแต่คนละอัตรา ถ้าต่างคนต่างนับ เพดานค่าใช้จ่ายจะไม่มีความหมาย
 *
 * อยู่ใน content/ ไม่ใช่ core/ เพราะเป็นโควตาของ "คนคิดคอนเทนต์"
 * (core/quota.ts เป็นคนละเรื่อง — นั่นคือเพดานการโพสต์ของ Instagram)
 * และกฎการแยกชั้นห้าม content/ import จาก core/
 *
 * มีสองเพดานที่ทำงานคนละหน้าที่ (รายงานข้อ B5/E7):
 *   - จำนวนครั้ง — กันคนกดรัวเล่น
 *   - ค่าใช้จ่าย  — กันบิลบานปลาย เพราะราคาต่อครั้งของภาพกับข้อความต่างกัน ~40 เท่า
 * และภาพมีเพดานของตัวเองอีกชั้น ไม่งั้นสร้างภาพอย่างเดียวก็กินโควตาแคปชั่นจนหมดเดือน
 */

export type AiKind = 'text' | 'image';

export type QuotaCheck = {
  allowed: boolean;
  reason?: string;
  used: number;
  limit: number;
  /** ใช้ไปกี่ USD เดือนนี้ */
  cost: number;
  costCap: number;
  /** ภาพที่สร้างไปแล้วเดือนนี้ / เพดานภาพ */
  images: number;
  imageLimit: number;
};

export async function checkAiQuota(tenantId: string, kind: AiKind = 'text'): Promise<QuotaCheck> {
  const row = await one<{
    calls: string; cost: string; call_cap: number; cost_cap: string;
    image_cap: number; images: string;
  }>(
    `SELECT COALESCE(u.calls,0)::text                    AS calls,
            COALESCE(u.cost_usd,0)::text                 AS cost,
            COALESCE(l.ai_calls_per_month, 300)          AS call_cap,
            COALESCE(l.ai_cost_cap_usd, 5.0)::text       AS cost_cap,
            COALESCE(l.ai_images_per_month, 60)          AS image_cap,
            (SELECT count(*) FROM ai_images i
              WHERE i.tenant_id = t.id
                AND i.created_at >= date_trunc('month', now()))::text AS images
       FROM tenants t
       LEFT JOIN tenant_limits l ON l.tenant_id = t.id
       LEFT JOIN ai_usage u ON u.tenant_id = t.id
                           AND u.period_month = date_trunc('month', now())::date
      WHERE t.id = $1`,
    [tenantId],
  );

  const used = Number(row?.calls ?? 0);
  const limit = Number(row?.call_cap ?? 300);
  const cost = Number(row?.cost ?? 0);
  const costCap = Number(row?.cost_cap ?? 5);
  const images = Number(row?.images ?? 0);
  const imageLimit = Number(row?.image_cap ?? 60);
  const base = { used, limit, cost, costCap, images, imageLimit };

  if (used >= limit) {
    return { allowed: false, reason: `ใช้โควตา AI ครบ ${limit} ครั้งของเดือนนี้แล้ว`, ...base };
  }
  if (cost >= costCap) {
    return { allowed: false, reason: `ค่าใช้จ่าย AI ถึงเพดาน ${costCap} USD ของเดือนนี้แล้ว`, ...base };
  }
  if (kind === 'image' && images >= imageLimit) {
    return {
      allowed: false,
      reason: `สร้างภาพครบ ${imageLimit} ใบของเดือนนี้แล้ว — ใช้รูปในคลังหรือรอเดือนหน้า`,
      ...base,
    };
  }
  return { allowed: true, ...base };
}

export async function recordAiUsage(
  tenantId: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
) {
  await query(
    `INSERT INTO ai_usage (tenant_id, period_month, calls, prompt_tokens, completion_tokens, cost_usd)
     VALUES ($1, date_trunc('month', now())::date, 1, $2, $3, $4)
     ON CONFLICT (tenant_id, period_month) DO UPDATE
       SET calls = ai_usage.calls + 1,
           prompt_tokens = ai_usage.prompt_tokens + EXCLUDED.prompt_tokens,
           completion_tokens = ai_usage.completion_tokens + EXCLUDED.completion_tokens,
           cost_usd = ai_usage.cost_usd + EXCLUDED.cost_usd`,
    [tenantId, promptTokens, completionTokens, costUsd],
  );
}
