import { one } from '../lib/db.js';
import { env } from '../lib/env.js';

/**
 * โควตาการโพสต์ของ Instagram
 *
 * Meta จำกัด 100 โพสต์ต่อ 24 ชั่วโมงแบบ moving window (ยืนยันจากเอกสาร 4 ก.ย. 2026
 * — เลข 25 ที่บล็อกหลายเจ้ายังลอกกันอยู่คือของปี 2018)
 *
 * ทำไมต้องกันเอง แทนที่จะปล่อยให้ Meta ปฏิเสธ:
 * เมื่อยิงเกินโควตา Meta ตอบ error 4/17/32 ซึ่งระบบตีเป็น rate_limited แล้ว retry ทุก 15 นาที
 * ถ้าคิวมี 30 โพสต์รอ ทั้ง 30 ตัวจะวนยิงแล้วโดนปฏิเสธพร้อมกัน — เผาโควตา API ที่เหลือ
 * และ attempt_count ของทุกตัวจะหมดจนโพสต์ตายทั้งชุดทั้งที่ไม่มีอะไรผิดเลย
 *
 * นับจาก post_targets ที่ posted สำเร็จ ไม่ใช่จากจำนวนครั้งที่ยิง — เพราะ Meta นับที่ผลลัพธ์
 * carousel นับเป็น 1 โพสต์ ตรงกับที่เราเก็บ 1 target ต่อ 1 โพสต์อยู่แล้ว
 */

export type QuotaStatus = {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** เวลาที่ช่องแรกจะหลุดจาก window — null เมื่อยังไม่เต็ม */
  freesAt: Date | null;
};

export async function instagramQuota(tenantId: string): Promise<QuotaStatus> {
  const limit = env.meta.igDailyPostLimit;

  const row = await one<{ used: string; oldest: Date | null }>(
    `SELECT count(*)::text AS used, min(updated_at) AS oldest
       FROM post_targets
      WHERE tenant_id = $1
        AND platform = 'instagram'
        AND status = 'posted'
        AND updated_at > now() - interval '24 hours'`,
    [tenantId],
  );

  const used = Number(row?.used ?? 0);
  const exhausted = used >= limit;

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    exhausted,
    // ช่องจะว่างเมื่อโพสต์ที่เก่าที่สุดใน window อายุครบ 24 ชม.
    freesAt: exhausted && row?.oldest
      ? new Date(new Date(row.oldest).getTime() + 24 * 3600_000)
      : null,
  };
}

/** เหลือน้อยกว่า 10% ถือว่าใกล้เต็ม ควรบอกคนก่อนที่จะโพสต์ไม่ออก */
export function isQuotaLow(q: QuotaStatus): boolean {
  return !q.exhausted && q.remaining <= Math.max(5, Math.floor(q.limit * 0.1));
}
