import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/lib/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function main() {
  // รอ postgres พร้อม (compose start พร้อมกัน)
  for (let i = 0; i < 30; i++) {
    try {
      await query('SELECT 1');
      break;
    } catch {
      if (i === 29) throw new Error('เชื่อมต่อฐานข้อมูลไม่ได้');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] ข้าม ${file} (ทำไปแล้ว)`);
      continue;
    }
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    console.log(`[migrate] รัน ${file}`);
    await query(sql);
    await query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
  console.log('[migrate] เรียบร้อย');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] ล้มเหลว:', err);
  process.exit(1);
});
