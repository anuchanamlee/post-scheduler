import sharp from 'sharp';
import { pool, one, query } from '../src/lib/db.js';
import { hashPassword, seal } from '../src/lib/crypto.js';
import { ingestImage, makeVariant } from '../src/content/media.js';
import { env } from '../src/lib/env.js';

/**
 * ข้อมูลตั้งต้นสำหรับลองใช้งาน — ลูกค้าตัวอย่าง 1 ราย, เพจ FB + IG, brand voice,
 * รูปจริง 1 ใบ (สร้างด้วย sharp ไม่ต้องดาวน์โหลดจากไหน) และโพสต์ในคิว 3 ชิ้น
 */

async function main() {
  const existing = await one<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  if (existing) {
    console.log('[seed] มีข้อมูลอยู่แล้ว ข้าม');
    await pool.end();
    return;
  }

  const tenant = await one<{ id: string }>(
    `INSERT INTO tenants (name, timezone) VALUES ('ร้านตัวอย่าง', 'Asia/Bangkok') RETURNING id`,
  );
  const tenantId = tenant!.id;

  await query(`INSERT INTO tenant_limits (tenant_id) VALUES ($1)`, [tenantId]);

  const user = await one<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1, 'owner@example.com', $2, 'owner') RETURNING id`,
    [tenantId, hashPassword('demo1234')],
  );

  const provider = env.defaultProvider;
  const fb = await one<{ id: string }>(
    `INSERT INTO social_pages (tenant_id, platform, provider, remote_id, display_name, timezone)
     VALUES ($1,'facebook',$2,'1234567890','เพจร้านตัวอย่าง','Asia/Bangkok') RETURNING id`,
    [tenantId, provider],
  );
  const ig = await one<{ id: string }>(
    `INSERT INTO social_pages (tenant_id, platform, provider, remote_id, display_name, timezone)
     VALUES ($1,'instagram',$2,'17841400000000000','@example.shop','Asia/Bangkok') RETURNING id`,
    [tenantId, provider],
  );

  // credential ตัวอย่าง — เข้ารหัสจริงด้วย AES-256-GCM
  const sealed = seal('DEMO_SYSTEM_USER_TOKEN_ไม่ใช่ของจริง');
  const cred = await one<{ id: string }>(
    `INSERT INTO meta_credentials
       (tenant_id, label, token_ciphertext, token_iv, token_auth_tag, key_version, status)
     VALUES ($1,'system-user (demo)',$2,$3,$4,$5,'healthy') RETURNING id`,
    [tenantId, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
  await query(
    `INSERT INTO page_credentials (page_id, credential_id) VALUES ($1,$3),($2,$3)`,
    [fb!.id, ig!.id, cred!.id],
  );

  // brand voice ผูกกับเพจ ไม่ใช่กับลูกค้า (รายงานข้อ C5) — FB กับ IG คนละโทน
  await query(
    `INSERT INTO brand_voice_profiles (tenant_id, page_id, tone_description, example_captions, keywords_include, keywords_avoid)
     VALUES ($1,$2,'เป็นกันเอง สุภาพ ใช้คำว่า "ค่ะ" ลงท้าย ไม่ขายตรงจนเกินไป',
             ARRAY['ของใหม่เข้าแล้วค่ะ ใครรอรุ่นนี้อยู่ทักมาได้เลยนะคะ','อากาศร้อนแบบนี้ ร้านมีของเย็นๆ รอค่ะ'],
             ARRAY['จัดส่งฟรี'], ARRAY['ถูกที่สุดในโลก','การันตี 100%'])`,
    [tenantId, fb!.id],
  );
  await query(
    `INSERT INTO brand_voice_profiles (tenant_id, page_id, tone_description, example_captions, keywords_include, keywords_avoid)
     VALUES ($1,$2,'สั้น กระชับ ใช้อิโมจิได้ เน้นภาพเป็นหลัก',
             ARRAY['ใหม่ ✨','วันนี้ที่ร้าน ☕'], ARRAY[]::text[], ARRAY['สั่งด่วน'])`,
    [tenantId, ig!.id],
  );

  // รูปตัวอย่าง — สร้างเองด้วย sharp
  const buffer = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 47, g: 58, b: 120 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="1600" height="1200"><rect width="1600" height="1200" fill="#2f3a78"/>
           <circle cx="1200" cy="300" r="220" fill="#6f7ae8" opacity="0.6"/>
           <text x="120" y="640" font-family="sans-serif" font-size="96" fill="#ffffff">DEMO</text>
           <text x="120" y="760" font-family="sans-serif" font-size="52" fill="#c8cdf5">รูปตัวอย่างของระบบ</text></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();

  const asset = await ingestImage({
    tenantId,
    buffer,
    mimeType: 'image/jpeg',
    originalName: 'demo.jpg',
  });
  await makeVariant({ tenantId, assetId: asset.id, aspect: '1:1' });
  await makeVariant({ tenantId, assetId: asset.id, aspect: '4:5' });

  const now = Date.now();
  const posts: Array<{ caption: string; at: Date; pages: string[] }> = [
    {
      caption: 'โปรโมชั่นเดือนนี้ ลด 20% ทุกชิ้นค่ะ จัดส่งฟรีเมื่อครบ 500 บาท',
      at: new Date(now - 60_000), // ถึงเวลาแล้ว worker หยิบได้เลย
      pages: [fb!.id, ig!.id],
    },
    {
      caption: 'ของใหม่เข้าร้านแล้วค่ะ ทักแชทถามได้เลยนะคะ',
      at: new Date(now - 30_000),
      pages: [fb!.id, ig!.id],
    },
    {
      caption: 'โพสต์ที่ยังไม่ถึงเวลา — แก้ไขหรือยกเลิกได้จากหน้าคิว',
      at: new Date(now + 6 * 3600_000),
      pages: [fb!.id],
    },
  ];

  for (const p of posts) {
    const post = await one<{ id: string }>(
      `INSERT INTO scheduled_posts (tenant_id, caption, asset_id, scheduled_at, status, created_by)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`,
      [tenantId, p.caption, asset.id, p.at, user!.id],
    );
    // post_media คือแหล่งข้อมูลรูปที่ตัวส่งโพสต์อ่านจริง (migration 0004)
    // ไม่ใส่ = โพสต์ล้มด้วย "รูปยังไม่พร้อมใช้งาน" ทันทีที่ worker หยิบ
    // (asset_id บน scheduled_posts เป็นคอลัมน์เดิมสมัยรูปเดียว เก็บไว้เพื่อความเข้ากันได้)
    await query(
      `INSERT INTO post_media (tenant_id, post_id, asset_id, position) VALUES ($1,$2,$3,0)`,
      [tenantId, post!.id, asset.id],
    );
    await query(
      `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
       SELECT $1,$2,sp.id,sp.platform FROM social_pages sp WHERE sp.id = ANY($3::uuid[])`,
      [tenantId, post!.id, p.pages],
    );
  }

  console.log('[seed] เรียบร้อย — เข้าใช้งานด้วย owner@example.com / demo1234');
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] ล้มเหลว:', err);
  process.exit(1);
});
