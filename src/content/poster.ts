import sharp from 'sharp';
import { one, query } from '../lib/db.js';
import { randomKey, storage } from '../lib/storage.js';

/**
 * สร้างโปสเตอร์สินค้าจากรูป + เทมเพลต
 *
 * ค่าเริ่มต้นยังเป็น "รูปสินค้าจริง" เสมอ: โปสเตอร์ขายของต้องเป็นสินค้าของร้านนั้นจริงๆ
 * AI วาดกาแฟสวยได้ แต่ไม่ใช่กาแฟของร้านนี้ ลูกค้าเห็นของจริงแล้วไม่ตรง = เสียความน่าเชื่อถือ
 *
 * รูปที่ AI สร้าง (ฉากพื้นหลัง / เปลี่ยนพื้นหลังรูปสินค้าจริง — ดู `content/image.ts`)
 * เข้ามาทางช่องเดียวกับรูปอัปโหลด เพราะเมื่อถึงชั้นนี้มันคือ media_asset ใบหนึ่งเหมือนกัน
 * ที่มาของแต่ละใบตามหลังได้จากตาราง `ai_images`
 *
 * ตัวหนังสือทั้งหมดวาดด้วยฟอนต์ไทยจริง (Garuda/Loma ที่ติดตั้งใน image)
 * **ไม่มีทางให้ AI เขียนแทน** — โมเดลสร้างภาพยังเขียนไทยไม่ถูก สระลอย วรรณยุกต์ผิดที่
 * นี่คือเหตุผลที่ prompt ทุกอันสั่งห้ามใส่ตัวอักษรลงในภาพ แล้วมาวาดทับตรงนี้แทน
 */

export const ASPECTS = {
  '1:1': { w: 1080, h: 1080, label: 'สี่เหลี่ยมจัตุรัส (ฟีด)' },
  '4:5': { w: 1080, h: 1350, label: 'แนวตั้ง (ฟีด)' },
  '9:16': { w: 1080, h: 1920, label: 'สตอรี่' },
} as const;
export type PosterAspect = keyof typeof ASPECTS;

export type PosterInput = {
  headline: string;      // หัวเรื่องใหญ่ เช่น "ลด 20%"
  subline?: string;      // บรรทัดรอง เช่น "ทุกชิ้นทั้งร้าน"
  price?: string;        // ราคาใหม่
  oldPrice?: string;     // ราคาเดิม (ขีดฆ่า)
  note?: string;         // เงื่อนไข เช่น "ถึง 30 ก.ย. นี้"
  brand?: string;        // ชื่อร้าน
};

export type TemplateId =
  | 'sale' | 'new-arrival' | 'menu' | 'hours' | 'bogo' | 'announce' | 'ai-scene';

type Palette = { bg: string; ink: string; accent: string; accentInk: string };

type Template = {
  id: TemplateId;
  name: string;
  hint: string;
  palette: Palette;
  /** สัดส่วนพื้นที่รูปสินค้าเทียบกับความสูงทั้งหมด */
  photoRatio: number;
  photoPosition: 'top' | 'bottom';
  fields: Array<keyof PosterInput>;
  sample: PosterInput;
};

/**
 * เทมเพลต 7 แบบ — 6 แบบแรกตามที่เสนอลูกค้าไว้ บวก "ภาพเต็มใบ" ที่เพิ่มมาพร้อมภาพ AI
 * แต่ละแบบคุมแค่ "โครง" — สี ตำแหน่งรูป และช่องที่ต้องกรอก
 * เพราะร้านค้าต้องการความคาดเดาได้ ไม่ใช่ผลลัพธ์ที่เปลี่ยนไปทุกครั้ง
 */
