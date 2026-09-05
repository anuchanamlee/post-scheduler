import crypto from 'node:crypto';
import { env } from '../../lib/env.js';
import { ProviderError, classifyMetaError } from '../errors.js';

/**
 * ตัวเรียก Graph API ตัวเดียวของทั้งระบบ
 * - ไม่มีที่อื่นเรียก graph.facebook.com เอง
 * - ไม่มี token โผล่ใน log หรือ error message
 */

export type GraphCall = {
  path: string;
  method?: 'GET' | 'POST';
  token: string;
  appSecret?: string;
  params?: Record<string, string | number | undefined>;
  timeoutMs?: number;
};

/** Meta บังคับ appsecret_proof สำหรับ call ที่ยิงจากเซิร์ฟเวอร์ (รายงานข้อ A2) */
export function appSecretProof(token: string, appSecret: string): string {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

export async function graph<T = unknown>(call: GraphCall): Promise<{ status: number; body: T }> {
  const url = new URL(`${env.meta.graphBaseUrl}/${env.meta.graphVersion}/${call.path}`);
  const form = new URLSearchParams();

  for (const [k, v] of Object.entries(call.params ?? {})) {
    if (v === undefined) continue;
    if (call.method === 'POST') form.set(k, String(v));
    else url.searchParams.set(k, String(v));
  }

  if (call.appSecret) {
    const proof = appSecretProof(call.token, call.appSecret);
    if (call.method === 'POST') form.set('appsecret_proof', proof);
    else url.searchParams.set('appsecret_proof', proof);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 30_000);

  try {
    const res = await fetch(url, {
      method: call.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${call.token}`,
        ...(call.method === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: call.method === 'POST' ? form : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (!res.ok) throw new ProviderError(classifyMetaError(body, res.status));
    return { status: res.status, body: body as T };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if ((err as Error).name === 'AbortError') {
      // หมดเวลา — สำคัญ: อาจสำเร็จฝั่ง Meta แล้วก็ได้ ห้าม retry ตาบอด (รายงานข้อ D2)
      throw new ProviderError({
        class: 'retryable',
        message: 'หมดเวลารอ Meta ตอบกลับ — ต้องตรวจก่อนว่าโพสต์ขึ้นไปแล้วหรือยัง',
        retryAfterMs: 60_000,
      });
    }
    throw new ProviderError({
      class: 'retryable',
      message: `เชื่อมต่อ Meta ไม่ได้: ${(err as Error).message}`,
      retryAfterMs: 60_000,
    });
  } finally {
    clearTimeout(timer);
  }
}
