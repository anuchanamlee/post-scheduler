import { query, one } from '../lib/db.js';
import { env } from '../lib/env.js';

/**
 * ล้างข้อมูลเก่าที่ไม่มีใครใช้แล้ว
 *
 * ตารางที่โตทุกวินาทีโดยไม่มีเพดาน แล้วไม่มีใครสังเกตจนดิสก์เต็ม:
 *   job_runs      — worker เขียน 1 แถวทุกรอบ (ทุก 15 วิ = 5,760 แถว/วัน = ~2.1 ล้าน/ปี)
 *   api_call_log  — 1 แถวต่อการเรียก API 1 ครั้ง
 *   notifications — สะสมไปเรื่อยแม้อ่านแล้ว
 *   sessions      — หมดอายุแล้วยังอยู่
 *   caption_drafts— ร่างที่ไม่ได้ใช้
 *
 * ลบทีละก้อนโดยตั้งใจ ไม่ใช่ DELETE ทีเดียวล้านแถว — การลบก้อนใหญ่ล็อกตารางนาน
 * และทำให้ worker รอบนั้นค้าง ซึ่งแปลว่าโพสต์ที่ถึงเวลาไม่ถูกส่ง
 *
 * ของที่ "ไม่ลบเด็ดขาด": โพสต์ รูป โปสเตอร์ credential โทนเสียง ตารางเวลา
 * — ทั้งหมดเป็นของที่ลูกค้าทำเอง ไม่ใช่ log ที่ระบบเขียนทิ้ง
 */

export type RetentionResult = Record<string, number>;

const BATCH = 5000;

/** ลบเป็นก้อน จนกว่าจะหมดหรือครบเพดานรอบนี้ */
async function purge(sql: string, params: unknown[], maxBatches = 20): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await query<{ id: string }>(sql, params);
    total += rows.length;
    if (rows.length < BATCH) break;
  }
  return total;
}

export async function runRetention(): Promise<RetentionResult> {
  const d = env.retention;
  const out: RetentionResult = {};

  // heartbeat เก่ากว่านี้ไม่มีใครดูแล้ว — ใช้ตอบแค่ "worker ยังมีชีวิตไหม"
  out.job_runs = await purge(
    `DELETE FROM job_runs WHERE ctid IN (
       SELECT ctid FROM job_runs
        WHERE started_at < now() - ($1 || ' days')::interval
        LIMIT ${BATCH}
     ) RETURNING id`,
    [String(d.jobRunsDays)],
  );

  // log ของการเรียก API เก็บไว้ debug ย้อนหลัง แต่ไม่ต้องเก็บชั่วกัลป์
  out.api_call_log = await purge(
    `DELETE FROM api_call_log WHERE ctid IN (
       SELECT ctid FROM api_call_log
        WHERE created_at < now() - ($1 || ' days')::interval
        LIMIT ${BATCH}
     ) RETURNING id`,
    [String(d.apiLogDays)],
  );

  // แจ้งเตือนที่อ่านแล้วและเก่าพอ — ที่ยังไม่อ่านไม่แตะ ไม่ว่าเก่าแค่ไหน
  out.notifications = await purge(
    `DELETE FROM notifications WHERE ctid IN (
       SELECT ctid FROM notifications
        WHERE read_at IS NOT NULL
          AND created_at < now() - ($1 || ' days')::interval
        LIMIT ${BATCH}
     ) RETURNING id`,
    [String(d.notificationDays)],
  );

  // session ที่หมดอายุแล้ว ใช้เข้าระบบไม่ได้อยู่แล้ว
  out.sessions = await purge(
    `DELETE FROM sessions WHERE ctid IN (
       SELECT ctid FROM sessions WHERE expires_at < now() LIMIT ${BATCH}
     ) RETURNING token AS id`,
    [],
  );

  // ร่างแคปชั่นที่ไม่ได้ถูกเอาไปใช้กับโพสต์ไหน
  out.caption_drafts = await purge(
    `DELETE FROM caption_drafts WHERE ctid IN (
       SELECT ctid FROM caption_drafts
        WHERE scheduled_post_id IS NULL
          AND created_at < now() - ($1 || ' days')::interval
        LIMIT ${BATCH}
     ) RETURNING id`,
    [String(d.draftDays)],
  );

  return out;
}

/** ขนาดจริงของตารางที่โตเร็ว — ใช้ตอบ /api/health ว่าควรกังวลหรือยัง */
export async function growthReport() {
  const rows = await query<{ table_name: string; rows: string; bytes: string }>(
    `SELECT relname AS table_name, n_live_tup::text AS rows,
            pg_total_relation_size(relid)::text AS bytes
       FROM pg_stat_user_tables
      WHERE relname IN ('job_runs', 'api_call_log', 'notifications',
                        'sessions', 'caption_drafts', 'post_targets')
      ORDER BY pg_total_relation_size(relid) DESC`,
  );
  return rows.map((r) => ({
    table: r.table_name,
    rows: Number(r.rows),
    bytes: Number(r.bytes),
  }));
}

/** รันวันละครั้งพอ — เช็คว่าถึงเวลารึยังจาก job_runs ของตัวเอง */
export async function shouldRunRetention(): Promise<boolean> {
  const last = await one<{ started_at: Date }>(
    `SELECT started_at FROM job_runs WHERE job_name = 'retention'
      ORDER BY started_at DESC LIMIT 1`,
  );
  if (!last) return true;
  return Date.now() - last.started_at.getTime() > 20 * 3600_000;
}