export const TEMPLATES: Template[] = [
  {
    id: 'sale', name: 'ลดราคา', hint: 'เน้นตัวเลขส่วนลดให้เห็นแต่ไกล',
    palette: { bg: '#b42318', ink: '#ffffff', accent: '#ffd166', accentInk: '#1a1200' },
    photoRatio: 0.56, photoPosition: 'top',
    fields: ['headline', 'subline', 'price', 'oldPrice', 'note', 'brand'],
    sample: { headline: 'ลด 20%', subline: 'ทุกชิ้นทั้งร้าน', price: '฿240', oldPrice: '฿300',
              note: 'ถึงสิ้นเดือนนี้', brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'new-arrival', name: 'ของใหม่', hint: 'ป้าย “ใหม่” มุมบน เน้นตัวสินค้า',
    palette: { bg: '#10131a', ink: '#ffffff', accent: '#3b3fd8', accentInk: '#ffffff' },
    photoRatio: 0.64, photoPosition: 'top',
    fields: ['headline', 'subline', 'price', 'brand'],
    sample: { headline: 'ของใหม่เข้าร้าน', subline: 'มาลองก่อนใครได้เลย', price: '฿180',
              brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'menu', name: 'เมนูแนะนำ', hint: 'ชื่อเมนูกับราคาอ่านง่าย เหมาะกับร้านอาหาร',
    palette: { bg: '#1f3d2b', ink: '#ffffff', accent: '#e8c56a', accentInk: '#1a1200' },
    photoRatio: 0.62, photoPosition: 'top',
    fields: ['headline', 'subline', 'price', 'note', 'brand'],
    sample: { headline: 'ข้าวผัดกุ้ง', subline: 'สูตรต้นตำรับ', price: '฿89',
              note: 'สั่งกลับบ้านได้', brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'hours', name: 'เวลาเปิด-ปิด', hint: 'บอกเวลาให้เห็นชัดที่สุดบนจอมือถือ',
    palette: { bg: '#0f2b46', ink: '#ffffff', accent: '#5ec2f0', accentInk: '#062033' },
    photoRatio: 0.46, photoPosition: 'bottom',
    fields: ['headline', 'subline', 'note', 'brand'],
    sample: { headline: 'เปิด 09:00 – 21:00', subline: 'ทุกวันไม่มีวันหยุด',
              note: 'ครัวปิด 20:30', brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'bogo', name: 'ซื้อ 1 แถม 1', hint: 'โปรที่ต้องอ่านออกใน 2 วินาที',
    palette: { bg: '#7a2d8f', ink: '#ffffff', accent: '#ffd166', accentInk: '#2a0f33' },
    photoRatio: 0.54, photoPosition: 'top',
    fields: ['headline', 'subline', 'note', 'brand'],
    sample: { headline: 'ซื้อ 1 แถม 1', subline: 'เฉพาะเมนูที่ร่วมรายการ',
              note: 'วันนี้ถึงวันอาทิตย์', brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'ai-scene', name: 'ภาพเต็มใบ', hint: 'ข้อความวางทับภาพทั้งใบ เหมาะกับฉากที่ AI สร้าง',
    palette: { bg: '#0b0b0d', ink: '#ffffff', accent: '#ffd166', accentInk: '#1a1200' },
    photoRatio: 1, photoPosition: 'top',
    fields: ['headline', 'subline', 'price', 'oldPrice', 'note', 'brand'],
    sample: { headline: 'เปิดแล้ววันนี้', subline: 'บรรยากาศใหม่ทั้งร้าน',
              note: 'ทุกวัน 09:00–21:00', brand: 'ร้านตัวอย่าง' },
  },
  {
    id: 'announce', name: 'ประกาศทั่วไป', hint: 'ข้อความล้วน ใช้ได้กับทุกเรื่อง',
    palette: { bg: '#f5f2ea', ink: '#1a1712', accent: '#b4531d', accentInk: '#ffffff' },
    photoRatio: 0.5, photoPosition: 'top',
    fields: ['headline', 'subline', 'note', 'brand'],
    sample: { headline: 'ปิดปรับปรุงร้าน', subline: '5–7 กันยายนนี้',
              note: 'ขออภัยในความไม่สะดวก', brand: 'ร้านตัวอย่าง' },
  },
];

function getTemplate(id: string): Template {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`ไม่รู้จักเทมเพลต "${id}"`);
  return t;
}

/** ตัดข้อความยาวให้พอดีบรรทัด — โปสเตอร์อ่านจากระยะไกล ยาวเกินคืออ่านไม่ทัน */
function fit(text: string, max: number) {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function esc(text: string) {
  return text.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * ชั้นข้อความวาดเป็น SVG แล้ว composite ทับรูป
 * ฟอนต์ Garuda มีสระบนล่างครบและอ่านง่ายในขนาดใหญ่ Loma ใช้กับตัวหนา
 */
function textLayer(t: Template, input: PosterInput, w: number, h: number): string {
  /**
   * เต็มใบ = ไม่มีแถบสีทึบให้วางข้อความ ต้องใช้ม่านไล่สีคลุมครึ่งล่างแทน
   * ถ้าวางตัวขาวบนภาพเปล่าๆ ภาพสว่างเมื่อไหร่ข้อความหายทันที — และเรารู้ล่วงหน้าไม่ได้
   * ว่าภาพที่ AI ส่งมาจะสว่างหรือมืด
   */
  const fullBleed = t.photoRatio >= 1;
  const photoH = Math.round(h * Math.min(t.photoRatio, 1));
  const panelH = fullBleed ? Math.round(h * 0.46) : h - photoH;
  const panelTop = fullBleed
    ? h - panelH
    : (t.photoPosition === 'top' ? photoH : 0);
  const pad = Math.round(w * 0.075);
  const p = t.palette;

  // ขนาดตัวอักษรคิดจากความกว้างจริง เพื่อให้ทุกสัดส่วนอ่านออกเท่ากัน
  const headSize = Math.round(w / (fit(input.headline, 22).length > 12 ? 12 : 8.2));
  const subSize = Math.round(w / 24);
  const noteSize = Math.round(w / 30);
  const priceSize = Math.round(w / 9);

  let y = panelTop + pad + headSize * 0.82;
  const parts: string[] = [];

  if (fullBleed) {
    parts.push(`<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.bg}" stop-opacity="0"/>
      <stop offset="45%" stop-color="${p.bg}" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="${p.bg}" stop-opacity="0.94"/>
    </linearGradient></defs>`);
    parts.push(`<rect x="0" y="${panelTop}" width="${w}" height="${panelH}" fill="url(#scrim)"/>`);
  } else {
    parts.push(`<rect x="0" y="${panelTop}" width="${w}" height="${panelH}" fill="${p.bg}"/>`);
  }

  parts.push(`<text x="${pad}" y="${y}" font-family="Loma, Garuda, sans-serif"
    font-size="${headSize}" font-weight="700" fill="${p.ink}">${esc(fit(input.headline, 22))}</text>`);
  y += subSize * 1.7;

  if (input.subline) {
    parts.push(`<text x="${pad}" y="${y}" font-family="Garuda, sans-serif"
      font-size="${subSize}" fill="${p.ink}" opacity="0.88">${esc(fit(input.subline, 34))}</text>`);
    y += subSize * 1.5;
  }

  // ป้ายราคาเป็นบล็อกสีตัดกัน เพราะเป็นสิ่งที่คนมองหาก่อนเสมอ
  if (input.price) {
    const label = fit(input.price, 10);
    const boxW = Math.round(priceSize * (label.length * 0.62 + 0.7));
    const boxH = Math.round(priceSize * 1.34);
    const boxY = h - pad - boxH;
    parts.push(`<rect x="${pad}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${Math.round(boxH * 0.18)}" fill="${p.accent}"/>`);
    parts.push(`<text x="${pad + boxW / 2}" y="${boxY + boxH * 0.72}" text-anchor="middle"
      font-family="Loma, Garuda, sans-serif" font-size="${priceSize}" font-weight="700"
      fill="${p.accentInk}">${esc(label)}</text>`);

    if (input.oldPrice) {
      const oldX = pad + boxW + Math.round(pad * 0.5);
      const oldY = boxY + boxH * 0.62;
      const oldSize = Math.round(priceSize * 0.45);
      const oldW = Math.round(oldSize * fit(input.oldPrice, 10).length * 0.6);
      parts.push(`<text x="${oldX}" y="${oldY}" font-family="Garuda, sans-serif"
        font-size="${oldSize}" fill="${p.ink}" opacity="0.7">${esc(fit(input.oldPrice, 10))}</text>`);
      parts.push(`<line x1="${oldX - 4}" y1="${oldY - oldSize * 0.3}" x2="${oldX + oldW}"
        y2="${oldY - oldSize * 0.3}" stroke="${p.ink}" stroke-width="${Math.max(2, oldSize * 0.08)}"
        opacity="0.7"/>`);
    }
  }

  if (input.note) {
    parts.push(`<text x="${w - pad}" y="${h - pad - noteSize * 0.2}" text-anchor="end"
      font-family="Garuda, sans-serif" font-size="${noteSize}" fill="${p.ink}"
      opacity="0.8">${esc(fit(input.note, 30))}</text>`);
  }

  if (input.brand) {
    const by = input.note ? h - pad - noteSize * 1.9 : h - pad - noteSize * 0.2;
    parts.push(`<text x="${w - pad}" y="${by}" text-anchor="end"
      font-family="Loma, Garuda, sans-serif" font-size="${noteSize}" font-weight="700"
      fill="${p.accent}">${esc(fit(input.brand, 24))}</text>`);
  }

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

export type RenderResult = { assetId: string; url: string; width: number; height: number };

/**
 * ประกอบโปสเตอร์แล้วเก็บเป็น media_asset ใบใหม่
 * รูปสินค้าต้นฉบับไม่ถูกแตะ — โปสเตอร์เป็นไฟล์ใหม่เสมอ แก้ข้อความแล้วสร้างใหม่ได้ตลอด
 */
export async function renderPoster(args: {
  tenantId: string;
  templateId: string;
  aspect: PosterAspect;
  input: PosterInput;
  photoAssetId?: string | null;
}): Promise<RenderResult> {
  const t = getTemplate(args.templateId);
  const { w, h } = ASPECTS[args.aspect];
  const photoH = Math.round(h * Math.min(t.photoRatio, 1));
  const photoTop = t.photoPosition === 'top' ? 0 : h - photoH;

  const base = sharp({
    create: { width: w, height: h, channels: 3, background: t.palette.bg },
  });

  const layers: sharp.OverlayOptions[] = [];

  if (args.photoAssetId) {
    const asset = await one<{ storage_key: string }>(
      `SELECT storage_key FROM media_assets WHERE id = $1 AND tenant_id = $2`,
      [args.photoAssetId, args.tenantId],
    );
    if (!asset) throw new Error('ไม่พบรูปสินค้าที่เลือก');
    const photo = await sharp(await storage().get(asset.storage_key))
      .resize(w, photoH, { fit: 'cover', position: 'attention' })
      .toBuffer();
    layers.push({ input: photo, top: photoTop, left: 0 });
  }

  layers.push({ input: Buffer.from(textLayer(t, args.input, w, h)), top: 0, left: 0 });

  const out = await base.composite(layers).jpeg({ quality: 90 }).toBuffer();

  const key = randomKey('posters', '.jpg');
  const { url } = await storage().put(key, out, 'image/jpeg');
  const row = await one<{ id: string }>(
    `INSERT INTO media_assets
       (tenant_id, storage_key, public_url, mime_type, width, height, bytes, status, original_name)
     VALUES ($1,$2,$3,'image/jpeg',$4,$5,$6,'ready',$7) RETURNING id`,
    [args.tenantId, key, url, w, h, out.length, `โปสเตอร์-${t.name}.jpg`],
  );

  await query(
    `INSERT INTO poster_designs
       (tenant_id, asset_id, photo_asset_id, template_id, aspect_ratio, fields)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [args.tenantId, row!.id, args.photoAssetId ?? null, t.id, args.aspect,
     JSON.stringify(args.input)],
  );

  return { assetId: row!.id, url, width: w, height: h };
}

/** โปสเตอร์ที่เคยสร้าง — เปิดกลับมาแก้ข้อความแล้วสร้างใหม่ได้ */
export async function listPosters(tenantId: string, limit = 24) {
  return query<{
    id: string; asset_id: string; template_id: string; aspect_ratio: string;
    fields: PosterInput; url: string; created_at: Date;
  }>(
    `SELECT d.id, d.asset_id, d.template_id, d.aspect_ratio, d.fields,
            a.public_url AS url, d.created_at
       FROM poster_designs d
       JOIN media_assets a ON a.id = d.asset_id
      WHERE d.tenant_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
}
