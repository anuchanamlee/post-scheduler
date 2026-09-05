import sharp from 'sharp';
import { one, query } from '../lib/db.js';
import { env } from '../lib/env.js';
import { randomKey, storage } from '../lib/storage.js';
import { checkAiQuota, recordAiUsage } from './ai-usage.js';
import { ASPECTS, type Aspect } from './media.js';

/**
 * สร้างภาพด้วย AI
 *
 * ─── สองข้อที่โมเดลสร้างภาพทำไม่ได้ และระบบนี้แก้ให้แล้ว ───
 *
 * 1. **เขียนภาษาไทยไม่ถูก** — สระลอย วรรณยุกต์ผิดที่ ตัวอักษรที่ไม่มีจริง
 *    ทุก prompt ในไฟล์นี้จึงสั่งห้ามใส่ตัวหนังสือลงในภาพเสมอ (ดู NO_TEXT)
 *    ข้อความบนงานทุกชิ้นวาดทีหลังด้วยฟอนต์ไทยจริงใน poster.ts — คมทุกตัว แก้ทีหลังได้
 *    ผลพลอยได้: แก้ราคาผิดไม่ต้องสร้างภาพใหม่ = ไม่เสียเงินซ้ำ
 *
 * 2. **วาดสินค้าของร้านนั้นจริงๆ ไม่ได้** — โหมด replace-bg จึงมีไว้เพื่อการนี้
 *    ส่งรูปสินค้าจริงเข้าไปเป็นภาพอ้างอิง แล้วสั่งเปลี่ยนแค่ฉากหลัง
 *    สินค้ายังเป็นของร้าน ลูกค้าเห็นของจริงแล้วตรง — ต่างจากให้ AI วาดกาแฟขึ้นมาใหม่
 *
 * โหมด poster (ให้ AI ทำทั้งใบ) มีให้ใช้ตามที่เจ้าของสั่ง แต่ยังเป็นภาพเปล่าที่เอาไป
 * วางข้อความทับใน /poster เสมอ ไม่ใช่ใบที่ AI เขียนตัวหนังสือเอง
 */

export type ImageMode = 'scene' | 'illustration' | 'replace-bg' | 'poster';

export const MODES: Array<{ id: ImageMode; name: string; hint: string; needsRef: boolean }> = [
  { id: 'illustration', name: 'ภาพประกอบโพสต์', needsRef: false,
    hint: 'ภาพเปิดโพสต์ทั่วไป เช่น บรรยากาศร้าน วันหยุด ประกาศ' },
  { id: 'scene', name: 'ฉากพื้นหลัง', needsRef: false,
    hint: 'พื้นหลังโล่งๆ ไว้วางข้อความทับ เว้นที่ว่างให้ตัวหนังสือ' },
  { id: 'replace-bg', name: 'เปลี่ยนพื้นหลังรูปสินค้า', needsRef: true,
    hint: 'ใช้รูปสินค้าจริงของร้าน เปลี่ยนแค่ฉากหลัง — ตัวสินค้าไม่ถูกวาดใหม่' },
  { id: 'poster', name: 'โปสเตอร์ทั้งใบ', needsRef: false,
    hint: 'ให้ AI จัดองค์ประกอบทั้งใบ แล้วค่อยใส่ข้อความไทยเองที่หน้าทำโปสเตอร์' },
];

/**
 * คำสั่งที่ห้ามตัดออก
 *
 * โมเดลสร้างภาพชอบแถมตัวหนังสือมาเองแม้ไม่ได้ขอ และเป็นภาษาที่อ่านไม่ออก
 * ตัวอักษรมั่วบนโปสเตอร์ร้านค้า = ลูกค้าเห็นแล้วรู้ทันทีว่าเป็นของ AI
 */
const NO_TEXT =
  'ห้ามมีตัวหนังสือ ตัวอักษร ตัวเลข ลายเซ็น โลโก้ หรือลายน้ำใดๆ ในภาพเด็ดขาด '
  + '(no text, no letters, no numbers, no words, no watermark, no logo) '
  + 'ข้อความจะถูกใส่ทีหลังด้วยโปรแกรมแยก';

const MODE_PROMPT: Record<ImageMode, string> = {
  illustration:
    'สร้างภาพประกอบสำหรับโพสต์โซเชียลของร้านค้าไทย ดูเป็นภาพถ่ายจริง แสงธรรมชาติ สะอาดตา',
  scene:
    'สร้างภาพพื้นหลังสำหรับโปสเตอร์ — องค์ประกอบเบา ไม่รก '
    + 'และต้องเหลือพื้นที่โล่งพอที่จะวางข้อความขนาดใหญ่ทับได้',
  'replace-bg':
    'เก็บวัตถุหลักในภาพอ้างอิงไว้ให้เหมือนเดิมทุกอย่าง — รูปทรง สี พื้นผิว สัดส่วน ห้ามวาดใหม่ '
    + 'เปลี่ยนเฉพาะฉากหลังรอบตัวมันตามที่ขอ และจัดแสงให้เข้ากับฉากใหม่',
  poster:
    'สร้างภาพโปสเตอร์โฆษณาสำหรับร้านค้าไทย จัดองค์ประกอบให้มีพื้นที่ว่างชัดเจนหนึ่งฝั่ง '
    + 'สำหรับวางข้อความ',
};

