import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../lib/env.js';
import { storage } from '../../../lib/storage.js';

/**
 * เสิร์ฟรูปเป็น public URL — Instagram ต้องเข้าถึงได้จากอินเทอร์เน็ต (รายงานข้อ B2)
 *
 * ความปลอดภัย: ชื่อไฟล์เป็นสุ่ม 24 ไบต์ เดาไม่ได้ (รายงานข้อ E4)
 * และ path ถูกตรวจว่าไม่หลุดออกนอก STORAGE_DIR
 *
 * ประสิทธิภาพ: มี ETag/Last-Modified เพื่อให้เบราว์เซอร์ถามกลับด้วย 304 แทนที่จะ
 * ให้เราอ่านไฟล์ทั้งใบเข้าหน่วยความจำใหม่ทุกครั้ง — หน้าคิวแสดงรูปย่อได้ถึง 60 ใบ
 * และการอ่านไฟล์นั่งอยู่บน event loop เดียวกับที่ render หน้าเว็บ
 *
 * โปรดักชันจริงควรย้ายไป object storage + signed URL แต่ interface ตรงนี้เหมือนกัน
 */
export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const { key } = await ctx.params;
  const rel = key.join('/');

  // ?download=1 = ให้เบราว์เซอร์บันทึกไฟล์แทนการเปิดดู
  const download = new URL(req.url).searchParams.has('download');

  // ใช้ S3 อยู่ = ไฟล์ไม่ได้อยู่ที่เครื่องนี้ ให้ปลายทางไปเอาจากต้นทางตรงๆ
  if (storage().kind !== 'local') {
    return Response.redirect(storage().url(rel), 302);
  }

  const root = path.resolve(env.storageDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) {
    return new Response('ไม่พบไฟล์', { status: 404 });
  }

  try {
    const stat = await fs.stat(full);
    // ขนาด+เวลาแก้ไขพอสำหรับไฟล์ที่ชื่อสุ่มและไม่เคยถูกเขียนทับ
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const lastModified = stat.mtime.toUTCString();

    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'public, max-age=3600' },
      });
    }

    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
        'Content-Length': String(stat.size),
        'Cache-Control': 'public, max-age=3600',
        ETag: etag,
        'Last-Modified': lastModified,
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${path.basename(full)}"` }
          : {}),
      },
    });
  } catch {
    return new Response('ไม่พบไฟล์', { status: 404 });
  }
}
