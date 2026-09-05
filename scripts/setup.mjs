import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * เตรียม .env ให้พร้อมรัน — รันบนเครื่องเปล่าก่อน docker compose up
 *
 * ทำไมต้องมี: .env ไม่ได้อยู่ใน git (มีความลับ) แต่ compose บังคับ env_file: .env
 * เครื่องใหม่ที่ clone มาเลยรัน compose ไม่ขึ้นเลย และถ้าคัดลอกจาก .env.example ตรงๆ
 * ก็จะได้ ENCRYPTION_KEY_HEX ว่าง ซึ่งไม่พังตอนบูต แต่ไปพังตอนกดเชื่อมเพจ
 * = พังตอนอยู่หน้าลูกค้า ตัวนี้เลยสร้างความลับให้เสร็จตั้งแต่ต้น
 *
 * ใช้ node เปล่า ไม่พึ่ง npm install เพราะต้องรันได้ก่อนมี container
 *
 *   node scripts/setup.mjs
 */

const hex32 = () => randomBytes(32).toString('hex');
const secret = () => randomBytes(24).toString('base64url');

if (!existsSync('.env.example')) {
  console.error('ไม่เจอ .env.example — รันคำสั่งนี้ที่โฟลเดอร์โปรเจค');
  process.exit(1);
}

let text;
let created;
if (existsSync('.env')) {
  // มีอยู่แล้วห้ามทับ — ในนั้นอาจมีคีย์ที่เข้ารหัส token ของลูกค้าไว้
  // ทับทิ้ง = token ที่เก็บไว้ทั้งหมดถอดไม่ออกอีกเลย
  text = readFileSync('.env', 'utf8');
  created = false;
} else {
  text = readFileSync('.env.example', 'utf8');
  created = true;
}

/** เติมเฉพาะค่าที่ยังว่าง ไม่แตะของที่ตั้งไว้แล้ว */
function fill(key, make, why) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = text.match(re);
  if (m && m[1].trim()) return false;
  const line = `${key}=${make()}`;
  text = m ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
  console.log(`  สร้าง ${key} ให้ใหม่ — ${why}`);
  return true;
}

const filled = [
  fill('ENCRYPTION_KEY_HEX', hex32, 'ใช้เข้ารหัส token ของเพจก่อนเก็บลงฐานข้อมูล'),
  fill('CRON_SECRET', secret, 'กันคนนอกยิง /api/cron สั่งให้โพสต์'),
].filter(Boolean).length;

writeFileSync('.env', text);

console.log(created ? '\nสร้าง .env จาก .env.example แล้ว' : '\n.env เดิมยังอยู่ครบ ไม่ได้ทับ');
if (filled === 0) console.log('ความลับครบอยู่แล้ว ไม่ได้เปลี่ยนอะไร');
console.log(`
สำรอง .env ไว้ที่ปลอดภัยด้วย — ENCRYPTION_KEY_HEX หายเมื่อไหร่
token ของเพจที่เก็บไว้จะถอดไม่ออกอีกเลย ต้องไปออก token ใหม่จาก Business Manager ทั้งหมด

ขั้นถัดไป:  docker compose up -d --build`);
