import { query } from '../lib/db.js';

/**
 * ตารางเวลาประจำ และการหาช่องว่างถัดไป
 *
 * แนวคิดมาจาก posting schedule ของ Buffer: คนตั้งเวลาที่ "ปกติจะโพสต์" ไว้ครั้งเดียว
 * แล้วโพสต์ใหม่ก็แค่ต่อคิวลงช่องว่างถัดไป ไม่ต้องตัดสินใจเรื่องเวลาซ้ำทุกครั้ง
 *
 * ต่อยอดจากของเดิมตรงที่เราคิดเป็นเวลาไทยเสมอ (เจ้าของร้านคิดเป็นเวลาไทย
 * ส่วนเซิร์ฟเวอร์อยู่ UTC) และช่องที่มีโพสต์จองแล้วจะถูกข้ามไปเอง
 */

export const TZ = 'Asia/Bangkok';
export const WEEKDAY_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

export type Slot = {
  id: string;
  weekday: number;
  time_of_day: string;   // 'HH:MM:SS'
  is_active: boolean;
};

export async function listSlots(tenantId: string): Promise<Slot[]> {
  return query<Slot>(
    `SELECT id, weekday, time_of_day::text, is_active
       FROM posting_slots
      WHERE tenant_id = $1
      ORDER BY weekday, time_of_day`,
    [tenantId],
  );
}

export async function addSlot(tenantId: string, weekday: number, time: string) {
  await query(
    `INSERT INTO posting_slots (tenant_id, weekday, time_of_day)
     VALUES ($1, $2, $3::time) ON CONFLICT DO NOTHING`,
    [tenantId, weekday, time],
  );
}

export async function removeSlot(tenantId: string, slotId: string) {
  await query(`DELETE FROM posting_slots WHERE tenant_id = $1 AND id = $2`, [tenantId, slotId]);
}

/**
 * ช่องว่างถัดไปที่ยังไม่มีใครจอง
 *
 * ทำใน SQL ทั้งหมดโดยตั้งใจ: การคำนวณ "วันถัดไปที่ตรงกับวันอังคาร 18:00 ตามเวลาไทย"
 * ด้วย Date ของ JS บนเซิร์ฟเวอร์ที่รัน UTC เป็นบ่อเกิดของบั๊กเรื่องเวลาที่หายาก
 * generate_series + AT TIME ZONE ให้ Postgres จัดการเรื่อง timezone ให้แทน
 *
 * @param count จำนวนช่องที่ต้องการ (ใช้ตอนเพิ่มหลายโพสต์รวดเดียว)
 */
export async function nextFreeSlots(tenantId: string, count = 1): Promise<Date[]> {
  const rows = await query<{ at: Date }>(
    `WITH days AS (
       -- มองไปข้างหน้า 28 วัน พอสำหรับตารางรายสัปดาห์ทุกแบบ
       SELECT (current_date AT TIME ZONE $3)::date + i AS d
         FROM generate_series(0, 27) AS i
     ),
     candidates AS (
       SELECT ((d + s.time_of_day) AT TIME ZONE $3) AS at
         FROM days
         JOIN posting_slots s
           ON s.tenant_id = $1
          AND s.is_active
          AND s.weekday = EXTRACT(DOW FROM d)
     )
     SELECT c.at
       FROM candidates c
      WHERE c.at > now() + interval '5 minutes'   -- เผื่อเวลาให้กรอกเสร็จ
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_posts p
           WHERE p.tenant_id = $1
             AND p.status NOT IN ('cancelled', 'missed')
             -- ถือว่าชนกันถ้าห่างกันไม่เกิน 1 นาที
             AND abs(extract(epoch FROM (p.scheduled_at - c.at))) < 60
        )
      ORDER BY c.at
      LIMIT $2`,
    [tenantId, count, TZ],
  );
  return rows.map((r) => r.at);
}
