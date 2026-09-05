import os from 'node:os';
import { env } from '../lib/env.js';
import { pool } from '../lib/db.js';
import { runPublishCycle } from '../core/publisher.js';

/**
 * Worker เป็น process แยกจากเว็บ ไม่ใช่ setInterval ในเซิร์ฟเวอร์ Next
 *
 * เหตุผล: เว็บ restart/scale ได้อิสระโดยไม่ทำให้คิวเด้ง และเวลาระบบมีปัญหา
 * จะรู้ทันทีว่าปัญหาอยู่ฝั่งไหน — นี่คือเส้นแบ่ง "ชั้นคนโพสต์" ที่จับต้องได้จริง
 */

const workerId = `${os.hostname()}#${process.pid}`;
let stopping = false;

async function loop() {
  console.log(`[worker] เริ่มทำงาน id=${workerId} ทุก ${env.worker.intervalMs / 1000} วินาที`);

  while (!stopping) {
    const started = Date.now();
    try {
      const stats = await runPublishCycle(workerId);
      if (stats.claimed > 0) {
        console.log(
          `[worker] หยิบ ${stats.claimed} · สำเร็จ ${stats.succeeded} · ยังไม่สำเร็จ ${stats.failed}`,
        );
      }
    } catch (err) {
      console.error('[worker] รอบนี้ล้มเหลว:', (err as Error).message);
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1_000, env.worker.intervalMs - elapsed)));
  }

  await pool.end();
  console.log('[worker] ปิดเรียบร้อย');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ได้รับ ${sig} — จะจบรอบปัจจุบันก่อนปิด`);
    stopping = true;
  });
}

loop().catch((err) => {
  console.error('[worker] ตายกลางทาง:', err);
  process.exit(1);
});
