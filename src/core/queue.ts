import { query, one, tx } from '../lib/db.js';
import { env } from '../lib/env.js';

/**
 * คิวงานโพสต์ — ชั้นนี้ไม่รู้จัก Meta เลย รู้แค่ว่ามีงานที่ถึงเวลาแล้วกี่ชิ้น
 */

export type ClaimedTarget = {
  target_id: string;
  post_id: string;
  tenant_id: string;
  caption: string;
  scheduled_at: Date;
  attempt_count: number;
  idempotency_key: string;
  container_id: string | null;
  container_expires_at: Date | null;
  page_id: string;
  platform: 'facebook' | 'instagram';
  provider: string;
  remote_page_id: string;
  page_name: string;
  page_timezone: string;
  image_urls: string[];
  assets_ready: boolean;
  child_container_ids: string[];
};

/**
 * หยิบงานแบบกันชนกัน (รายงานข้อ C2)
 *
 * FOR UPDATE ... SKIP LOCKED = worker หลายตัว (หรือรอบ cron ที่ทับกัน) หยิบงานเดียวกันไม่ได้
 * locked_until = ถ้า worker ตายกลางคัน งานจะถูกปล่อยคืนเองเมื่อ lock หมดอายุ ไม่ค้างถาวร
 */
export async function claimDueTargets(workerId: string, limit = env.worker.batchSize) {
  const lockSeconds = env.worker.lockSeconds;
  return query<ClaimedTarget>(
    `WITH due AS (
        SELECT t.id
          FROM post_targets t
          JOIN scheduled_posts p ON p.id = t.post_id
         WHERE t.status = 'pending'
           AND p.status IN ('pending', 'publishing', 'partial')
           AND p.scheduled_at <= now()
           AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
           AND (t.locked_until IS NULL OR t.locked_until < now())
           AND t.attempt_count < t.max_attempts
         ORDER BY p.scheduled_at
           FOR UPDATE OF t SKIP LOCKED
         LIMIT $2
     )
     UPDATE post_targets t
        SET status          = 'publishing',
            locked_at       = now(),
            locked_until    = now() + ($3 || ' seconds')::interval,
            locked_by       = $1,
            attempt_count   = t.attempt_count + 1,
            last_attempt_at = now(),
            updated_at      = now()
       FROM due
       JOIN post_targets t2 ON t2.id = due.id
       JOIN scheduled_posts p ON p.id = t2.post_id
       JOIN social_pages sp   ON sp.id = t2.page_id
      WHERE t.id = due.id
  RETURNING t.id            AS target_id,
            t.post_id,
            t.tenant_id,
            p.caption,
            p.scheduled_at,
            t.attempt_count,
            t.idempotency_key,
            t.container_id,
            t.container_expires_at,
            sp.id            AS page_id,
            t.platform,
            sp.provider,
            sp.remote_id     AS remote_page_id,
            sp.display_name  AS page_name,
            sp.timezone      AS page_timezone,
            t.child_container_ids,
            -- รูปทั้งหมดของโพสต์ เรียงตามลำดับที่จะแสดง (carousel)
            COALESCE((
              SELECT array_agg(a.public_url ORDER BY pm.position)
                FROM post_media pm
                JOIN media_assets a ON a.id = pm.asset_id
               WHERE pm.post_id = t2.post_id AND a.public_url IS NOT NULL
            ), '{}') AS image_urls,
            COALESCE((
              SELECT bool_and(a.status = 'ready')
                FROM post_media pm
                JOIN media_assets a ON a.id = pm.asset_id
               WHERE pm.post_id = t2.post_id
            ), false) AS assets_ready`,
    [workerId, limit, String(lockSeconds)],
  );
}

/** โพสต์ที่เลยเวลามานานเกิน grace window → ไม่โพสต์ย้อนหลัง ให้คนตัดสิน (รายงานข้อ D10) */
export async function markMissed(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE scheduled_posts p
        SET status = 'missed', updated_at = now()
      WHERE p.status = 'pending'
        AND p.scheduled_at < now() - ($1 || ' minutes')::interval
      RETURNING p.id`,
    [String(env.worker.graceMinutes)],
  );
  if (rows.length) {
    await query(
      `UPDATE post_targets SET status = 'skipped', updated_at = now()
        WHERE post_id = ANY($1::uuid[]) AND status = 'pending'`,
      [rows.map((r) => r.id)],
    );
    await query(
      `INSERT INTO notifications (tenant_id, level, title, body, post_id)
       SELECT tenant_id, 'warning', 'โพสต์เลยเวลาที่ตั้งไว้',
              'ระบบไม่โพสต์ย้อนหลังให้อัตโนมัติ เปิดดูแล้วเลือกว่าจะโพสต์เลยหรือยกเลิก', id
         FROM scheduled_posts WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
  }
  return rows.length;
}

