import { one, query, tx } from '../lib/db.js';

/**
 * สร้าง/แก้/ยกเลิกโพสต์ในคิว
 *
 * ชั้นนี้คือ "ประตู" ที่คอนเทนต์ทุกแหล่งเข้ามา ไม่ว่าคนพิมพ์เอง ผู้ช่วย AI ร่างให้
 * หรือวันหน้ามี agent เสนอคอนเทนต์เอง — ทุกทางเขียนลงตารางเดียวกัน
 * ชั้นโพสต์ไม่ต้องรู้เลยว่าแคปชั่นมาจากไหน (หลักการแยกชั้นใน content-ai-extension)
 */

/** Instagram รับ carousel ได้สูงสุด 10 ใบ ใช้เพดานเดียวกันกับทุกปลายทางเพื่อความง่าย */
export const MAX_MEDIA = 10;

export type CreatePostInput = {
  tenantId: string;
  userId?: string;
  caption: string;
  /** รูปตามลำดับที่จะแสดง — ใบแรกเป็นรูปหลักที่ใช้เป็นรูปย่อ */
  assetIds: string[];
  scheduledAt: Date;
  pageIds: string[];
  status?: 'draft' | 'pending_approval' | 'pending';
  source?: 'human' | 'ai_agent';
};

export async function createPost(input: CreatePostInput): Promise<{ id: string }> {
  if (input.pageIds.length === 0) throw new Error('ต้องเลือกปลายทางอย่างน้อย 1 ช่องทาง');

  if (input.assetIds.length === 0) throw new Error('ต้องเลือกรูปอย่างน้อย 1 ใบ');
  if (input.assetIds.length > MAX_MEDIA) {
    throw new Error(`ใส่รูปได้สูงสุด ${MAX_MEDIA} ใบต่อโพสต์ (ข้อจำกัดของ Instagram)`);
  }

  // ตรวจรูปทุกใบตั้งแต่ตอนบันทึก ไม่ใช่ตอนถึงเวลาโพสต์ (รายงานข้อ D6)
  const assets = await query<{ id: string; status: string; public_url: string | null }>(
    `SELECT id, status::text, public_url FROM media_assets
      WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
    [input.assetIds, input.tenantId],
  );
  if (assets.length !== input.assetIds.length) throw new Error('ไม่พบรูปที่เลือกบางใบ');
  if (assets.some((a) => a.status !== 'ready' || !a.public_url)) {
    throw new Error('รูปยังประมวลผลไม่เสร็จ รอสักครู่แล้วบันทึกใหม่');
  }

  return tx(async (client) => {
    const post = await client.query<{ id: string }>(
      `INSERT INTO scheduled_posts (tenant_id, caption, asset_id, scheduled_at, status, created_by, source)
       VALUES ($1,$2,$3,$4,$5::post_status,$6,$7) RETURNING id`,
      [
        input.tenantId,
        input.caption,
        input.assetIds[0],
        input.scheduledAt,
        input.status ?? 'pending',
        input.userId ?? null,
        input.source ?? 'human',
      ],
    );
    const postId = post.rows[0].id;

    // รูปทั้งชุด เรียงตามลำดับที่ผู้ใช้จัดไว้
    await client.query(
      `INSERT INTO post_media (tenant_id, post_id, asset_id, position)
       SELECT $1, $2, a.id, a.ord - 1
         FROM unnest($3::uuid[]) WITH ORDINALITY AS a(id, ord)`,
      [input.tenantId, postId, input.assetIds],
    );

    // 1 แถวต่อปลายทาง — ตรงนี้คือสิ่งที่ทำให้ "โพสต์ครึ่งเดียว" อธิบายได้ (รายงานข้อ C1)
    await client.query(
      `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
       SELECT $1, $2, sp.id, sp.platform
         FROM social_pages sp
        WHERE sp.tenant_id = $1 AND sp.id = ANY($3::uuid[]) AND sp.is_active`,
      [input.tenantId, postId, input.pageIds],
    );

    return { id: postId };
  });
}

export async function updatePost(
  tenantId: string,
  postId: string,
  patch: {
    caption?: string; scheduledAt?: Date; assetIds?: string[]; pageIds?: string[];
  },
) {
  return tx(async (client) => {
    // แก้ได้เฉพาะที่ยังไม่ออกไปข้างนอก
    const rows = await client.query<{ id: string }>(
      `UPDATE scheduled_posts
          SET caption = COALESCE($3, caption),
              scheduled_at = COALESCE($4, scheduled_at),
              asset_id = COALESCE($5, asset_id),
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
          AND status IN ('draft','pending_approval','pending','missed')
        RETURNING id`,
      [tenantId, postId, patch.caption ?? null, patch.scheduledAt ?? null,
       patch.assetIds?.[0] ?? null],
    );
    if (!rows.rows.length) throw new Error('แก้ไขไม่ได้ — โพสต์ออกไปแล้วหรือกำลังถูกส่ง');

    if (patch.assetIds?.length) {
      if (patch.assetIds.length > MAX_MEDIA) {
        throw new Error(`ใส่รูปได้สูงสุด ${MAX_MEDIA} ใบต่อโพสต์`);
      }
      await client.query(`DELETE FROM post_media WHERE post_id = $1`, [postId]);
      await client.query(
        `INSERT INTO post_media (tenant_id, post_id, asset_id, position)
         SELECT $1, $2, a.id, a.ord - 1
           FROM unnest($3::uuid[]) WITH ORDINALITY AS a(id, ord)`,
        [tenantId, postId, patch.assetIds],
      );
    }

    // เปลี่ยนปลายทางได้ตราบใดที่ยังไม่มีอันไหนถูกส่งออกไป
    if (patch.pageIds) {
      const sent = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM post_targets
          WHERE post_id = $1 AND status NOT IN ('pending', 'cancelled', 'skipped')`,
        [postId],
      );
      if (Number(sent.rows[0].n) > 0) {
        throw new Error('เปลี่ยนปลายทางไม่ได้ — บางช่องทางส่งออกไปแล้ว');
      }
      await client.query(`DELETE FROM post_targets WHERE post_id = $1`, [postId]);
      await client.query(
        `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
         SELECT $1, $2, sp.id, sp.platform
           FROM social_pages sp
          WHERE sp.tenant_id = $1 AND sp.id = ANY($3::uuid[]) AND sp.is_active`,
        [tenantId, postId, patch.pageIds],
      );
    }
    return rows.rows[0];
  });
}

