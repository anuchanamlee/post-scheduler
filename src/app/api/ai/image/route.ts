import { currentSession } from '../../../../lib/auth.js';
import { ingestImage } from '../../../../content/media.js';
import { generateImage, type ImageMode } from '../../../../content/image.js';
import type { Aspect } from '../../../../content/media.js';

/**
 * สร้างภาพด้วย AI — เป็น API route ไม่ใช่ server action โดยตั้งใจ
 *
 * หน้าทำโปสเตอร์เป็นฟอร์มเดียวทั้งหน้าอยู่แล้ว ฟอร์มซ้อนฟอร์มใน HTML ทำไม่ได้
 * และผลลัพธ์ต้องเด้งขึ้นมาโดยไม่ล้างสิ่งที่พิมพ์ค้างไว้ในช่องอื่น
 * ทั้งสองหน้าที่ใช้ (/image กับ /poster) จึงเรียกทางเดียวกันที่นี่
 *
 * รับเป็น multipart เพราะโหมดเปลี่ยนพื้นหลังต้องอัปโหลดรูปสินค้าได้ในจังหวะเดียวกัน
 */
export async function POST(req: Request) {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: 'หมดเวลาเข้าใช้งาน — เข้าสู่ระบบใหม่' }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const mode = String(form.get('mode') ?? 'illustration') as ImageMode;
    const topic = String(form.get('topic') ?? '');
    const aspect = String(form.get('aspect') ?? '4:5') as Aspect;

    // เลือกรูปเดิมจากคลัง หรืออัปโหลดใหม่ตรงนี้เลยก็ได้
    let refAssetId = String(form.get('refAssetId') ?? '') || null;
    const upload = form.get('refFile');
    if (upload instanceof File && upload.size > 0) {
      const asset = await ingestImage({
        tenantId: session.tenantId,
        buffer: Buffer.from(await upload.arrayBuffer()),
        mimeType: upload.type || 'image/jpeg',
        originalName: upload.name,
      });
      refAssetId = asset.id;
    }

    const made = await generateImage({
      tenantId: session.tenantId,
      userId: session.userId,
      mode,
      topic,
      aspect,
      refAssetId,
    });

    return Response.json(made);
  } catch (err) {
    // ข้อความจาก generateImage เขียนไว้ให้เจ้าของร้านอ่านรู้เรื่องอยู่แล้ว ส่งต่อตรงๆ
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
