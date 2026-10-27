import fs from 'node:fs/promises';
import { pool, query } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';

/**
 * ล้างทุกอย่างกลับเป็นเดโมใหม่ — ใช้กับเดโมสาธารณะเท่านั้น
 *
 *   DEMO_RESET_ON_BOOT=1 npm run demo-wipe && npm run seed
 *
 * ทำไมต้องล้างทุกครั้งที่บูต: โฮสต์ฟรีให้ดิสก์ที่หายเมื่อเครื่องหลับ แต่ฐานข้อมูลยังอยู่
 * ถ้าไม่ล้าง แถวในตาราง media_assets จะชี้ไปหาไฟล์รูปที่ไม่มีแล้ว
 * และคนที่ลองเปลี่ยนรหัสผ่านเดโมจะทำให้คนถัดไปเข้าไม่ได้
 *
 * ต้องตั้ง DEMO_RESET_ON_BOOT=1 เท่านั้นถึงจะทำงาน — กันเผลอรันกับฐานข้อมูลของลูกค้าจริง
 */
async function main() {
  if (process.env.DEMO_RESET_ON_BOOT !== '1') {
    console.error('[demo-wipe] ไม่ได้ตั้ง DEMO_RESET_ON_BOOT=1 — ไม่ล้างอะไร');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const tables = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (tables.length) {
    const list = tables.map((t) => `"${t.tablename}"`).join(', ');
    await query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }

  await fs.rm(env.storageDir, { recursive: true, force: true });
  await fs.mkdir(env.storageDir, { recursive: true });

  console.log(`[demo-wipe] ล้าง ${tables.length} ตาราง และไฟล์ใน ${env.storageDir} แล้ว`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('[demo-wipe] ล้มเหลว:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
