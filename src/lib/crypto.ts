import crypto from 'node:crypto';
import { env } from './env.js';

/**
 * AES-256-GCM สำหรับ token ของลูกค้า (รายงานข้อ E2)
 *
 * - GCM ไม่ใช่ CBC: มี auth tag แปลว่า ciphertext ที่ถูกแก้จะถอดไม่ผ่าน ไม่ใช่ได้ขยะเงียบๆ
 * - key มาจาก env/KMS เก็บคนละที่กับ ciphertext
 * - key_version ติดไปกับทุก record เพื่อ rotate ได้โดยไม่ต้องถอดใหม่ทั้งตารางในคราวเดียว
 */

export type Sealed = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

function keyFor(version: number): Buffer {
  const hex =
    version === env.encryptionKeyVersion
      ? env.encryptionKeyHex
      : process.env[`ENCRYPTION_KEY_HEX_V${version}`] ?? '';
  if (!hex) throw new Error(`ไม่มีคีย์เข้ารหัสเวอร์ชัน ${version}`);
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY_HEX ต้องเป็น hex 32 ไบต์ (64 ตัวอักษร)');
  return key;
}

export function seal(plaintext: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(env.encryptionKeyVersion), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: env.encryptionKeyVersion,
  };
}

export function open(sealed: Sealed): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFor(sealed.keyVersion),
    Buffer.from(sealed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** ใช้ตอน log/แสดงผล — ห้ามให้ token ตัวเต็มออกจากฝั่งเซิร์ฟเวอร์ */
export function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** รหัสผ่านผู้ใช้ — scrypt จาก node:crypto ไม่ต้องพึ่ง native dep */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashB64, 'base64'));
}
