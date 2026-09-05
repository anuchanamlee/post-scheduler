import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, query } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { storage } from '../src/lib/storage.js';
import { rollupPostStatus } from '../src/core/queue.js';

/**
 * ล้างข้อมูลที่เกิดจากการทดสอบ ให้เหลือแต่ข้อมูลตัวอย่างที่พร้อมโชว์
 *
 *   docker compose exec web npm run reset-demo
 *
 * เก็บไว้: ลูกค้า ผู้ใช้ เพจ credential โทนเสียง รูปต้นฉบับ
 * ล้างทิ้ง: โพสต์ทั้งหมด แจ้งเตือน log ฟีดจำลอง แล้วสร้างโพสต์ตัวอย่างใหม่ 3 ชิ้น
 */
async function main() {
  const tenant = await query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  if (!tenant.length) {
    console.log('[reset] ยังไม่มีข้อมูล — รัน npm run seed ก่อน');
    await pool.end();
    return;
  }
  const tid = tenant[0].id;

  const before = await query<{ n: string }>(`SELECT count(*) AS n FROM scheduled_posts`);
  await query(`DELETE FROM scheduled_posts WHERE tenant_id = $1`, [tid]);   // targets/metrics ตามด้วย CASCADE
  await query(`DELETE FROM notifications WHERE tenant_id = $1`, [tid]);
  await query(`DELETE FROM api_call_log WHERE tenant_id = $1`, [tid]);
  await query(`DELETE FROM job_runs`);
  await query(`DELETE FROM caption_drafts WHERE tenant_id = $1`, [tid]);
  await query(`UPDATE ai_usage SET calls = 0, cost_usd = 0 WHERE tenant_id = $1`, [tid]);

  // ล้างคลังรูป เหลือแต่รูปตัวอย่างใบเดียว — ไม่งั้นลูกค้าเปิดมาเจอโปสเตอร์ทดสอบเป็นร้อยใบ
  const keep = await query<{ id: string }>(
    `SELECT id FROM media_assets
      WHERE tenant_id = $1 AND storage_key LIKE 'originals/%' AND status = 'ready'
      ORDER BY created_at LIMIT 1`, [tid]);
  const junk = await query<{ storage_key: string }>(
    `DELETE FROM media_assets WHERE tenant_id = $1 AND id <> ALL($2::uuid[])
      RETURNING storage_key`,
    [tid, keep.map((k) => k.id)]);
  for (const j of junk) await storage().delete(j.storage_key).catch(() => {});

  try {
    await fs.unlink(path.join(env.storageDir, 'mock-feed.json'));
  } catch { /* ยังไม่มีฟีดก็ไม่เป็นไร */ }

  const asset = await query<{ id: string }>(
    `SELECT id FROM media_assets WHERE tenant_id = $1 AND status = 'ready' LIMIT 1`, [tid]);
  const pages = await query<{ id: string; platform: string }>(
    `SELECT id, platform::text FROM social_pages WHERE tenant_id = $1 ORDER BY platform`, [tid]);
  const fb = pages.find((p) => p.platform === 'facebook')!;
  const ig = pages.find((p) => p.platform === 'instagram')!;

  // โพสต์ตัวอย่างที่โชว์สถานะสำคัญได้ครบ
  // เขียนผลลัพธ์ลงฐานข้อมูลตรงๆ ไม่ใช้ flag ในแคปชั่น เพราะแคปชั่นตัวอย่างต้องอ่านได้จริง
  // เที่ยงคืนของ "วันนี้ตามเวลาไทย" ไม่ใช่เที่ยงคืน UTC — ต่างกัน 7 ชั่วโมง
  const BKK = `(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')`;

  const samples: Array<{
    cap: string; at: string; pages: string[];
    outcome?: Record<string, 'posted' | 'failed'>;
  }> = [
    { cap: 'สวัสดีตอนเช้าค่ะ วันนี้ร้านเปิด 9 โมงถึง 3 ทุ่มนะคะ แวะมาทักทายกันได้',
      at: `${BKK} + interval '9 hours' - interval '1 day'`,
      pages: [fb.id, ig.id], outcome: { facebook: 'posted', instagram: 'posted' } },

    { cap: 'โปรโมชั่นเดือนนี้ ลด 20% ทุกชิ้นค่ะ จัดส่งฟรีเมื่อครบ 500 บาท ทักมาสอบถามได้เลยนะคะ',
      at: `${BKK} + interval '9 hours'`,
      pages: [fb.id, ig.id], outcome: { facebook: 'posted', instagram: 'posted' } },

    // เคสที่เจ้าของร้านต้องตัดสินใจ: ขึ้น Facebook แล้วแต่ Instagram ปฏิเสธรูป
    { cap: 'ของใหม่เข้าร้านแล้วค่ะ มาลองกันได้ที่หน้าร้าน หรือทักมาถามรุ่นที่สนใจได้เลย',
      at: `${BKK} + interval '12 hours 30 minutes'`,
      pages: [fb.id, ig.id], outcome: { facebook: 'posted', instagram: 'failed' } },

    { cap: 'ปิดร้านสามทุ่มนะคะ ใครยังไม่ได้แวะรีบเลย',
      at: `greatest(${BKK} + interval '18 hours', now() + interval '3 hours')`,
      pages: [fb.id] },

    { cap: 'พรุ่งนี้มีของเข้าใหม่ 3 รุ่น ใครรออยู่เตรียมตัวได้เลยค่ะ',
      at: `${BKK} + interval '1 day 9 hours'`, pages: [fb.id, ig.id] },

    { cap: 'สุดสัปดาห์นี้ร้านเปิดปกตินะคะ แวะมาชิลกันได้ทั้งวัน',
      at: `${BKK} + interval '2 days 18 hours'`, pages: [ig.id] },
  ];

  for (const s of samples) {
    const done = s.outcome !== undefined;
    const post = await query<{ id: string }>(
      `INSERT INTO scheduled_posts (tenant_id, caption, asset_id, scheduled_at, status)
       VALUES ($1, $2, $3, ${s.at}, $4::post_status) RETURNING id`,
      [tid, s.cap, asset[0]?.id ?? null, done ? 'posted' : 'pending'],
    );
    // ตัวส่งโพสต์อ่านรูปจาก post_media (migration 0004) ไม่ใช่ scheduled_posts.asset_id
    // ไม่ใส่ = โพสต์ล้มว่า "รูปยังไม่พร้อมใช้งาน" ทันทีที่ worker หยิบ
    if (asset[0]) {
      await query(
        `INSERT INTO post_media (tenant_id, post_id, asset_id, position) VALUES ($1,$2,$3,0)`,
        [tid, post[0].id, asset[0].id],
      );
    }
    await query(
      `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
       SELECT $1, $2, sp.id, sp.platform FROM social_pages sp WHERE sp.id = ANY($3::uuid[])`,
      [tid, post[0].id, s.pages],
    );

    if (s.outcome) {
      for (const [platform, result] of Object.entries(s.outcome)) {
        await query(
          `UPDATE post_targets
              SET status = $3::target_status,
                  remote_id = CASE WHEN $3 = 'posted' THEN 'demo_' || left(md5(random()::text), 8) END,
                  error_message = CASE WHEN $3 = 'failed'
                    THEN 'Instagram ปฏิเสธรูป — สัดส่วนอยู่นอกช่วงที่รับได้ (0.80–1.91)' END,
                  attempt_count = 1, updated_at = ${s.at}
            WHERE post_id = $1 AND platform = $2::platform`,
          [post[0].id, platform, result],
        );
      }
      await rollupPostStatus(post[0].id);
    }
  }

  console.log(`[reset] ล้างโพสต์ ${before[0].n} รายการ เหลือตัวอย่าง 3 ชิ้น`);
  await pool.end();
}

main().catch((err) => { console.error('[reset] ล้มเหลว:', err); process.exit(1); });
