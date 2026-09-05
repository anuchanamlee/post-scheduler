import sharp from 'sharp';
import { one, query } from '../lib/db.js';
import { randomKey, storage } from '../lib/storage.js';

/**
 * เครื่องมือจัดการรูป — ครอปตามสัดส่วนของแต่ละแพลตฟอร์ม และวางข้อความทับ
 * ไม่มี AI สร้างภาพ ผู้ใช้อัปโหลดรูปเอง
 *
 * กฎเดียวที่ห้ามพัง: **ต้นฉบับห้ามถูกเขียนทับ** ครอปทุกครั้งคือไฟล์ใหม่
 * ไม่งั้น re-crop เป็นสัดส่วนอื่นวันหลังไม่ได้ (รายงานข้อ C3)
 */

export const ASPECTS = {
  '1:1': { w: 1080, h: 1080, label: 'ฟีดสี่เหลี่ยม' },
  '4:5': { w: 1080, h: 1350, label: 'ฟีดแนวตั้ง' },
  '9:16': { w: 1080, h: 1920, label: 'สตอรี่' },
  '1.91:1': { w: 1200, h: 628, label: 'ลิงก์แนวนอน' },
} as const;
export type Aspect = keyof typeof ASPECTS;

/** IG ปฏิเสธรูปที่สัดส่วนอยู่นอกช่วงนี้ — ตรวจฝั่งเราก่อน (รายงานข้อ D7) */
export const IG_MIN_RATIO = 0.8;   // 4:5
export const IG_MAX_RATIO = 1.91;  // 1.91:1
export const MAX_BYTES = 8 * 1024 * 1024;

export function validateForInstagram(width: number, height: number, bytes: number) {
  const problems: string[] = [];
  const ratio = width / height;
  if (ratio < IG_MIN_RATIO || ratio > IG_MAX_RATIO) {
    problems.push(`สัดส่วน ${ratio.toFixed(2)} อยู่นอกช่วงที่ Instagram รับ (0.80–1.91) — ครอปก่อน`);
  }
  if (bytes > MAX_BYTES) problems.push(`ไฟล์ใหญ่ ${(bytes / 1e6).toFixed(1)} MB เกิน 8 MB`);
  return problems;
}