/** ปล่อย lock ของ worker ที่ตายไปแล้ว ให้รอบถัดไปหยิบต่อได้ */
export async function reclaimStaleLocks(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE post_targets
        SET status = 'pending', locked_until = NULL, locked_at = NULL, locked_by = NULL,
            updated_at = now()
      WHERE status = 'publishing' AND locked_until IS NOT NULL AND locked_until < now()
      RETURNING id`,
  );
  return rows.length;
}

export type TargetOutcome =
  | { kind: 'posted'; remoteId: string; permalink?: string }
  | { kind: 'retry'; retryAfterMs: number; code?: number; message: string }
  | { kind: 'failed'; code?: number; message: string };

/** เขียนผลของ 1 ปลายทาง แล้วคำนวณสถานะรวมของโพสต์ใหม่ */
export async function finishTarget(targetId: string, outcome: TargetOutcome): Promise<void> {
  await tx(async (client) => {
    if (outcome.kind === 'posted') {
      await client.query(
        `UPDATE post_targets
            SET status = 'posted', remote_id = $2, remote_permalink = $3,
                locked_until = NULL, locked_by = NULL, container_id = NULL,
                child_container_ids = '{}',
                error_code = NULL, error_message = NULL, error_retryable = NULL,
                updated_at = now()
          WHERE id = $1`,
        [targetId, outcome.remoteId, outcome.permalink ?? null],
      );
    } else if (outcome.kind === 'retry') {
      await client.query(
        `UPDATE post_targets
            SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed'::target_status
                              ELSE 'pending'::target_status END,
                next_attempt_at = now() + ($4 || ' milliseconds')::interval,
                locked_until = NULL, locked_by = NULL,
                error_code = $2, error_message = $3, error_retryable = true,
                updated_at = now()
          WHERE id = $1`,
        [targetId, outcome.code ?? null, outcome.message, String(outcome.retryAfterMs)],
      );
    } else {
      await client.query(
        `UPDATE post_targets
            SET status = 'failed', locked_until = NULL, locked_by = NULL,
                error_code = $2, error_message = $3, error_retryable = false,
                updated_at = now()
          WHERE id = $1`,
        [targetId, outcome.code ?? null, outcome.message],
      );
    }

    const post = await client.query<{ post_id: string }>(
      `SELECT post_id FROM post_targets WHERE id = $1`,
      [targetId],
    );
    if (post.rows[0]) await rollupPostStatus(post.rows[0].post_id, client);
  });
}

/** สถานะที่ต้องบอกคน — สถานะที่จบสวยแล้วไม่ต้องรบกวน */
const ALERTS: Record<string, { level: string; title: string; body: string }> = {
  partial: {
    level: 'critical',
    title: 'โพสต์ขึ้นไม่ครบทุกช่องทาง',
    body: 'ปลายทางหนึ่งสำเร็จ อีกปลายทางล้มเหลว ระบบไม่ลบของที่ขึ้นไปแล้ว ให้ตัดสินใจเอง',
  },
  failed: {
    level: 'critical',
    title: 'โพสต์ไม่สำเร็จสักช่องทาง',
    body: 'ลองส่งครบจำนวนครั้งแล้วยังไม่สำเร็จ เปิดดูสาเหตุแล้วสั่งส่งใหม่ได้',
  },
};

/**
 * สถานะของโพสต์คำนวณจากลูกเสมอ ไม่ใช่เขียนทับตรงๆ (รายงานข้อ C1)
 * นี่คือที่เดียวที่ 'partial' เกิดขึ้น — FB ขึ้นแล้วแต่ IG ล้ม (รายงานข้อ D3)
 */
export async function rollupPostStatus(postId: string, client?: Parameters<typeof query>[2]) {
  const rows = await query<{ status: string; n: string }>(
    `SELECT status::text, count(*) AS n FROM post_targets WHERE post_id = $1 GROUP BY status`,
    [postId],
    client,
  );
  const count = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const posted = count('posted');
  const failed = count('failed');
  const pending = count('pending') + count('publishing');
  const skipped = count('skipped');
  const total = rows.reduce((a, r) => a + Number(r.n), 0);

  let status: string;
  if (total === 0) status = 'draft';
  else if (pending > 0 && posted === 0 && failed === 0) status = 'pending';
  else if (pending > 0) status = 'publishing';
  else if (posted === total) status = 'posted';
  else if (posted > 0) status = 'partial';
  else if (skipped === total) status = 'missed';
  else status = 'failed';

  await query(
    `UPDATE scheduled_posts SET status = $2::post_status, updated_at = now() WHERE id = $1`,
    [postId, status],
    client,
  );

  // เรื่องที่ต้องให้คนตัดสินใจ ต้องมีแจ้งเตือนเสมอ ไม่ใช่เฉพาะเคส partial
  const alert = ALERTS[status];
  if (alert) {
    await query(
      `INSERT INTO notifications (tenant_id, level, title, body, post_id)
       SELECT tenant_id, $2, $3, $4, id
         FROM scheduled_posts WHERE id = $1
         -- กันเตือนซ้ำเรื่องเดิมที่ยังไม่ได้อ่าน แต่ถ้าอ่านไปแล้วและเกิดขึ้นอีก ต้องเตือนใหม่
         -- (เช่น สั่งส่งซ้ำแล้วล้มอีกรอบ — เดิมเงียบสนิทเพราะกันซ้ำแบบไม่ดูสถานะการอ่าน)
         AND NOT EXISTS (
           SELECT 1 FROM notifications
            WHERE post_id = $1 AND title = $3 AND read_at IS NULL)`,
      [postId, alert.level, alert.title, alert.body],
      client,
    );
  }
  return status;
}

/** เก็บ container ลูกทีละใบ — ถ้า process ตายกลางคันจะได้ไม่สร้างซ้ำ */
export async function appendChildContainer(targetId: string, childId: string) {
  await query(
    `UPDATE post_targets
        SET child_container_ids = array_append(child_container_ids, $2), updated_at = now()
      WHERE id = $1 AND NOT ($2 = ANY(child_container_ids))`,
    [targetId, childId],
  );
}

export async function saveContainer(targetId: string, containerId: string, expiresAt: Date) {
  await query(
    `UPDATE post_targets SET container_id = $2, container_expires_at = $3, updated_at = now()
      WHERE id = $1`,
    [targetId, containerId, expiresAt],
  );
}

export async function logApiCall(entry: {
  tenantId?: string;
  targetId?: string;
  provider: string;
  operation: string;
  httpStatus?: number;
  errorCode?: number;
  errorMessage?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}) {
  // ไม่มี token ในนี้ — request_meta เก็บได้แค่ id และตัวเลข (รายงานข้อ E2)
  await query(
    `INSERT INTO api_call_log
       (tenant_id, target_id, provider, operation, http_status, error_code, error_message, duration_ms, request_meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.tenantId ?? null,
      entry.targetId ?? null,
      entry.provider,
      entry.operation,
      entry.httpStatus ?? null,
      entry.errorCode ?? null,
      entry.errorMessage ?? null,
      entry.durationMs ?? null,
      entry.meta ? JSON.stringify(entry.meta) : null,
    ],
  );
}

export async function heartbeat(jobName: string, stats: {
  claimed: number; succeeded: number; failed: number; ok: boolean;
  note?: string; deferred?: number;
}) {
  await query(
    `INSERT INTO job_runs (job_name, finished_at, ok, claimed, succeeded, failed, note)
     VALUES ($1, now(), $2, $3, $4, $5, $6)`,
    [jobName, stats.ok, stats.claimed, stats.succeeded, stats.failed, stats.note ?? null],
  );
}

/** ใช้ตอบหน้า /api/health — ไม่มีอันนี้ cron ตายเงียบทั้งสัปดาห์ (รายงานข้อ D9) */
export async function workerIsAlive(): Promise<{ alive: boolean; lastRun: Date | null }> {
  const row = await one<{ started_at: Date }>(
    `SELECT started_at FROM job_runs WHERE job_name = 'publish' ORDER BY started_at DESC LIMIT 1`,
  );
  if (!row) return { alive: false, lastRun: null };
  const stale = Date.now() - row.started_at.getTime() > env.worker.heartbeatStaleMinutes * 60_000;
  return { alive: !stale, lastRun: row.started_at };
}