/** OpenRouter รับอัตราส่วนเป็นชุดที่กำหนดไว้ — ที่ไม่ตรงเป๊ะให้ขอตัวใกล้สุดแล้วครอปเอง */
const ASPECT_REQUEST: Record<Aspect, string> = {
  '1:1': '1:1',
  '4:5': '3:4',
  '9:16': '9:16',
  '1.91:1': '16:9',
};

export type GeneratedImage = {
  assetId: string;
  url: string;
  width: number;
  height: number;
  model: string;
  costUsd: number;
  /** true เมื่อยังไม่ได้ตั้ง API key — ได้ภาพตัวอย่างในเครื่องแทน ไม่ใช่ผลจากโมเดลจริง */
  placeholder: boolean;
};

export function buildImagePrompt(mode: ImageMode, topic: string): string {
  return [MODE_PROMPT[mode], `สิ่งที่ต้องการ: ${topic}`, NO_TEXT].join('\n');
}

export async function generateImage(args: {
  tenantId: string;
  mode: ImageMode;
  topic: string;
  aspect: Aspect;
  /** รูปต้นทาง — บังคับสำหรับ replace-bg */
  refAssetId?: string | null;
  userId?: string | null;
}): Promise<GeneratedImage> {
  const topic = args.topic.trim();
  if (!topic) throw new Error('บอกก่อนว่าอยากได้ภาพแบบไหน');
  if (topic.length > 600) throw new Error('คำอธิบายภาพยาวเกินไป (เกิน 600 ตัวอักษร)');
  if (!MODES.some((m) => m.id === args.mode)) throw new Error(`ไม่รู้จักโหมด "${args.mode}"`);
  if (!ASPECTS[args.aspect]) throw new Error(`ไม่รู้จักสัดส่วน "${args.aspect}"`);

  const needsRef = MODES.find((m) => m.id === args.mode)!.needsRef;
  if (needsRef && !args.refAssetId) {
    throw new Error('โหมดเปลี่ยนพื้นหลังต้องเลือกรูปสินค้าต้นฉบับก่อน');
  }

  const quota = await checkAiQuota(args.tenantId, 'image');
  if (!quota.allowed) throw new Error(quota.reason ?? 'เกินโควตา AI');

  // รูปอ้างอิงต้องเป็นของ tenant นี้เท่านั้น — id เดาได้ ห้ามให้ดึงรูปร้านอื่นมาแก้
  let reference: { buffer: Buffer; mime: string } | null = null;
  if (args.refAssetId) {
    const ref = await one<{ storage_key: string; mime_type: string }>(
      `SELECT storage_key, mime_type FROM media_assets
        WHERE id = $1 AND tenant_id = $2 AND status = 'ready'`,
      [args.refAssetId, args.tenantId],
    );
    if (!ref) throw new Error('ไม่พบรูปต้นฉบับที่เลือก');
    reference = { buffer: await storage().get(ref.storage_key), mime: ref.mime_type };
  }

  const prompt = buildImagePrompt(args.mode, topic);
  const { w, h } = ASPECTS[args.aspect];

  const raw = env.ai.openRouterKey
    ? await callOpenRouterImages(prompt, args.aspect, reference)
    : await localPlaceholder(args.mode, w, h);

  // โมเดลคืนขนาดตามใจมันเสมอ — บังคับให้ตรงสัดส่วนที่ผู้ใช้เลือกก่อนเก็บ
  // ไม่งั้น IG ปฏิเสธตอนโพสต์ (สัดส่วนนอกช่วง 0.80–1.91) ทั้งที่หน้าเว็บบอกว่าได้แล้ว
  const out = await sharp(raw.bytes)
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 90 })
    .toBuffer();

  const key = randomKey('ai-images', '.jpg');
  const { url } = await storage().put(key, out, 'image/jpeg');

  const label = MODES.find((m) => m.id === args.mode)!.name;
  const asset = await one<{ id: string }>(
    `INSERT INTO media_assets
       (tenant_id, storage_key, public_url, mime_type, width, height, bytes, status, original_name)
     VALUES ($1,$2,$3,'image/jpeg',$4,$5,$6,'ready',$7) RETURNING id`,
    [args.tenantId, key, url, w, h, out.length, `AI-${label}.jpg`],
  );

  await query(
    `INSERT INTO ai_images
       (tenant_id, asset_id, mode, prompt, ref_asset_id, aspect_ratio, model, cost_usd, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [args.tenantId, asset!.id, args.mode, prompt, args.refAssetId ?? null,
     args.aspect, raw.model, raw.costUsd, args.userId ?? null],
  );

  // ภาพนับเป็นการใช้งาน 1 ครั้งเท่ากับแคปชั่น แต่ค่าใช้จ่ายจริงมาจาก usage.cost ของ OpenRouter
  await recordAiUsage(args.tenantId, raw.promptTokens, raw.completionTokens, raw.costUsd);

  return {
    assetId: asset!.id, url, width: w, height: h,
    model: raw.model, costUsd: raw.costUsd, placeholder: raw.placeholder,
  };
}

type RawImage = {
  bytes: Buffer;
  model: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  placeholder: boolean;
};

async function callOpenRouterImages(
  prompt: string,
  aspect: Aspect,
  reference: { buffer: Buffer; mime: string } | null,
): Promise<RawImage> {
  const body: Record<string, unknown> = {
    model: env.ai.imageModel,
    prompt,
    aspect_ratio: ASPECT_REQUEST[aspect],
    resolution: env.ai.imageResolution,
  };

  // ส่งเป็น data URL ไม่ใช่ลิงก์สาธารณะ — รูปสินค้าที่ยังไม่ถึงเวลาโพสต์ต้องไม่รั่ว
  // ผ่าน URL ที่ใครเดาได้ก็เปิดได้ (รายงานข้อ E4)
  if (reference) {
    body.input_references = [{
      type: 'image_url',
      image_url: { url: `data:${reference.mime};base64,${reference.buffer.toString('base64')}` },
    }];
  }

  const res = await fetch(`${env.ai.baseUrl}/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ai.openRouterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`สร้างภาพไม่สำเร็จ (HTTP ${res.status})${detail ? ` — ${detail}` : ''}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; media_type?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('ผู้ให้บริการไม่ได้ส่งภาพกลับมา');

  return {
    bytes: Buffer.from(b64, 'base64'),
    model: env.ai.imageModel,
    costUsd: json.usage?.cost ?? 0,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    placeholder: false,
  };
}

const PLACEHOLDER_TINT: Record<ImageMode, [string, string]> = {
  illustration: ['#2b3a67', '#6c7fd8'],
  scene: ['#1f3d2b', '#7fbf8f'],
  'replace-bg': ['#4a2b12', '#c98f4f'],
  poster: ['#4a123a', '#d06fae'],
};

/**
 * ไม่มี API key ก็ยังเดินได้ทั้งเส้นทาง — เก็บลงคลัง เอาไปทำโปสเตอร์ ตั้งเวลาโพสต์ได้จริง
 * ตั้งใจให้ดูออกทันทีว่าไม่ใช่ภาพจริง (ไล่สีเรียบ + แถบทแยง) จะได้ไม่มีใครเผลอส่งให้ลูกค้า
 */
async function localPlaceholder(mode: ImageMode, w: number, h: number): Promise<RawImage> {
  const [from, to] = PLACEHOLDER_TINT[mode];
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
      </linearGradient>
      <pattern id="s" width="56" height="56" patternTransform="rotate(35)"
               patternUnits="userSpaceOnUse">
        <rect width="28" height="56" fill="#ffffff" opacity="0.07"/>
      </pattern>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </svg>`;

  return {
    bytes: await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer(),
    model: 'local-placeholder',
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    placeholder: true,
  };
}

