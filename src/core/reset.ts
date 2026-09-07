import crypto from 'node:crypto';
import { one, query, tx } from '../lib/db.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { sendMail } from '../lib/mail.js';
import { env } from '../lib/env.js';

/**
 * ลืมรหัสผ่าน — ขอลิงก์ตั้งใหม่ทางอีเมล
 *
 * อยู่แยกจาก lib/auth.ts ด้วยเหตุผลเดียวกับ account.ts: ไฟล์นั้น import next/headers
 * เรียกนอก request ไม่ได้ = เทสต์ไม่ได้ และตรรกะความปลอดภัยต้องเทสต์ได้
 */

/** สั้นพอที่ลิงก์หลุดแล้วยังไม่ทันถูกใช้ ยาวพอที่คนเปิดเมลบนมือถือทัน */
const TTL_MINUTES = 60;
/** กันคนยิงซ้ำจนกล่องจดหมายเจ้าของร้านเต็ม — นับที่ผู้ใช้ ไม่ใช่ที่ IP (เหตุผลเดียวกับ login_attempts) */
const MAX_PER_HOUR = 3;
const MIN_PASSWORD = 8;

function fp(token: string): string {
  // sha256 เต็ม ไม่ใช่ fingerprint() ที่ตัดเหลือ 12 ตัว — อันนั้นมีไว้โชว์ใน log
  // ตัวนี้เป็นกุญแจค้นหาของความลับ สั้นเมื่อไหร่คือเปิดช่องให้ชนกันโดยตั้งใจ
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class ResetTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetTokenError';
  }
}

/**
 * ขอลิงก์
 *
 * คืนค่าเหมือนกันเสมอไม่ว่าอีเมลนั้นมีอยู่จริงหรือไม่ — หน้าลืมรหัสผ่านที่ตอบต่างกัน
 * คือเครื่องมือให้คนนอกไล่เช็คว่าใครมีบัญชีในระบบนี้บ้าง
 *
 * @returns ลิงก์ ถ้าผู้เรียกเป็นเจ้าของระบบและอยากได้ไปส่งเอง (`reveal`) ไม่งั้น null
 */
export async function requestReset(
  emailRaw: string, opts: { reveal?: boolean } = {},
): Promise<string | null> {
  const email = emailRaw.trim().toLowerCase();
  const user = await one<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = $1`, [email]);
  if (!user) return null;

  const recent = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM password_resets
      WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id]);
  if (Number(recent?.n ?? 0) >= MAX_PER_HOUR) return null;

  const token = randomToken(32);

  await tx(async (client) => {
    // คำขอเก่าที่ยังไม่ได้ใช้ต้องตายทันทีที่ขอใหม่ ไม่งั้นลิงก์เก่าที่อยู่ในเมลฉบับก่อน
    // (หรือในมือคนที่เห็นเมลนั้น) ยังใช้ได้อยู่
    await query(
      `UPDATE password_resets SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`, [user.id], client);
    await query(
      `INSERT INTO password_resets (user_id, token_fp, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [user.id, fp(token), String(TTL_MINUTES)], client);
  });

  const link = `${env.publicBaseUrl.replace(/\/$/, '')}/reset/${token}`;
  if (opts.reveal) return link;

  await sendMail({
    to: email,
    subject: 'ตั้งรหัสผ่านใหม่',
    text: [
      'มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชีนี้',
      '',
      link,
      '',
      `ลิงก์นี้ใช้ได้ ${TTL_MINUTES} นาที และใช้ได้ครั้งเดียว`,
      'ถ้าไม่ได้เป็นคนขอเอง ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ',
    ].join('\n'),
  });
  return null;
}

/** ลิงก์ยังใช้ได้อยู่ไหม — ใช้ตอนเปิดหน้า เพื่อไม่ให้คนกรอกรหัสใหม่เสร็จแล้วค่อยรู้ว่าหมดอายุ */
export async function resetTokenValid(token: string): Promise<boolean> {
  const row = await one(
    `SELECT 1 FROM password_resets
      WHERE token_fp = $1 AND used_at IS NULL AND expires_at > now()`, [fp(token)]);
  return Boolean(row);
}

/**
 * ใช้ลิงก์ตั้งรหัสใหม่
 *
 * เตะทุก session ทิ้ง รวมถึงเครื่องที่กำลังกดอยู่ — คนที่มาถึงหน้านี้คือคนที่เข้าไม่ได้
 * อยู่แล้ว ส่วนคนที่ยังล็อกอินค้างอยู่ในระบบอาจเป็นคนที่เรากำลังไล่ออก
 */
export async function consumeReset(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD) {
    throw new ResetTokenError(`รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัว`);
  }

  await tx(async (client) => {
    // ตัดสิทธิ์ใช้ token ในคำสั่งเดียวกับที่อ่านมัน — สองแท็บที่กดพร้อมกันจะได้ไม่ผ่านทั้งคู่
    const row = await one<{ user_id: string }>(
      `UPDATE password_resets SET used_at = now()
        WHERE token_fp = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`, [fp(token)], client);
    if (!row) throw new ResetTokenError('ลิงก์นี้ใช้ไปแล้วหรือหมดอายุ — ขอลิงก์ใหม่อีกครั้ง');

    await query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
                [row.user_id, hashPassword(newPassword)], client);
    await query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id], client);
    // ปลดล็อกที่ค้างจากการเดารหัส ไม่งั้นตั้งรหัสใหม่เสร็จแล้วยังเข้าไม่ได้อีก 15 นาที
    await query(
      `DELETE FROM login_attempts
        WHERE lower(email) = (SELECT lower(email) FROM users WHERE id = $1)`,
      [row.user_id], client);
  });
}
