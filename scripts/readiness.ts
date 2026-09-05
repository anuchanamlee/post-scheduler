import { pool, one, query } from '../src/lib/db.js';
import { readinessReport, readinessBlockers, type ReadinessItem } from '../src/core/config.js';
import { workerIsAlive } from '../src/core/queue.js';

/**
 * ตรวจก่อนส่งมอบ — "พร้อมให้ลูกค้าใช้จริงหรือยัง"
 *
 *   docker compose exec web npm run readiness
 *
 * ต่างจาก smoke/check-pages: สองตัวนั้นตอบว่าโค้ดทำงานถูกไหม
 * ตัวนี้ตอบว่า "ของที่ยังเป็นของจำลอง เหลืออะไรบ้าง" — เป็นคำถามที่ตอบผิดแล้วเสียลูกค้า
 * ไม่ใช่แค่บั๊ก
 *
 * exit 1 เมื่อมี blocker เพื่อให้เอาไปใส่ใน CI หรือขั้นตอน deploy ได้
 */

const ICON = { ok: 'พร้อม  ', warn: 'ควรทำ  ', blocker: 'ยังไม่ได้' } as const;

function print(i: ReadinessItem) {
  console.log(`${ICON[i.level]} ${i.key} — ${i.what}`);
  if (i.fix) console.log(`          → ${i.fix}`);
}

async function main() {
  console.log('\n── ความพร้อมของคอนฟิก ──\n');
  const items = readinessReport();
  for (const i of items) print(i);

  console.log('\n── ความพร้อมของข้อมูลจริง ──\n');
  const live: ReadinessItem[] = [];

  // เพจที่เชื่อมแล้วและ credential ที่ยังใช้ได้ — ไม่มี = ไม่มีอะไรให้โพสต์ลง
  const pages = await one<{ n: string; ok: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM page_credentials pc
                JOIN meta_credentials c ON c.id = pc.credential_id
               WHERE pc.page_id = sp.id AND c.status <> 'invalid' AND c.status <> 'revoked'
            ))::text AS ok
       FROM social_pages sp WHERE sp.is_active`);
  const nPages = Number(pages?.n ?? 0);
  const nOk = Number(pages?.ok ?? 0);
  live.push(nOk > 0
    ? { key: 'เพจที่เชื่อมต่อ', level: 'ok', what: `${nOk} เพจมี credential ที่ยังไม่ถูกตีตก` }
    : {
        key: 'เพจที่เชื่อมต่อ',
        level: 'blocker',
        what: nPages ? `มี ${nPages} เพจ แต่ยังไม่มี credential ที่ใช้ได้` : 'ยังไม่มีเพจที่เชื่อมต่อ',
        fix: 'ทำตาม docs/onboarding-runbook.md แล้วเก็บ System User token',
      });

  // เคยโพสต์ขึ้นของจริงหรือยัง — ดูที่ provider ของเพจปลายทาง ไม่ใช่รูปแบบของ id
  const real = await one<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM post_targets t
       JOIN social_pages sp ON sp.id = t.page_id
      WHERE t.status = 'posted' AND t.remote_id IS NOT NULL AND sp.provider = 'meta'`);
  const nReal = Number(real?.n ?? 0);
  live.push(nReal > 0
    ? { key: 'โพสต์ขึ้นเพจจริง', level: 'ok', what: `เคยขึ้นจริงแล้ว ${nReal} ครั้ง` }
    : {
        key: 'โพสต์ขึ้นเพจจริง',
        level: 'blocker',
        what: 'ยังไม่เคยมีโพสต์ขึ้นเพจจริงสักครั้ง — ที่เห็นสำเร็จทั้งหมดคือปลายทางจำลอง',
        fix: 'ตั้งค่าให้ครบแล้วส่งโพสต์ทดสอบ 1 ชิ้นลงเพจจริง',
      });

  // ช่องทางแจ้งเตือนที่ทดสอบแล้วว่าส่งถึงจริง
  const ch = await one<{ n: string; tested: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE last_sent_at IS NOT NULL)::text AS tested
       FROM notify_channels WHERE is_active`);
  live.push(Number(ch?.tested ?? 0) > 0
    ? { key: 'แจ้งเตือน', level: 'ok', what: `${ch?.tested} ช่องทางเคยส่งถึงจริงแล้ว` }
    : {
        key: 'แจ้งเตือน',
        level: 'warn',
        what: Number(ch?.n ?? 0)
          ? 'มีช่องทางแต่ยังไม่เคยกดทดสอบ — ไม่รู้ว่าส่งถึงจริงไหม'
          : 'ยังไม่มีช่องทางแจ้งเตือน โพสต์ล้มแล้วไม่มีใครรู้',
        fix: 'เพิ่มช่องทางที่ /settings แล้วกด "ทดสอบส่ง"',
      });

  // เจ้าของต้องเปลี่ยนรหัสจากรหัสตัวอย่างก่อนส่งมอบ
  const demo = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE email = 'owner@example.com'`);
  live.push(Number(demo?.n ?? 0) === 0
    ? { key: 'บัญชีตัวอย่าง', level: 'ok', what: 'ไม่มีบัญชี owner@example.com เหลืออยู่' }
    : {
        key: 'บัญชีตัวอย่าง',
        level: 'blocker',
        what: 'ยังมี owner@example.com / demo1234 อยู่ในระบบ — ใครก็เข้าได้',
        fix: 'สร้างบัญชีเจ้าของจริงที่ /settings แล้วลบบัญชีตัวอย่างทิ้ง',
      });

  const alive = await workerIsAlive();
  live.push(alive
    ? { key: 'ตัวส่งโพสต์', level: 'ok', what: 'ทำงานอยู่' }
    : { key: 'ตัวส่งโพสต์', level: 'blocker', what: 'ไม่ได้ทำงาน — ถึงเวลาแล้วโพสต์จะไม่ถูกส่ง',
        fix: 'docker compose up -d worker แล้วดู logs' });

  for (const i of live) print(i);

  const blockers = readinessBlockers([...items, ...live]);
  const warns = [...items, ...live].filter((i) => i.level === 'warn');

  console.log('');
  if (blockers.length === 0) {
    console.log(`พร้อมส่งมอบ${warns.length ? ` (ยังมี ${warns.length} ข้อที่ควรทำ)` : ''}`);
  } else {
    console.log(`ยังส่งมอบไม่ได้ — เหลือ ${blockers.length} ข้อที่ต้องทำก่อน:`);
    for (const b of blockers) console.log(`  · ${b.key} — ${b.what}`);
  }

  await pool.end();
  process.exit(blockers.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('ตรวจไม่สำเร็จ:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
