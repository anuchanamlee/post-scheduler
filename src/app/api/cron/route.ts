import { env } from '../../../lib/env.js';
import { runPublishCycle } from '../../../core/publisher.js';

/**
 * ทางเลือกสำหรับ deploy ที่ไม่มี worker แยก (เช่น Vercel Cron)
 *
 * ต้องมี secret เสมอ (รายงานข้อ E5) — endpoint ที่ยิงโพสต์ออกได้ ห้ามเปิดให้ใครก็เรียก
 * เทียบด้วยความยาวคงที่ กัน timing attack
 */
export async function POST(req: Request) {
  if (!env.cronSecret) {
    return Response.json({ error: 'ยังไม่ได้ตั้ง CRON_SECRET' }, { status: 503 });
  }

  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqual(provided, env.cronSecret)) {
    return Response.json({ error: 'ไม่ได้รับอนุญาต' }, { status: 401 });
  }

  const stats = await runPublishCycle('http-cron');
  return Response.json({ ok: true, ...stats });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
