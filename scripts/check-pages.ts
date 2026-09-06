import { pool, one, query } from '../src/lib/db.js';
import { randomToken } from '../src/lib/crypto.js';

/**
 * ตรวจว่าฟีเจอร์ที่เขียนไว้ "ขึ้นหน้าเว็บจริง"
 *
 * มีเพราะเคยพลาดมาแล้ว: ชุดแฮชแท็กเขียนโค้ดครบ เทสต์ผ่าน build ผ่าน
 * แต่สคริปต์ที่แทรก JSX หา anchor ไม่เจอแล้วเงียบ — ของเลยไม่เคยขึ้นหน้าเลย
 *
 * smoke ทดสอบ "ตรรกะทำงานถูกไหม" · ตัวนี้ทดสอบ "คนเปิดเว็บแล้วเห็นไหม"
 *
 *   docker compose exec web npm run check-pages
 */

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3000';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'ผ่าน  ' : 'ไม่ผ่าน'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // สร้าง session ชั่วคราวเพื่อเข้าหน้าที่ต้องล็อกอิน
  const user = await one<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM users ORDER BY created_at LIMIT 1`);
  if (!user) {
    console.error('ยังไม่มีผู้ใช้ในระบบ — รัน npm run seed ก่อน');
    process.exit(1);
  }

  const token = randomToken();
  await query(
    `INSERT INTO sessions (token, user_id, tenant_id, expires_at)
     VALUES ($1,$2,$3, now() + interval '10 minutes')`,
    [token, user.id, user.tenant_id],
  );

  const asset = await one<{ id: string }>(
    `SELECT id FROM media_assets WHERE status = 'ready' LIMIT 1`);
  const post = await one<{ id: string }>(
    `SELECT id FROM scheduled_posts WHERE status IN ('pending','draft') LIMIT 1`);

  /** หน้า → ข้อความที่ต้องเห็นบนหน้านั้น */
  const pages: Array<[string, string[]]> = [
    ['/', ['คิวโพสต์', 'ตัวส่งโพสต์', 'โควตา Instagram', 'เพิ่มโพสต์']],
    ['/?view=month', ['month-grid', 'เดือนถัดไป', 'month-cell']],
    ['/?view=list', ['โพสต์ทั้งหมด']],
    ['/new', ['โพสต์ลงที่ไหน', 'ให้ AI ช่วยร่าง', 'เวลาที่จะโพสต์', 'สูงสุด 10 ใบ']],
    ['/poster', ['ลดราคา', 'ของใหม่', 'เมนูแนะนำ', 'รูปสินค้า', 'สร้างโปสเตอร์',
                 'ภาพเต็มใบ', 'ให้ AI สร้างฉากให้', 'สร้างฉาก']],
    // ภาพ AI: หน้าต้องบอกทั้งสองข้อจำกัดไว้ตลอด ไม่ใช่ซ่อนไว้ในเอกสาร
    ['/image', ['สร้างภาพด้วย AI', 'ภาพประกอบโพสต์', 'ฉากพื้นหลัง',
                'เปลี่ยนพื้นหลังรูปสินค้า', 'โปสเตอร์ทั้งใบ',
                'ไม่มีตัวหนังสือ', 'อธิบายภาพที่อยากได้', 'สร้างภาพ']],
    ['/library', ['คลังรูป', 'ทั้งหมด', 'ภาพจาก AI', 'bottom-nav', 'ทางเข้าหลัก']],
    ['/insights', ['ผลตอบรับ']],
    ['/grid', ['ฟีด Instagram']],
    ['/alerts', ['แจ้งเตือน']],
    ['/approvals', ['รอตรวจ']],
    // แถบทางลัดต้องขึ้นจริง ไม่ใช่เขียนโค้ดไว้เฉยๆ
    ['/settings', [
      'ทางลัดไปหมวดตั้งค่า', 'settings-jump', 'id="voice"', 'id="quota"',
      'เพจที่เชื่อมต่อไว้', 'เชื่อมต่อเพจใหม่', 'ตรวจเดี๋ยวนี้',
      'ชุดแฮชแท็ก', 'เพิ่มชุด',
      'บัญชีของฉัน', 'รหัสผ่านเดิม', 'เปลี่ยนรหัสผ่าน',
      'ทีมงานและการอนุมัติ', 'เพิ่มคนในทีม',
      'แจ้งเตือนเข้า LINE', 'Channel access token',
      'ตารางเวลาประจำ', 'เพิ่มช่วงเวลา',
      'โทนเสียงของเพจ', 'โควตา AI', 'ภาพที่สร้างด้วย AI',
    ]],
    ['/login', ['เข้าสู่ระบบ']],
  ];

  if (asset) pages.push([`/crop/${asset.id}`, ['คลิกตรงจุด', 'ผลที่จะได้', 'ครอปตามนี้']]);
  if (post) pages.push([`/post/${post.id}`, ['แก้ไขโพสต์', 'บันทึกการแก้ไข']]);

  console.log('── ตรวจว่าทุกหน้าเปิดได้และมีของที่ควรมี ──\n');

  for (const [path, needles] of pages) {
    let html = '';
    let status = 0;
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { cookie: `sid=${token}` },
        redirect: 'manual',
      });
      status = res.status;
      html = await res.text();
    } catch (err) {
      check(false, path, `เปิดไม่ได้: ${(err as Error).message}`);
      continue;
    }

    if (status !== 200) {
      check(false, path, `HTTP ${status}`);
      continue;
    }

    // React แทรกคอมเมนต์คั่นระหว่าง text node ต้องเอาออกก่อนค้นข้อความ
    const clean = html.replace(/<!--.*?-->/gs, '');
    const missing = needles.filter((n) => !clean.includes(n));
    check(missing.length === 0, path,
      missing.length ? `ไม่เจอ: ${missing.join(' · ')}` : `${needles.length} จุดครบ`);
  }

  // health ต้องบอกว่าระบบทำงานอยู่จริง
  try {
    const res = await fetch(`${BASE}/api/health`);
    const body = await res.json() as { ok: boolean; checks: Record<string, unknown> };
    check(body.ok === true, '/api/health', `ok=${body.ok}`);
    check(Boolean((body.checks.worker as { alive?: boolean })?.alive),
      'ตัวส่งโพสต์ยังทำงานอยู่');
  } catch (err) {
    check(false, '/api/health', (err as Error).message);
  }

  // ข้อมูลตัวอย่างต้องโพสต์ได้จริง
  // เคยพลาดมาแล้ว: seed สร้างโพสต์แต่ไม่ผูกรูป (post_media ว่าง)
  // เว็บดูปกติทุกหน้า แต่พอ worker หยิบ โพสต์ล้มหมดทันที
  // = ลูกค้าเปิดระบบครั้งแรกเจอสีแดง 3 ชิ้น
  const orphan = await one<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM scheduled_posts p
      WHERE p.status IN ('pending','draft','pending_approval')
        AND NOT EXISTS (SELECT 1 FROM post_media m WHERE m.post_id = p.id)`);
  check(Number(orphan?.n ?? 0) === 0, 'ทุกโพสต์ที่รอคิวมีรูปผูกไว้จริง',
    Number(orphan?.n ?? 0) ? `ไม่มีรูป ${orphan!.n} โพสต์ — จะล้มตอน worker หยิบ` : 'ครบ');

  // ไม่มีคน login ต้องเด้งไปหน้าเข้าสู่ระบบ ไม่ใช่เห็นข้อมูลลูกค้า
  const anon = await fetch(`${BASE}/`, { redirect: 'manual' });
  check(anon.status === 307 || anon.status === 302,
    'ไม่ได้ล็อกอินต้องเด้งไปหน้าเข้าสู่ระบบ', `HTTP ${anon.status}`);

  await query(`DELETE FROM sessions WHERE token = $1`, [token]);

  console.log(`\n${failures === 0 ? 'ทุกหน้าครบ' : `มีปัญหา ${failures} จุด`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ตรวจไม่สำเร็จ:', err);
  process.exit(1);
});
