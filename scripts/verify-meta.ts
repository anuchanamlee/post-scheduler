/**
 * ตรวจว่าท่าเชื่อมต่อ Meta ที่วางแผนไว้ใช้ได้จริงไหม — ก่อนเขียนโค้ดที่พึ่งมัน
 *
 * ตอบคำถามที่ค้างมาตั้งแต่รายงานฉบับแรก (ข้อ A1):
 * "System User ของ Business Manager ลูกค้า นับเป็น role user ของแอปใน Development Mode ไหม"
 * — ไม่มีหน้าไหนของ Meta ตอบ ต้องยิงของจริงถึงจะรู้
 *
 * วิธีใช้
 *   1. สร้างแอป Business ใน Meta for Developers · อย่ากด Go Live
 *   2. สร้าง System User ใน Business Manager · assign เพจ · generate token (Never expire)
 *   3. รัน:
 *        docker compose exec web npx tsx scripts/verify-meta.ts --token "EAAG..." --page 1234567890
 *      เพิ่ม --post ถ้าอยากให้ทดสอบโพสต์จริงแล้วลบทิ้ง (ต้องมี --image ด้วย)
 *
 * สคริปต์นี้อ่านอย่างเดียวโดยค่าเริ่มต้น — ไม่โพสต์อะไรจนกว่าจะสั่ง --post
 * และไม่พิมพ์ token ลง log ไม่ว่ากรณีใด
 */

import crypto from 'node:crypto';

const GRAPH = process.env.META_GRAPH_BASE_URL ?? 'https://graph.facebook.com';
const VERSION = process.env.META_GRAPH_VERSION ?? 'v26.0';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const token = arg('token') ?? process.env.META_TEST_TOKEN ?? '';
const pageId = arg('page') ?? '';
const appSecret = arg('secret') ?? process.env.META_APP_SECRET ?? '';
const imageUrl = arg('image') ?? '';

if (!token) {
  console.error(`
ต้องมี token

  docker compose exec web npx tsx scripts/verify-meta.ts --token "EAAG..." --page <page-id>

ตัวเลือกเพิ่ม
  --secret <app-secret>   ใส่ appsecret_proof ไปด้วย (Meta บังคับกับบาง call)
  --post --image <url>    ทดสอบโพสต์จริงแล้วลบทิ้ง (รูปต้องเป็น URL สาธารณะ)
`);
  process.exit(1);
}

const proof = appSecret
  ? crypto.createHmac('sha256', appSecret).update(token).digest('hex')
  : undefined;

type Result = { ok: boolean; label: string; detail: string };
const results: Result[] = [];

