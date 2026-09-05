import { one, query } from '../lib/db.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';

/**
 * บัญชีผู้ใช้ — ส่วนที่ไม่ผูกกับ request
 *
 * อยู่แยกจาก lib/auth.ts เพราะไฟล์นั้น import next/headers
 * ซึ่งเรียกนอก request ไม่ได้ = เทสต์ไม่ได้ ตรรกะความปลอดภัยต้องเทสต์ได้
 */

/**
 * เปลี่ยนรหัสผ่านตัวเอง
 *
 * ทำไมต้องมี: เจ้าของตั้งรหัสตั้งต้นให้คนในทีมแล้วส่งต่อทางแชท
 * รหัสนั้นค้างในแชทตลอดไป ถ้าเจ้าตัวเปลี่ยนเองไม่ได้ = ทุกคนที่เคยเห็นแชทยังเข้าได้
 *
 * @param keepToken session ที่ไม่ต้องเตะออก (เครื่องที่กำลังกดเปลี่ยนอยู่)
 */
export async function changePassword(
  userId: string, currentPassword: string, newPassword: string, keepToken = '',
): Promise<void> {
  if (newPassword.length < 8) throw new Error('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัว');
  if (newPassword === currentPassword) throw new Error('รหัสผ่านใหม่ต้องไม่ซ้ำของเดิม');

  // ต้องกรอกรหัสเดิม — คนที่ยืมเครื่องที่เปิดค้างไว้จะได้ยึดบัญชีไม่ได้
  const user = await one<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  }

  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
              [userId, hashPassword(newPassword)]);

  // เตะ session อื่นทิ้ง ไม่งั้นคนที่ล็อกอินค้างอยู่ยังใช้ได้ต่อ
  // = เปลี่ยนรหัสแล้วไม่ได้กันใครออกจริง
  await query(`DELETE FROM sessions WHERE user_id = $1 AND token <> $2`, [userId, keepToken]);
}