export type AiImageRow = {
  id: string;
  asset_id: string;
  url: string;
  mode: ImageMode;
  prompt: string;
  aspect_ratio: string;
  model: string;
  created_at: Date;
};

/** ภาพ AI ที่เคยสร้าง — กดกลับมาใช้ซ้ำได้ ไม่ต้องจ่ายเงินสร้างใหม่ */
export async function listAiImages(tenantId: string, limit = 12): Promise<AiImageRow[]> {
  return query<AiImageRow>(
    `SELECT i.id, i.asset_id, a.public_url AS url, i.mode, i.prompt,
            i.aspect_ratio, i.model, i.created_at
       FROM ai_images i
       JOIN media_assets a ON a.id = i.asset_id
      WHERE i.tenant_id = $1 AND a.status = 'ready'
      ORDER BY i.created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
}

/** รูปที่เอาไปเปลี่ยนพื้นหลังได้ — รูปที่ลูกค้าอัปโหลดเอง ไม่ใช่ของที่ AI สร้าง */
export async function listRefCandidates(tenantId: string, limit = 24) {
  return query<{ id: string; url: string; original_name: string | null }>(
    `SELECT a.id, a.public_url AS url, a.original_name
       FROM media_assets a
      WHERE a.tenant_id = $1 AND a.status = 'ready'
        AND NOT EXISTS (SELECT 1 FROM ai_images x WHERE x.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM poster_designs d WHERE d.asset_id = a.id)
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
}