/**
 * ย้ายโพสต์ไปวันใหม่ โดยคงเวลาในวันไว้เท่าเดิม
 *
 * คนที่ลากโพสต์ในปฏิทินตั้งใจจะ "เลื่อนวัน" ไม่ใช่เปลี่ยนเวลาที่คิดมาแล้ว
 * คำนวณด้วย SQL เพราะการประกอบ "วันที่ X เวลาเดิมตามเวลาไทย" ด้วย Date ของ JS
 * บนเซิร์ฟเวอร์ UTC เป็นบ่อเกิดของบั๊กเวลาที่หายาก
 */
export async function movePostToDay(tenantId: string, postId: string, dayISO: string) {
  const rows = await query<{ id: string; scheduled_at: Date }>(
    `UPDATE scheduled_posts p
        SET scheduled_at = (
              $3::date + (p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::time
            ) AT TIME ZONE 'Asia/Bangkok',
            updated_at = now()
      WHERE p.tenant_id = $1 AND p.id = $2
        AND p.status IN ('draft','pending_approval','pending','missed')
      RETURNING p.id, p.scheduled_at`,
    [tenantId, postId, dayISO],
  );
  if (!rows.length) throw new Error('เลื่อนไม่ได้ — โพสต์ออกไปแล้วหรือกำลังถูกส่ง');

  // ย้ายมาไว้อดีต = เลยเวลาทันที ต้องบอก ไม่ใช่ปล่อยให้กลายเป็น missed เงียบๆ
  return { id: rows[0].id, past: rows[0].scheduled_at.getTime() < Date.now() };
}

/**
 * ทำซ้ำโพสต์เดิม — โพสต์ประจำ (โปรทุกวันศุกร์ ปิดร้านทุกเย็น) จะได้ไม่ต้องเริ่มจากศูนย์
 * ใช้รูปใบเดิม ไม่อัปโหลดใหม่
 */
export async function duplicatePost(tenantId: string, postId: string, scheduledAt: Date) {
  return tx(async (client) => {
    const src = await client.query<{ caption: string; asset_id: string | null }>(
      `SELECT caption, asset_id FROM scheduled_posts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, postId],
    );
    if (!src.rows.length) throw new Error('ไม่พบโพสต์ต้นทาง');

    const copy = await client.query<{ id: string }>(
      `INSERT INTO scheduled_posts (tenant_id, caption, asset_id, scheduled_at, status)
       VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [tenantId, src.rows[0].caption, src.rows[0].asset_id, scheduledAt],
    );
    await client.query(
      `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
       SELECT $1, $2, t.page_id, t.platform FROM post_targets t WHERE t.post_id = $3`,
      [tenantId, copy.rows[0].id, postId],
    );
    await client.query(
      `INSERT INTO post_media (tenant_id, post_id, asset_id, position)
       SELECT $1, $2, m.asset_id, m.position FROM post_media m WHERE m.post_id = $3`,
      [tenantId, copy.rows[0].id, postId],
    );
    return copy.rows[0];
  });
}

