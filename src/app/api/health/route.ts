import { query } from '../../../lib/db.js';
import { workerIsAlive } from '../../../core/queue.js';
import { instagramQuota } from '../../../core/quota.js';
import { growthReport } from '../../../core/retention.js';
import { configProblems, readinessBlockers } from '../../../core/config.js';

/**
 * dead-man switch (รายงานข้อ D9)
 * ต่อ uptime monitor ตัวไหนก็ได้เข้ากับ endpoint นี้ — ถ้า worker หยุด จะได้รู้ภายในไม่กี่นาที
 * ไม่ใช่รู้ตอนลูกค้าถามว่าทำไมสัปดาห์นี้ไม่มีโพสต์ขึ้นเลย
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  /**
   * "ยังไม่พร้อมส่งมอบ" ไม่ทำให้ ok=false — ระบบเดินได้จริงในโหมดจำลอง
   * แต่ต้องโผล่ตรงนี้เสมอ ไม่งั้นแถบเขียวทั้งแผงจะอ่านเหมือนพร้อมใช้กับลูกค้าแล้ว
   */
  const notReady = readinessBlockers();
  checks.readiness = notReady.length
    ? notReady.map((r) => `${r.key}: ${r.what}`)
    : 'พร้อมส่งมอบ';

  // คอนฟิกที่ผิดจะไม่พังตอนบูต แต่พังตอนอยู่หน้าลูกค้า — ต้องเห็นก่อนถึงวันนั้น
  const cfg = configProblems();
  if (cfg.length) {
    ok = false;
    checks.config = cfg;
  } else {
    checks.config = 'ok';
  }

  try {
    await query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    ok = false;
    checks.database = `ล้มเหลว: ${(err as Error).message}`;
  }

  try {
    const worker = await workerIsAlive();
    checks.worker = {
      alive: worker.alive,
      lastRun: worker.lastRun?.toISOString() ?? null,
    };
    if (!worker.alive) ok = false;
  } catch {
    ok = false;
    checks.worker = 'ตรวจไม่ได้';
  }

  try {
    const stuck = await query<{ n: string }>(
      `SELECT count(*) AS n FROM post_targets t
         JOIN scheduled_posts p ON p.id = t.post_id
        WHERE t.status = 'pending' AND p.scheduled_at < now() - interval '15 minutes'`,
    );
    checks.overdueTargets = Number(stuck[0].n);
    if (Number(stuck[0].n) > 0) ok = false;
  } catch {
    checks.overdueTargets = 'ตรวจไม่ได้';
  }

  try {
    // โควตาเต็มไม่ใช่ความผิดพลาด แต่ต้องเห็นได้ เพราะอธิบายว่าทำไมโพสต์ค้าง
    const tenants = await query<{ id: string }>(`SELECT id FROM tenants LIMIT 5`);
    const quotas = await Promise.all(tenants.map((t) => instagramQuota(t.id)));
    checks.instagramQuota = quotas.map((q) => `${q.used}/${q.limit}`);
  } catch {
    checks.instagramQuota = 'ตรวจไม่ได้';
  }

  try {
    // ตารางที่โตเร็วที่สุด — ถ้าตัวไหนใหญ่ผิดปกติแปลว่า retention ไม่ทำงาน
    const growth = await growthReport();
    checks.tableGrowth = Object.fromEntries(
      growth.map((g) => [g.table, `${g.rows} แถว · ${Math.round(g.bytes / 1024)} KB`]),
    );
    const jobRuns = growth.find((g) => g.table === 'job_runs');
    // ทุก 15 วิ 7 วัน = ~40,000 แถว ถ้าเกินเท่าตัวแปลว่าไม่ถูกล้าง
    if (jobRuns && jobRuns.rows > 100_000) {
      checks.retentionWarning = 'job_runs ใหญ่ผิดปกติ — ตรวจว่า worker ทำงานอยู่ไหม';
      ok = false;
    }
  } catch {
    checks.tableGrowth = 'ตรวจไม่ได้';
  }

  try {
    const bad = await query<{ n: string }>(
      `SELECT count(*) AS n FROM meta_credentials WHERE status = 'invalid'`,
    );
    checks.invalidCredentials = Number(bad[0].n);
    if (Number(bad[0].n) > 0) ok = false;
  } catch {
    checks.invalidCredentials = 'ตรวจไม่ได้';
  }

  return Response.json({ ok, checks, at: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
