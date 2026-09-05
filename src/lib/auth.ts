import { cookies } from 'next/headers';
import { one, query } from './db.js';
import { randomToken, verifyPassword } from './crypto.js';
import { changePassword as changePasswordCore } from '../core/account.js';

/**
 * auth มีตั้งแต่ commit แรก (รายงานข้อ E1)
 * ระบบนี้ถือ credential ที่โพสต์ลงเพจลูกค้าได้ — หน้าเว็บที่ใครเปิดก็ใช้ได้ไม่ใช่ตัวเลือก
 */

const COOKIE = 'sid';
const TTL_DAYS = 14;

/**
 * หน่วงการเดารหัสผ่าน
 *
 * 5 ครั้งแรกปล่อยผ่าน (คนพิมพ์ผิดจริงมีอยู่) จากนั้นล็อก 15 นาที
 * ล็อกชั่วคราวไม่ใช่ถาวร เพราะนับที่อีเมล — คนอื่นยิงอีเมลเจ้าของร้านให้ล็อกได้
 * ถ้าล็อกถาวรจะกลายเป็นช่องปิดร้านคนอื่นแทน
 *
 * ตัวนับรีเซ็ตทันทีที่ล็อกอินสำเร็จ
 */
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export class LoginLockedError extends Error {
  constructor(public readonly until: Date) {
    const mins = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
    super(`กรอกรหัสผิดหลายครั้งเกินไป — ลองใหม่อีกครั้งใน ${mins} นาที`);
    this.name = 'LoginLockedError';
  }
}

async function assertNotLocked(email: string) {
  const row = await one<{ locked_until: Date | null }>(
    `SELECT locked_until FROM login_attempts WHERE email = $1`, [email]);
  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    throw new LoginLockedError(new Date(row.locked_until));
  }
}

async function recordFail(email: string) {
  const row = await one<{ fails: number; locked_until: Date | null }>(
    `INSERT INTO login_attempts (email, fails, last_fail_at)
     VALUES ($1, 1, now())
     ON CONFLICT (email) DO UPDATE
       SET fails = login_attempts.fails + 1,
           last_fail_at = now(),
           -- ครบเพดานเมื่อไหร่ ล็อกทันทีในคำสั่งเดียวกัน ไม่ต้องอ่านแล้วเขียนกลับ
           -- (สอง request ที่มาพร้อมกันจะได้ไม่แย่งกันเขียนจนตัวนับหาย)
           locked_until = CASE
             WHEN login_attempts.fails + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
             ELSE login_attempts.locked_until
           END
     RETURNING fails, locked_until`,
    [email, MAX_FAILS, String(LOCK_MINUTES)],
  );
  if (row?.locked_until && new Date(row.locked_until) > new Date()) {
    throw new LoginLockedError(new Date(row.locked_until));
  }
}

async function clearFails(email: string) {
  await query(`DELETE FROM login_attempts WHERE email = $1`, [email]);
}

export type Session = { userId: string; tenantId: string; email: string; role: string };

export async function signIn(email: string, password: string): Promise<Session> {
  const key = email.toLowerCase().trim();
  await assertNotLocked(key);

  const user = await one<{ id: string; tenant_id: string; password_hash: string; role: string }>(
    `SELECT id, tenant_id, password_hash, role FROM users WHERE email = $1`,
    [key],
  );
  if (!user || !verifyPassword(password, user.password_hash)) {
    // นับทั้งอีเมลที่ไม่มีในระบบด้วย ไม่งั้นคนเดาจะรู้ว่าอีเมลไหนมีอยู่จริงจากการที่มันไม่ถูกล็อก
    await recordFail(key);
    throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  await clearFails(key);

  const token = randomToken();
  const expires = new Date(Date.now() + TTL_DAYS * 86400_000);
  await query(
    `INSERT INTO sessions (token, user_id, tenant_id, expires_at) VALUES ($1,$2,$3,$4)`,
    [token, user.id, user.tenant_id, expires],
  );

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires,
    path: '/',
  });

  return { userId: user.id, tenantId: user.tenant_id, email, role: user.role };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await query(`DELETE FROM sessions WHERE token = $1`, [token]);
  jar.delete(COOKIE);
}

export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const row = await one<{ user_id: string; tenant_id: string; email: string; role: string }>(
    `SELECT s.user_id, s.tenant_id, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return row
    ? { userId: row.user_id, tenantId: row.tenant_id, email: row.email, role: row.role }
    : null;
}

/** ใช้ในทุก action/หน้า ที่แตะข้อมูลลูกค้า — ไม่มี session = ไม่มี tenantId = query ไม่ได้ */
export async function requireSession(): Promise<Session> {
  const s = await currentSession();
  if (!s) throw new Error('ต้องเข้าสู่ระบบก่อน');
  return s;
}

/**
 * บังคับสิทธิ์ที่ชั้น action ไม่ใช่แค่ซ่อนปุ่มใน UI
 * ซ่อนปุ่มกันคนที่ไม่ตั้งใจ ไม่ได้กันคนที่ตั้งใจ
 */
export async function requireRole(...roles: string[]): Promise<Session> {
  const s = await requireSession();
  if (!roles.includes(s.role)) {
    throw new Error('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
  }
  return s;
}

/** ตัวห่อของ core/account: อ่าน cookie ให้เอง เครื่องที่กำลังใช้อยู่จะได้ไม่โดนเตะ */
export async function changePassword(
  userId: string, currentPassword: string, newPassword: string,
): Promise<void> {
  const token = (await cookies()).get(COOKIE)?.value ?? '';
  await changePasswordCore(userId, currentPassword, newPassword, token);
}