export async function ingestImage(args: {
  tenantId: string;
  buffer: Buffer;
  originalName?: string;
  mimeType: string;
}) {
  const meta = await sharp(args.buffer).metadata();
  const isPng = meta.format === 'png';
  const key = randomKey('originals', isPng ? '.png' : '.jpg');
  const stored = await storage().put(key, args.buffer, isPng ? 'image/png' : 'image/jpeg');

  const row = await one<{ id: string }>(
    `INSERT INTO media_assets (tenant_id, storage_key, public_url, mime_type, width, height, bytes, status, original_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8) RETURNING id`,
    [
      args.tenantId,
      key,
      stored.url,
      args.mimeType,
      meta.width ?? null,
      meta.height ?? null,
      args.buffer.length,
      args.originalName ?? null,
    ],
  );
  return { id: row!.id, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * จุดที่ต้องอยู่ในกรอบเสมอ เป็นสัดส่วน 0–1 ของภาพต้นฉบับ
 * ไม่ระบุ = ให้ sharp เดาเอง (`position: attention`) ซึ่งบางทีตัดหัวคนหรือตัดสินค้าออก
 */
export type Focus = { x: number; y: number };

/**
 * คำนวณกรอบครอปจากจุดโฟกัส
 *
 * ทำเองแทนที่จะใช้ gravity ของ sharp เพราะ gravity เลือกได้แค่ 9 จุดตายตัว
 * ส่วนคนใช้อยากชี้ตรงไหนก็ได้บนรูป — และต้องได้ผลตรงกับพรีวิวที่เห็นบนหน้าจอ
 * ซึ่งใช้ CSS object-position เป็นเปอร์เซ็นต์
 */
export function cropRect(
  srcW: number, srcH: number, outW: number, outH: number, focus: Focus,
) {
  const scale = Math.max(outW / srcW, outH / srcH);
  // ขนาดพื้นที่บนภาพต้นฉบับที่จะถูกนำมาใช้จริง
  const cropW = Math.min(srcW, Math.round(outW / scale));
  const cropH = Math.min(srcH, Math.round(outH / scale));

  // จุดโฟกัสอยู่กลางกรอบ แต่ต้องไม่ล้นขอบภาพ
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const left = clamp(Math.round(focus.x * srcW - cropW / 2), 0, srcW - cropW);
  const top = clamp(Math.round(focus.y * srcH - cropH / 2), 0, srcH - cropH);

  return { left, top, width: cropW, height: cropH };
}

export type Overlay = {
  text: string;
  position?: 'top' | 'center' | 'bottom';
  color?: string;
  fontSize?: number;
};

/** ครอปเป็นสัดส่วนที่ต้องการ (+ ข้อความทับถ้ามี) — ต้นฉบับไม่ถูกแตะ */
export async function makeVariant(args: {
  tenantId: string;
  assetId: string;
  aspect: Aspect;
  overlay?: Overlay;
  /** จุดที่ต้องอยู่ในกรอบ — ไม่ใส่ = ให้ระบบเดาเอง */
  focus?: Focus;
}) {
  const asset = await one<{ storage_key: string; width: number | null; height: number | null }>(
    `SELECT storage_key, width, height FROM media_assets WHERE id = $1 AND tenant_id = $2`,
    [args.assetId, args.tenantId],
  );
  if (!asset) throw new Error('ไม่พบรูปต้นฉบับ');

  const spec = ASPECTS[args.aspect];
  const source = await storage().get(asset.storage_key);

  let img: sharp.Sharp;
  if (args.focus && asset.width && asset.height) {
    // ครอปตามจุดที่คนเลือก แล้วค่อยย่อ — ได้ผลตรงกับพรีวิวที่เห็นบนหน้าจอ
    const rect = cropRect(asset.width, asset.height, spec.w, spec.h, args.focus);
    img = sharp(source).extract(rect).resize(spec.w, spec.h);
  } else {
    img = sharp(source).resize(spec.w, spec.h, { fit: 'cover', position: 'attention' });
  }

  if (args.overlay?.text) {
    img = img.composite([{ input: Buffer.from(overlaySvg(args.overlay, spec.w, spec.h)), top: 0, left: 0 }]);
  }

  const out = await img.jpeg({ quality: 88 }).toBuffer();
  const key = randomKey('variants', '.jpg');
  const { url } = await storage().put(key, out, 'image/jpeg');
  await query(
    `INSERT INTO media_variants (tenant_id, asset_id, aspect_ratio, storage_key, public_url, width, height, bytes, overlay)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (asset_id, aspect_ratio) DO UPDATE
       SET storage_key = EXCLUDED.storage_key, public_url = EXCLUDED.public_url,
           bytes = EXCLUDED.bytes, overlay = EXCLUDED.overlay`,
    [
      args.tenantId,
      args.assetId,
      args.aspect,
      key,
      url,
      spec.w,
      spec.h,
      out.length,
      // เก็บจุดโฟกัสไว้ด้วย เผื่อกลับมาแก้ทีหลังจะได้เห็นว่าเคยเลือกตรงไหน
      JSON.stringify({ ...(args.overlay ?? {}), ...(args.focus ? { focus: args.focus } : {}) }),
    ],
  );
  return { url, width: spec.w, height: spec.h, bytes: out.length };
}

function overlaySvg(o: Overlay, w: number, h: number): string {
  const size = o.fontSize ?? Math.round(w / 14);
  const y = o.position === 'top' ? size * 1.6 : o.position === 'center' ? h / 2 : h - size;
  const text = o.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${y - size * 1.3}" width="${w}" height="${size * 1.8}" fill="rgba(0,0,0,0.45)"/>
    <text x="${w / 2}" y="${y}" font-family="Sarabun, sans-serif" font-size="${size}"
          font-weight="700" fill="${o.color ?? '#ffffff'}" text-anchor="middle">${text}</text>
  </svg>`;
}
