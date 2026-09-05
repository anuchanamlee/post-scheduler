import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './env.js';

/**
 * ที่เก็บไฟล์รูป
 *
 * ทำไมต้องมีชั้นนี้: รูปเป็นของที่ Instagram ต้องเข้าถึงได้จากอินเทอร์เน็ตตอนโพสต์
 * (รายงานข้อ B2) และเป็นของที่หายไม่ได้ — โปสเตอร์กับรูปสินค้าคือของที่ลูกค้าทำเอง
 * เก็บใน volume ของ container แปลว่า VPS ตายทีเดียวหายหมด
 *
 * driver 'local'  — เก็บในดิสก์ เสิร์ฟผ่าน /media/... ของแอปเอง (ใช้ตอนพัฒนา)
 * driver 's3'     — S3-compatible: Cloudflare R2, Backblaze B2, MinIO, S3 จริง
 *                   ใช้ตอนโปรดักชัน ไฟล์อยู่นอกเครื่อง VPS พังก็ไม่หาย
 *
 * ทุกที่ในระบบเรียกผ่าน interface นี้เท่านั้น ไม่มีใคร path.join(storageDir) เองอีก
 */

export type StoredFile = { key: string; url: string; bytes: number };

export interface Storage {
  readonly kind: string;
  put(key: string, data: Buffer, contentType: string): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** URL ที่ปลายทางภายนอกเข้าถึงได้จริง */
  url(key: string): string;
}

/** ชื่อไฟล์เดาไม่ได้ กันโปรโมชั่นรั่วก่อนเวลาโพสต์ (รายงานข้อ E4) */
export function randomKey(prefix: string, ext: string) {
  return `${prefix}/${crypto.randomBytes(24).toString('hex')}${ext}`;
}

// ── local ────────────────────────────────────────────────────

class LocalStorage implements Storage {
  readonly kind = 'local';

  private full(key: string) {
    const root = path.resolve(env.storageDir);
    const p = path.resolve(root, key);
    // กัน key ที่พยายามไต่ออกนอกโฟลเดอร์
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error('key ไม่ถูกต้อง');
    return p;
  }

  async put(key: string, data: Buffer): Promise<StoredFile> {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return { key, url: this.url(key), bytes: data.length };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.full(key));
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.full(key)).catch(() => { /* ไม่มีอยู่แล้วก็ถือว่าลบสำเร็จ */ });
  }

  url(key: string): string {
    return `${env.publicBaseUrl}/media/${key.replace(/\\/g, '/')}`;
  }
}

// ── S3-compatible ────────────────────────────────────────────

/**
 * ลงลายมือชื่อแบบ AWS SigV4 เอง แทนการลาก @aws-sdk/client-s3 (~10 MB) เข้ามา
 * ระบบนี้ใช้แค่ put/get/delete object — ไม่คุ้มที่จะแบก SDK ทั้งก้อนสำหรับ 3 คำสั่ง
 */
class S3Storage implements Storage {
  readonly kind = 's3';

  private get cfg() {
    const c = env.storage;
    if (!c.bucket || !c.accessKey || !c.secretKey || !c.endpoint) {
      throw new Error('ตั้งค่า S3 ไม่ครบ — ต้องมี endpoint, bucket, accessKey, secretKey');
    }
    return c;
  }

  private sign(method: string, key: string, payload: Buffer, contentType?: string) {
    const c = this.cfg;
    const url = new URL(`${c.endpoint.replace(/\/$/, '')}/${c.bucket}/${key}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort()
      .map((h) => `${h}:${headers[h]}\n`).join('');

    const canonicalRequest = [
      method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (k: Buffer | string, d: string) =>
      crypto.createHmac('sha256', k).update(d).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, dateStamp), c.region), 's3'),
                            'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { url: url.toString(), headers };
  }

  async put(key: string, data: Buffer, contentType: string): Promise<StoredFile> {
    const { url, headers } = this.sign('PUT', key, data, contentType);
    const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(data) });
    if (!res.ok) {
      throw new Error(`อัปโหลดขึ้น S3 ไม่สำเร็จ (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return { key, url: this.url(key), bytes: data.length };
  }

  async get(key: string): Promise<Buffer> {
    const { url, headers } = this.sign('GET', key, Buffer.alloc(0));
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`อ่านไฟล์จาก S3 ไม่สำเร็จ (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = this.sign('DELETE', key, Buffer.alloc(0));
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`ลบไฟล์บน S3 ไม่สำเร็จ (${res.status})`);
    }
  }

  url(key: string): string {
    const c = this.cfg;
    // ตั้ง publicBase เมื่อ bucket ต่อกับโดเมนของตัวเอง (R2 custom domain / CloudFront)
    const base = c.publicBase || `${c.endpoint.replace(/\/$/, '')}/${c.bucket}`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }
}

let cached: Storage | null = null;

export function storage(): Storage {
  if (!cached) cached = env.storage.driver === 's3' ? new S3Storage() : new LocalStorage();
  return cached;
}

/** ใช้ในเทสต์เมื่อสลับ driver ระหว่างรัน */
export function resetStorage() {
  cached = null;
}