/** ร่างที่กรอกครบแล้ว ค่อยกดเข้าคิวทีหลัง */
export async function publishDraft(tenantId: string, postId: string) {
  const rows = await query<{ id: string }>(
    `UPDATE scheduled_posts SET status = 'pending', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status IN ('draft', 'pending_approval')
      RETURNING id`,
    [tenantId, postId],
  );
  if (!rows.length) throw new Error('โพสต์นี้ไม่ได้อยู่ในสถานะร่าง');
  return rows[0];
}

export async function getPost(tenantId: string, postId: string) {
  return one<{
    id: string; caption: string; scheduled_at: Date; status: string;
    asset_id: string | null; image_url: string | null; page_ids: string[];
    media: Array<{ asset_id: string; url: string }>;
  }>(
    `SELECT p.id, p.caption, p.scheduled_at, p.status::text, p.asset_id,
            ma.public_url AS image_url,
            COALESCE(array_agg(DISTINCT t.page_id) FILTER (WHERE t.id IS NOT NULL), '{}') AS page_ids,
            COALESCE((
              SELECT json_agg(json_build_object('asset_id', pm.asset_id, 'url', a.public_url)
                              ORDER BY pm.position)
                FROM post_media pm JOIN media_assets a ON a.id = pm.asset_id
               WHERE pm.post_id = p.id
            ), '[]') AS media
       FROM scheduled_posts p
       LEFT JOIN media_assets ma ON ma.id = p.asset_id
       LEFT JOIN post_targets t  ON t.post_id = p.id
      WHERE p.tenant_id = $1 AND p.id = $2
      GROUP BY p.id, ma.public_url`,
    [tenantId, postId],
  );
}

export async function cancelPost(tenantId: string, postId: string) {
  return tx(async (client) => {
    const rows = await client.query<{ id: string }>(
      `UPDATE scheduled_posts SET status = 'cancelled', updated_at = now()
        WHERE tenant_id = $1 AND id = $2
          AND status IN ('draft','pending_approval','pending','missed')
        RETURNING id`,
      [tenantId, postId],
    );
    if (!rows.rows.length) throw new Error('ยกเลิกไม่ได้ — โพสต์ออกไปแล้วหรือกำลังถูกส่ง');
    await client.query(
      `UPDATE post_targets SET status = 'cancelled', updated_at = now()
        WHERE post_id = $1 AND status = 'pending'`,
      [postId],
    );
    return rows.rows[0];
  });
}

/** ส่งเฉพาะปลายทางที่ล้ม ไม่ยิงซ้ำอันที่ขึ้นไปแล้ว (รายงานข้อ D3) */
export async function retryFailedTargets(tenantId: string, postId: string) {
  const rows = await query<{ id: string }>(
    `UPDATE post_targets
        SET status = 'pending', attempt_count = 0, next_attempt_at = NULL,
            error_code = NULL, error_message = NULL, updated_at = now()
      WHERE tenant_id = $1 AND post_id = $2 AND status = 'failed'
      RETURNING id`,
    [tenantId, postId],
  );
  if (rows.length) {
    await query(
      `UPDATE scheduled_posts SET status = 'pending', updated_at = now() WHERE id = $1`,
      [postId],
    );
  }
  return rows.length;
}

export type QueueRow = {
  id: string;
  caption: string;
  scheduled_at: Date;
  status: string;
  image_url: string | null;
  media_count: number;
  rejected_reason: string | null;
  targets: Array<{
    platform: string;
    status: string;
    page_name: string;
    error_message: string | null;
    remote_permalink: string | null;
    attempt_count: number;
  }>;
};

/**
 * จำนวนโพสต์ต่อวัน สำหรับแถบสัปดาห์
 * แปลงเป็นวันตามเวลาไทยใน SQL ไม่ใช่ตาม UTC ของเซิร์ฟเวอร์ (รายงานข้อ C8)
 */
export async function dayCounts(tenantId: string, fromISO: string, days = 7) {
  return query<{ day: string; total: string; worst: string }>(
    `SELECT to_char((p.scheduled_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
            count(*)::text AS total,
            (array_agg(p.status::text ORDER BY
              CASE p.status
                WHEN 'failed' THEN 1 WHEN 'partial' THEN 2 WHEN 'missed' THEN 3
                WHEN 'publishing' THEN 4 WHEN 'pending' THEN 5 ELSE 6 END))[1] AS worst
       FROM scheduled_posts p
      WHERE p.tenant_id = $1
        AND (p.scheduled_at AT TIME ZONE $4)::date >= $2::date
        AND (p.scheduled_at AT TIME ZONE $4)::date < ($2::date + $3::int)
        AND p.status <> 'cancelled'
      GROUP BY 1`,
    [tenantId, fromISO, days, 'Asia/Bangkok'],
  );
}