function say(ok: boolean, label: string, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'ผ่าน  ' : 'ไม่ผ่าน'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function graph<T>(path: string, params: Record<string, string> = {}, method = 'GET') {
  const url = new URL(`${GRAPH}/${VERSION}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (method === 'POST') body.set(k, v);
    else url.searchParams.set(k, v);
  }
  if (proof) {
    if (method === 'POST') body.set('appsecret_proof', proof);
    else url.searchParams.set('appsecret_proof', proof);
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, body: json as T };
}

/** ข้อความ error ของ Meta มักบอกสาเหตุตรงๆ พอที่จะตัดสินใจได้ */
function errText(body: unknown): string {
  const e = (body as { error?: { message?: string; code?: number; error_subcode?: number } })?.error;
  if (!e) return JSON.stringify(body).slice(0, 160);
  return `[${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}] ${e.message}`;
}

async function main() {
  console.log(`\n── ตรวจการเชื่อมต่อ Meta (${VERSION}) ──\n`);

  // 1 · token ใช้ได้ไหม และเป็น token ชนิดอะไร
  const me = await graph<{ id?: string; name?: string }>('me', { fields: 'id,name' });
  say(me.ok, 'token ใช้งานได้', me.ok ? `ตัวตน ${me.body.name ?? me.body.id}` : errText(me.body));
  if (!me.ok) {
    console.log('\ntoken ใช้ไม่ได้ตั้งแต่ต้น — ตรวจว่าคัดลอกครบและยังไม่ถูกเพิกถอน\n');
    process.exit(1);
  }

  // 2 · debug_token บอกความจริงที่สุด: ชนิด token, แอปที่ผูก, scope ที่มีจริง, วันหมดอายุ
  if (appSecret) {
    const dbg = await graph<{
      data?: {
        type?: string; app_id?: string; expires_at?: number; is_valid?: boolean;
        scopes?: string[]; granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
      };
    }>('debug_token', { input_token: token, access_token: `${arg('appid') ?? ''}|${appSecret}` });

    const d = dbg.body?.data;
    if (dbg.ok && d) {
      say(Boolean(d.is_valid), 'debug_token ยืนยันว่า token ยังใช้ได้',
          `ชนิด ${d.type ?? 'ไม่ระบุ'} · แอป ${d.app_id ?? 'ไม่ระบุ'}`);
      say(d.expires_at === 0 || d.expires_at === undefined,
          'token ไม่มีวันหมดอายุ',
          d.expires_at ? `หมดอายุ ${new Date(d.expires_at * 1000).toLocaleString('th-TH')}`
                       : 'ไม่มีวันหมดอายุ (ตามที่ตั้งใจ)');

      const scopes = d.scopes ?? d.granular_scopes?.map((g) => g.scope) ?? [];
      console.log(`      scope ที่มีจริง: ${scopes.join(', ') || 'ไม่ทราบ'}`);

      // ยืนยันชื่อ scope ที่รายงานข้อ A5 ยังไม่ได้ตอบ
      const igPublish = scopes.filter((x) => x.includes('content_publish'));
      say(igPublish.length > 0, 'มี scope สำหรับโพสต์ Instagram',
          igPublish.join(', ') || 'ไม่มีเลย — โพสต์ IG ไม่ได้');
      for (const need of ['pages_manage_posts', 'pages_read_engagement', 'business_management']) {
        say(scopes.includes(need), `มี scope ${need}`);
      }
    } else {
      say(false, 'เรียก debug_token ไม่ได้', errText(dbg.body)
        + ' (ต้องใส่ --appid ด้วยถ้าจะให้ตรวจส่วนนี้)');
    }
  } else {
    console.log('      ข้าม debug_token — ไม่ได้ใส่ --secret');
  }

  // 3 · เห็นเพจไหม — ข้อนี้คือคำตอบของ A1 โดยตรง
  const accounts = await graph<{ data?: Array<{ id: string; name: string }> }>(
    'me/accounts', { fields: 'id,name', limit: '50' });
  const pages = accounts.body?.data ?? [];
  say(accounts.ok && pages.length > 0, 'มองเห็นเพจที่ถูก assign',
      accounts.ok ? `${pages.length} เพจ: ${pages.map((p) => p.name).join(', ').slice(0, 80)}`
                  : errText(accounts.body));

  const target = pageId || pages[0]?.id;
  if (!target) {
    console.log('\nไม่มีเพจให้ทดสอบต่อ — assign เพจให้ System User ก่อน\n');
    summary();
    return;
  }

  // 4 · อ่านข้อมูลเพจได้ไหม (permission ระดับอ่าน)
  const page = await graph<{ id?: string; name?: string; instagram_business_account?: { id: string } }>(
    target, { fields: 'id,name,instagram_business_account' });
  say(page.ok, 'อ่านข้อมูลเพจได้', page.ok ? (page.body.name ?? target) : errText(page.body));

  const igId = page.body?.instagram_business_account?.id;
  say(Boolean(igId), 'เพจผูกกับบัญชี Instagram Professional แล้ว',
      igId ?? 'ไม่พบ — ต้องเชื่อม IG กับเพจก่อนถึงจะโพสต์ IG ได้');

  // 5 · โควตา IG ที่เหลือจริง (ยืนยันเลข 100 ที่รายงานข้อ A4 บอกไว้)
  if (igId) {
    const limit = await graph<{ data?: Array<{ quota_usage: number; config?: { quota_total?: number } }> }>(
      `${igId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    if (limit.ok && limit.body.data?.[0]) {
      const q = limit.body.data[0];
      say(true, 'อ่านโควตาการโพสต์ของ Instagram ได้',
          `ใช้ไป ${q.quota_usage} จากเพดาน ${q.config?.quota_total ?? '(ไม่ระบุ)'}`);
    } else {
      say(false, 'อ่านโควตา Instagram ไม่ได้', errText(limit.body));
    }
  }

  // 6 · ทดสอบโพสต์จริง — ทำเมื่อสั่งเท่านั้น เพราะมันขึ้นเพจจริง
  if (has('post')) {
    if (!imageUrl) {
      say(false, 'ทดสอบโพสต์', 'ต้องใส่ --image <url สาธารณะ> ด้วย');
    } else {
      console.log('\n── ทดสอบโพสต์จริงแล้วลบทิ้ง ──\n');
      const created = await graph<{ id?: string; post_id?: string }>(
        `${target}/photos`,
        { url: imageUrl, caption: 'ทดสอบระบบ — จะถูกลบทันที', published: 'true' },
        'POST',
      );
      const postId = created.body?.post_id ?? created.body?.id;
      say(created.ok, 'โพสต์ขึ้นเพจ Facebook ได้จริง',
          created.ok ? `id ${postId}` : errText(created.body));

      if (created.ok && postId) {
        const del = await graph(postId, {}, 'DELETE');
        say(del.ok, 'ลบโพสต์ทดสอบออกแล้ว', del.ok ? '' : errText(del.body));
      }
    }
  } else {
    console.log('\n      (ยังไม่ทดสอบโพสต์จริง — เพิ่ม --post --image <url> ถ้าต้องการ)');
  }

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── สรุป ──`);

  const sawPages = results.find((r) => r.label.includes('มองเห็นเพจ'))?.ok;
  const canRead = results.find((r) => r.label.includes('อ่านข้อมูลเพจ'))?.ok;
  const didPost = results.find((r) => r.label.includes('โพสต์ขึ้นเพจ'));

  if (sawPages && canRead) {
    console.log(`
System User token ตัวนี้มองเห็นและอ่านเพจได้ — แปลว่าท่าที่วางไว้ในรายงานข้อ A1
ใช้ได้จริงโดยไม่ต้องมีคนถือ role บนแอป`);
    if (didPost?.ok) {
      console.log('และโพสต์ขึ้นเพจได้จริงด้วย — ตัดขั้นที่ 3 ของ runbook (ให้ลูกค้าถือ role) ทิ้งได้');
    } else if (!didPost) {
      console.log('แต่ยังไม่ได้พิสูจน์การโพสต์ — รันซ้ำด้วย --post --image <url> เพื่อยืนยันให้จบ');
    }
  } else {
    console.log(`
token มองไม่เห็นเพจ — ท่า System User อย่างเดียวใช้ไม่ได้
ให้ใช้ runbook ตามที่เขียนไว้: เพิ่มบัญชี Facebook ของลูกค้าเป็น role บนแอปก่อน
(docs/onboarding-runbook.md ขั้นที่ 3)`);
  }

  console.log(`\nผ่าน ${results.length - failed.length}/${results.length} ข้อ`);
  if (failed.length) {
    console.log('ที่ไม่ผ่าน:');
    for (const f of failed) console.log(`  · ${f.label} — ${f.detail}`);
  }
  console.log();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nสคริปต์ล้มเหลว:', (err as Error).message);
  process.exit(1);
});
