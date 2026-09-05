/**
 * แผนที่ error ของ Meta → จะ retry หรือหยุด (รายงานข้อ D8)
 *
 * ไม่มีตารางนี้ ระบบจะ retry สิ่งที่ retry ไปก็ไม่มีวันสำเร็จ (permission ผิด)
 * และจะยอมแพ้กับสิ่งที่แค่รอสักครู่ก็ผ่าน (rate limit)
 */

export type ErrorClass =
  | 'retryable'        // ลองใหม่ได้ ปัญหาชั่วคราว
  | 'rate_limited'     // ลองใหม่ได้ แต่ต้องรอนาน
  | 'credential'       // token ใช้ไม่ได้ — หยุดทั้งลูกค้า ไม่ใช่แค่โพสต์นี้
  | 'permanent'        // ข้อมูลผิด/ถูกปฏิเสธ — retry ไปก็เท่านั้น
  | 'unknown';

export type ClassifiedError = {
  class: ErrorClass;
  code?: number;
  subcode?: number;
  message: string;
  retryAfterMs?: number;
};

export class ProviderError extends Error {
  readonly classified: ClassifiedError;
  constructor(classified: ClassifiedError) {
    super(classified.message);
    this.name = 'ProviderError';
    this.classified = classified;
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const CREDENTIAL_CODES = new Set([102, 190, 458, 459, 463, 464, 467]);
const PERMISSION_CODES = new Set([10, 200, 803]);
const TRANSIENT_CODES = new Set([1, 2, 341]);

export function classifyMetaError(body: unknown, httpStatus?: number): ClassifiedError {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : undefined;
  const subcode = typeof err?.error_subcode === 'number' ? err.error_subcode : undefined;
  const message =
    (typeof err?.message === 'string' && err.message) ||
    `Meta ตอบกลับผิดพลาด (HTTP ${httpStatus ?? '?'})`;

  if (code !== undefined) {
    if (CREDENTIAL_CODES.has(code)) {
      // token ใช้ไม่ได้: ต้อง flag ทั้ง credential ไม่ใช่แค่ retry โพสต์นี้ (รายงานข้อ A3/E3)
      return { class: 'credential', code, subcode, message };
    }
    if (RATE_LIMIT_CODES.has(code)) {
      return { class: 'rate_limited', code, subcode, message, retryAfterMs: 15 * 60_000 };
    }
    if (PERMISSION_CODES.has(code)) {
      return { class: 'permanent', code, subcode, message };
    }
    if (TRANSIENT_CODES.has(code)) {
      return { class: 'retryable', code, subcode, message, retryAfterMs: 60_000 };
    }
    if (code === 100) {
      // parameter ผิด — เช่น image_url เข้าไม่ถึง หรือ aspect ratio ไม่ผ่าน
      return { class: 'permanent', code, subcode, message };
    }
  }

  if (httpStatus && httpStatus >= 500) {
    return { class: 'retryable', code, subcode, message, retryAfterMs: 60_000 };
  }
  if (httpStatus === 429) {
    return { class: 'rate_limited', code, subcode, message, retryAfterMs: 15 * 60_000 };
  }
  return { class: 'unknown', code, subcode, message, retryAfterMs: 120_000 };
}

export function isRetryable(c: ClassifiedError): boolean {
  return c.class === 'retryable' || c.class === 'rate_limited' || c.class === 'unknown';
}

/** ถอยแบบทวีคูณ + jitter กันทุก target ตื่นพร้อมกัน */
export function backoffMs(attempt: number, base = 60_000, cap = 60 * 60_000): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.75 + Math.random() * 0.5));
}