/** โพสต์ทั้งเดือนแบบย่อ สำหรับวางในช่องปฏิทิน */
export async function postsInRange(tenantId: string, fromISO: string, days: number) {
  return query<{
    id: string; day: string; time: string; caption: string; status: string;
    image_url: string | null;
  }>(
    `SELECT p.id,
            to_char((p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS day,
            to_char(p.scheduled_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS time,
            left(p.caption, 60) AS caption,
            p.status::text,
            COALESCE(mv.public_url, ma.public_url) AS image_url
       FROM scheduled_posts p
       LEFT JOIN media_assets ma   ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '1:1'
      WHERE p.tenant_id = $1
        AND p.status <> 'cancelled'
        AND (p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::date >= $2::date
        AND (p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::date < ($2::date + $3::int)
      ORDER BY p.scheduled_at`,
    [tenantId, fromISO, days],
  );
}

/** โพสต์ของวันเดียว เรียงตามเวลา */
export async function listQueueForDay(tenantId: string, dayISO: string): Promise<QueueRow[]> {
  return query<QueueRow>(
    // ใช้รูปย่อ 1:1 ถ้ามี ไม่งั้นค่อยตกไปที่ต้นฉบับ — รูปย่อ 46px ไม่ควรโหลดไฟล์ 12 MB
    `SELECT p.id, p.caption, p.scheduled_at, p.status::text, p.rejected_reason,
            COALESCE(mv.public_url, ma.public_url) AS image_url,
            (SELECT count(*) FROM post_media pm WHERE pm.post_id = p.id)::int AS media_count,
            COALESCE(
              json_agg(
                json_build_object(
                  'platform', t.platform, 'status', t.status,
                  'page_name', sp.display_name, 'error_message', t.error_message,
                  'remote_permalink', t.remote_permalink, 'attempt_count', t.attempt_count
                ) ORDER BY t.platform
              ) FILTER (WHERE t.id IS NOT NULL), '[]'
            ) AS targets
       FROM scheduled_posts p
       LEFT JOIN media_assets ma ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '1:1'
       LEFT JOIN post_targets t  ON t.post_id = p.id
       LEFT JOIN social_pages sp ON sp.id = t.page_id
      WHERE p.tenant_id = $1
        AND (p.scheduled_at AT TIME ZONE 'Asia/Bangkok')::date = $2::date
      GROUP BY p.id, ma.public_url, mv.public_url, p.rejected_reason
      ORDER BY p.scheduled_at`,
    [tenantId, dayISO],
  );
}

export async function listQueue(tenantId: string, limit = 50): Promise<QueueRow[]> {
  // LIMIT อยู่ใน subquery โดยตั้งใจ: ตัดให้เหลือ n แถวก่อน แล้วค่อย join/aggregate
  // ถ้าปล่อย LIMIT ไว้ท้ายสุด Postgres จะรวมโพสต์ทั้งหมดของลูกค้าก่อนแล้วค่อยตัด
  return query<QueueRow>(
    `SELECT p.id, p.caption, p.scheduled_at, p.status::text, p.rejected_reason,
            COALESCE(mv.public_url, ma.public_url) AS image_url,
            (SELECT count(*) FROM post_media pm WHERE pm.post_id = p.id)::int AS media_count,
            COALESCE(
              json_agg(
                json_build_object(
                  'platform', t.platform,
                  'status', t.status,
                  'page_name', sp.display_name,
                  'error_message', t.error_message,
                  'remote_permalink', t.remote_permalink,
                  'attempt_count', t.attempt_count
                ) ORDER BY t.platform
              ) FILTER (WHERE t.id IS NOT NULL), '[]'
            ) AS targets
       FROM (SELECT * FROM scheduled_posts
              WHERE tenant_id = $1
              ORDER BY scheduled_at DESC
              LIMIT $2) p
       LEFT JOIN media_assets ma ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '1:1'
       LEFT JOIN post_targets t  ON t.post_id = p.id
       LEFT JOIN social_pages sp ON sp.id = t.page_id
      GROUP BY p.id, p.caption, p.scheduled_at, p.status, p.rejected_reason,
               ma.public_url, mv.public_url
      ORDER BY p.scheduled_at DESC`,
    [tenantId, limit],
  );
}
