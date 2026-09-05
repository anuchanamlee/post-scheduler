import { query } from '../lib/db.js';
import { getProvider } from '../providers/index.js';

/**
 * เก็บสถิติผลตอบรับของโพสต์ที่ขึ้นไปแล้ว
 *
 * ทำไมเก็บเป็นช่วงเวลา ไม่ใช่ตัวเลขล่าสุดตัวเดียว (รายงานข้อ C7):
 * ยอดหลังโพสต์ 1 ชั่วโมงบอกว่า "เวลานี้คนเห็นไหม" · ยอด 24 ชั่วโมงบอกว่า "คอนเทนต์นี้ดีไหม"
 * ถ้าเก็บทับกันตัวเดียวจะแยกสองเรื่องนี้ไม่ออก และเปรียบเทียบข้ามโพสต์ไม่ได้
 * เพราะโพสต์ที่ขึ้นเมื่อวานกับเมื่อเดือนที่แล้วมีเวลาสะสมยอดไม่เท่ากัน
 *
 * ตัวเลขที่ Meta ให้มาเปลี่ยนได้ตลอด (ลบคอมเมนต์ ยกเลิกไลก์) — เก็บทับ bucket เดิมได้
 * แต่ไม่ย้อนไปแก้ bucket ที่ผ่านช่วงเวลาไปแล้ว
 */

/** ช่วงเวลาที่เก็บ นับจากเวลาที่โพสต์ขึ้นจริง */
export const BUCKETS = [
  { id: '1h', afterMs: 60 * 60_000, label: '1 ชั่วโมงแรก' },
  { id: '24h', afterMs: 24 * 60 * 60_000, label: '24 ชั่วโมง' },
  { id: '7d', afterMs: 7 * 24 * 60 * 60_000, label: '7 วัน' },
] as const;

export type Metrics = {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
};

/**
 * เก็บสถิติของ target ที่ถึงเวลาเก็บแล้วและยังไม่เคยเก็บใน bucket นั้น
 * คืนจำนวนที่เก็บได้จริง
 */
export async function collectDue(limit = 20): Promise<number> {
  let collected = 0;

  for (const bucket of BUCKETS) {
    const due = await query<{
      target_id: string; tenant_id: string; remote_id: string; platform: string;
      provider: string; page_id: string; remote_page_id: string; page_name: string;
      page_timezone: string;
    }>(
      `SELECT t.id AS target_id, t.tenant_id, t.remote_id, t.platform::text,
              sp.provider, sp.id AS page_id, sp.remote_id AS remote_page_id,
              sp.display_name AS page_name, sp.timezone AS page_timezone
         FROM post_targets t
         JOIN social_pages sp ON sp.id = t.page_id
        WHERE t.status = 'posted'
          AND t.remote_id IS NOT NULL
          AND t.updated_at < now() - ($2 || ' milliseconds')::interval
          -- ไม่เก็บของที่เก่าเกินไป — ย้อนหลังไปเก็บ 7d ของโพสต์เมื่อปีที่แล้วไม่มีประโยชน์
          AND t.updated_at > now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM post_metrics m
             WHERE m.target_id = t.id AND m.age_bucket = $3
          )
        ORDER BY t.updated_at
        LIMIT $1`,
      [limit, String(bucket.afterMs), bucket.id],
    );

    for (const t of due) {
      try {
        const provider = getProvider(t.provider);
        if (!provider.fetchMetrics) continue;

        const m = await provider.fetchMetrics({
          remoteId: t.remote_id,
          page: {
            id: t.page_id,
            platform: t.platform as 'facebook' | 'instagram',
            provider: t.provider,
            remoteId: t.remote_page_id,
            displayName: t.page_name,
            timezone: t.page_timezone,
          },
        });

        await query(
          `INSERT INTO post_metrics
             (tenant_id, target_id, age_bucket, impressions, reach, likes, comments, shares, saves, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT (target_id, age_bucket) DO UPDATE
             SET impressions = EXCLUDED.impressions, reach = EXCLUDED.reach,
                 likes = EXCLUDED.likes, comments = EXCLUDED.comments,
                 shares = EXCLUDED.shares, saves = EXCLUDED.saves,
                 collected_at = now()`,
          [t.tenant_id, t.target_id, bucket.id,
           m.impressions ?? null, m.reach ?? null, m.likes ?? null,
           m.comments ?? null, m.shares ?? null, m.saves ?? null,
           JSON.stringify(m)],
        );
        collected++;
      } catch {
        // ดึงสถิติไม่ได้ไม่ควรทำให้รอบพัง — ลองใหม่รอบหน้า
        // (โพสต์อาจถูกลบจากเพจ หรือ token หมดสิทธิ์อ่าน insights)
      }
    }
  }

  return collected;
}

export type PostInsight = {
  post_id: string;
  caption: string;
  scheduled_at: Date;
  platform: string;
  page_name: string;
  image_url: string | null;
  permalink: string | null;
  buckets: Record<string, Metrics & { collected_at: string }>;
};

/** สถิติของโพสต์ที่ขึ้นไปแล้ว เรียงจากใหม่ไปเก่า */
export async function listInsights(tenantId: string, limit = 30): Promise<PostInsight[]> {
  return query<PostInsight>(
    `SELECT p.id AS post_id, left(p.caption, 90) AS caption, p.scheduled_at,
            t.platform::text, sp.display_name AS page_name,
            t.remote_permalink AS permalink,
            COALESCE(mv.public_url, ma.public_url) AS image_url,
            COALESCE((
              SELECT jsonb_object_agg(m.age_bucket, jsonb_build_object(
                'impressions', m.impressions, 'reach', m.reach, 'likes', m.likes,
                'comments', m.comments, 'shares', m.shares, 'saves', m.saves,
                'collected_at', m.collected_at
              ))
                FROM post_metrics m WHERE m.target_id = t.id
            ), '{}'::jsonb) AS buckets
       FROM post_targets t
       JOIN scheduled_posts p ON p.id = t.post_id
       JOIN social_pages sp   ON sp.id = t.page_id
       LEFT JOIN media_assets ma   ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '1:1'
      WHERE t.tenant_id = $1 AND t.status = 'posted'
      ORDER BY p.scheduled_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
}

/**
 * ช่วงเวลาไหนได้ผลดีที่สุด — ใช้ยอด 24 ชั่วโมงเทียบกัน
 *
 * ตอบคำถามที่เจ้าของร้านถามจริง: "โพสต์ตอนไหนคนเห็นเยอะสุด"
 * ต้องมีข้อมูลพอสมควรถึงจะเชื่อได้ จึงบอกจำนวนโพสต์ที่ใช้คำนวณไปด้วยเสมอ
 */
export async function bestTimes(tenantId: string) {
  return query<{ hour: number; posts: string; avg_reach: string; avg_likes: string }>(
    `SELECT EXTRACT(HOUR FROM p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::int AS hour,
            count(*)::text AS posts,
            round(avg(COALESCE(m.reach, m.impressions, 0)))::text AS avg_reach,
            round(avg(COALESCE(m.likes, 0)))::text AS avg_likes
       FROM post_metrics m
       JOIN post_targets t ON t.id = m.target_id
       JOIN scheduled_posts p ON p.id = t.post_id
      WHERE m.tenant_id = $1 AND m.age_bucket = '24h'
      GROUP BY 1
     HAVING count(*) >= 2
      ORDER BY avg(COALESCE(m.reach, m.impressions, 0)) DESC
      LIMIT 5`,
    [tenantId],
  );
}
