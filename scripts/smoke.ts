import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, one, query } from '../src/lib/db.js';
import { runPublishCycle } from '../src/core/publisher.js';
import { rollupPostStatus } from '../src/core/queue.js';
import { addSlot, listSlots, nextFreeSlots } from '../src/core/slots.js';
import { TEMPLATES, listPosters, renderPoster } from '../src/content/poster.js';
import {
  MODES, buildImagePrompt, generateImage, listAiImages, listRefCandidates,
} from '../src/content/image.js';
import { generateCaptions } from '../src/content/caption.js';
import {
  addChannel, listChannels, pushPendingNotifications, sendTest,
} from '../src/core/notify.js';
import { instagramQuota, isQuotaLow } from '../src/core/quota.js';
import { randomKey, resetStorage, storage } from '../src/lib/storage.js';
import {
  approve, canApprove, countAwaiting, needsApproval, reject, removeUser,
  setApprovalRequired, setRole, submitForApproval,
} from '../src/core/approval.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { changePassword } from '../src/core/account.js';
import {
  configProblems, probeConfig, readinessReport, readinessBlockers,
} from '../src/core/config.js';
import { signIn } from '../src/lib/auth.js';
import { deleteAsset, libraryCounts, listLibrary } from '../src/content/library.js';
import { cropRect, ingestImage } from '../src/content/media.js';
import { growthReport, runRetention, shouldRunRetention } from '../src/core/retention.js';
import { BUCKETS, bestTimes, collectDue, listInsights } from '../src/core/metrics.js';
import {
  connectPage, disconnectPage, replaceToken, verifyConnection,
} from '../src/core/connections.js';
import {
  appendTags, countTags, listSets, normalizeTags, removeSet, saveSet,
} from '../src/content/hashtags.js';
import { env } from '../src/lib/env.js';
import type { MockPost } from '../src/providers/mock.js';
import { makeVariant, validateForInstagram } from '../src/content/media.js';
import {
  cancelPost, createPost, duplicatePost, getPost, movePostToDay, postsInRange,
  publishDraft, updatePost,
} from '../src/core/scheduler.js';
import { consumeReset, requestReset, resetTokenValid } from '../src/core/reset.js';
import { sendMail } from '../src/lib/mail.js';

/**
 * ทดสอบพฤติกรรมที่ทำให้ระบบจริงพัง แล้วรายงานผลเป็น exit code
 *
 *   npm run smoke   (ในคอนเทนเนอร์: docker compose exec web npm run smoke)
 */

let failures = 0;

/** ทุกรอบทดสอบมี id ของตัวเอง — ฟีดจำลองสะสมข้ามรอบ ถ้าไม่แยกจะนับของรอบก่อนมาด้วย */
const RUN = Math.random().toString(36).slice(2, 8);

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ผ่าน  ' : 'ไม่ผ่าน'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** รูปเล็กๆ สำหรับทดสอบ ไม่ต้องพึ่งไฟล์ภายนอก */
/** ของที่ "ต้องพัง" ถ้าไม่พังคือช่องโหว่ — เช็คว่าโยน error จริง ไม่ใช่ผ่านเงียบๆ */
async function badPath(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, 'ไม่โยน error');
  } catch {
    check(name, true);
  }
}

async function sharpTestImage(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width: 900, height: 900, channels: 3, background: { r: 40, g: 80, b: 140 } },
  }).jpeg().toBuffer();
}

async function readSent(): Promise<Array<{ destination: string; text: string }>> {
  try {
    return JSON.parse(await fs.readFile(path.join(env.storageDir, 'sent-messages.json'), 'utf8'));
  } catch {
    return [];
  }
}

async function readMail(): Promise<Array<{ to: string; subject: string; text: string }>> {
  try {
    return JSON.parse(await fs.readFile(path.join(env.storageDir, 'sent-mail.json'), 'utf8'));
  } catch {
    return [];
  }
}

function tokenFrom(mailText: string): string {
  const line = mailText.split('\n').find((l) => l.includes('/reset/')) ?? '';
  return line.trim().split('/reset/')[1] ?? '';
}

/**
 * เซิร์ฟเวอร์ SMTP จำลอง — พูดตามโปรโตคอลจริงพอให้ client เดินจนจบ
 * แล้วเก็บทุกไบต์ที่ได้รับไว้ให้ตรวจ
 *
 * มีเพราะ transport แบบ mock พิสูจน์ได้แค่ว่าเราเรียกฟังก์ชันส่ง
 * ไม่ได้พิสูจน์ว่าสิ่งที่ส่งออกไปเป็น SMTP ที่ปลายทางอ่านรู้เรื่อง
 */
async function fakeSmtp() {
  const net = await import('node:net');
  let transcript = '';
  const server = net.createServer((sock) => {
    let inData = false;
    // 0 = ยังไม่เริ่ม · 1 = รอชื่อผู้ใช้ · 2 = รอรหัส — นับสถานะตรงๆ
    // เดาจากสิ่งที่ไคลเอนต์ส่งมาไม่ได้ ทั้งสองบรรทัดหน้าตาเหมือนกัน (base64 เปล่าๆ)
    let authStep = 0;
    sock.setEncoding('utf8');
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      transcript += chunk;
      for (const line of chunk.split('\r\n')) {
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 OK\r\n'); }
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (/^MAIL FROM/i.test(line)) sock.write('250 OK\r\n');
        else if (/^RCPT TO/i.test(line)) sock.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go ahead\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) { authStep = 3; sock.write('235 OK\r\n'); }
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    transcript: () => transcript,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function readFeed(): Promise<MockPost[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(env.storageDir, 'mock-feed.json'), 'utf8'));
  } catch {
    return [];
  }
}

async function makePost(caption: string, platforms: string[], images = 1) {
  const t = await one<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  const a = await one<{ id: string }>(`SELECT id FROM media_assets WHERE status='ready' LIMIT 1`);
  const p = await one<{ id: string }>(
    `INSERT INTO scheduled_posts (tenant_id, caption, asset_id, scheduled_at, status)
     VALUES ($1,$2,$3, now() - interval '1 minute', 'pending') RETURNING id`,
    [t!.id, caption, a!.id],
  );
  // รูปชุดเดียวกันซ้ำหลายใบก็พอสำหรับทดสอบเส้นทาง carousel
  for (let i = 0; i < images; i++) {
    await query(
      `INSERT INTO post_media (tenant_id, post_id, asset_id, position) VALUES ($1,$2,$3,$4)`,
      [t!.id, p!.id, a!.id, i],
    );
  }
  await query(
    `INSERT INTO post_targets (tenant_id, post_id, page_id, platform)
     SELECT $1,$2,sp.id,sp.platform FROM social_pages sp
      WHERE sp.tenant_id = $1 AND sp.platform::text = ANY($3::text[])`,
    [t!.id, p!.id, platforms],
  );
  return p!.id;
}

async function main() {
  console.log('── ทดสอบพฤติกรรมของคิว ──\n');

  // โพสต์ตัวอย่างจาก seed ที่ถึงเวลาแล้วต้องถูกส่งออกไปก่อน
  // ไม่งั้นรอบแรกของ D2 จะส่งโพสต์พวกนั้นไปด้วย แล้วนับจำนวนบนฟีดเกิน
  await runPublishCycle('smoke-drain');

  // D2 — publish สำเร็จแต่คำตอบหาย: retry ต้องไม่โพสต์ซ้ำ
  const before = (await readFeed()).length;
  const timeoutPost = await makePost(`ทดสอบคำตอบหาย ${RUN} #timeout`, ['facebook']);

  await runPublishCycle('smoke-1');           // รอบแรก: ปลายทางรับไปแล้ว แต่เราไม่ได้คำตอบ
  const afterFirst = await one<{ status: string; attempt_count: number }>(
    `SELECT status::text, attempt_count FROM post_targets WHERE post_id = $1`,
    [timeoutPost],
  );
  check(
    'D2 รอบแรก: ปลายทาง timeout แล้วถูกตั้งให้ลองใหม่ ไม่ถูก mark สำเร็จลอยๆ',
    afterFirst?.status === 'pending',
    `สถานะ=${afterFirst?.status}`,
  );

  await query(`UPDATE post_targets SET next_attempt_at = now() WHERE post_id = $1`, [timeoutPost]);
  await runPublishCycle('smoke-2');           // รอบสอง: ต้องเจอของเดิม ไม่โพสต์ใหม่

  const afterSecond = await one<{ status: string }>(
    `SELECT status::text FROM post_targets WHERE post_id = $1`,
    [timeoutPost],
  );
  const feed = await readFeed();
  const dupes = feed.filter((f) => f.caption.includes(`${RUN} #timeout`)).length;

  check('D2 รอบสอง: จบเป็นสำเร็จ', afterSecond?.status === 'posted', `สถานะ=${afterSecond?.status}`);
  check('D2 ไม่มีโพสต์ซ้ำบนปลายทาง', dupes === 1, `พบ ${dupes} รายการ (ต้องได้ 1)`);
  check('D2 จำนวนโพสต์บนฟีดเพิ่มขึ้นแค่ 1', feed.length === before + 1, `${before} → ${feed.length}`);

  // C1/D3 — โพสต์ครึ่งเดียวต้องอ่านออกว่าเป็น partial
  const partialPost = await makePost(`ทดสอบขึ้นไม่ครบ ${RUN} #failig`, ['facebook', 'instagram']);
  await runPublishCycle('smoke-3');
  const rolled = await one<{ status: string }>(
    `SELECT status::text FROM scheduled_posts WHERE id = $1`,
    [partialPost],
  );
  check('C1/D3 FB สำเร็จ + IG ล้ม = partial', rolled?.status === 'partial', `สถานะ=${rolled?.status}`);

  const notified = await one<{ n: string }>(
    `SELECT count(*) AS n FROM notifications WHERE post_id = $1 AND level = 'critical'`,
    [partialPost],
  );
  check('D3 มีแจ้งเตือนให้คนตัดสินใจ', Number(notified?.n) === 1);

  // C2 — งานเดียวกันถูกหยิบซ้ำไม่ได้
  const racePost = await makePost(`ทดสอบกันหยิบซ้ำ ${RUN}`, ['facebook']);
  const [a, b] = await Promise.all([runPublishCycle('race-a'), runPublishCycle('race-b')]);
  const raceFeed = (await readFeed()).filter((f) => f.caption.includes(`ทดสอบกันหยิบซ้ำ ${RUN}`)).length;
  check(
    'C2 worker สองตัวพร้อมกัน ไม่โพสต์ซ้ำ',
    raceFeed === 1,
    `หยิบได้ ${a.claimed}+${b.claimed} ครั้ง แต่ขึ้นจริง ${raceFeed} โพสต์`,
  );
  void racePost;

  // D10 — เลย grace window แล้วต้องไม่โพสต์ย้อนหลังเอง
  const oldPost = await makePost(`ทดสอบเลยเวลา ${RUN}`, ['facebook']);
  await query(
    `UPDATE scheduled_posts SET scheduled_at = now() - interval '10 hours' WHERE id = $1`,
    [oldPost],
  );
  await runPublishCycle('smoke-4');
  const missed = await one<{ status: string }>(
    `SELECT status::text FROM scheduled_posts WHERE id = $1`,
    [oldPost],
  );
  check('D10 โพสต์ที่เลยเวลานานถูก mark missed ไม่แอบโพสต์ย้อนหลัง',
    missed?.status === 'missed', `สถานะ=${missed?.status}`);

  // C3/D7 — ครอปแล้วต้นฉบับต้องไม่ถูกแตะ และต้องมีข้อความไทยทับได้
  const asset = await one<{ id: string; width: number; height: number; bytes: string }>(
    `SELECT id, width, height, bytes FROM media_assets LIMIT 1`,
  );
  const tenant = await one<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  const before1x1 = await one<{ public_url: string }>(
    `SELECT public_url FROM media_variants WHERE asset_id = $1 AND aspect_ratio = '1:1'`,
    [asset!.id],
  );
  const v = await makeVariant({
    tenantId: tenant!.id,
    assetId: asset!.id,
    aspect: '9:16',
    overlay: { text: 'ลด 20% ทุกชิ้น', position: 'bottom' },
  });
  check('C3 ครอปเป็น 9:16 ได้', v.width === 1080 && v.height === 1920, `${v.width}x${v.height}`);
  check(
    'C3 overlay ภาษาไทยเรนเดอร์จริง (ไฟล์ใหญ่ขึ้นกว่ารูปเปล่า)',
    v.bytes > 20_000,
    `${Math.round(v.bytes / 1024)} KB`,
  );

  const origAfter = await one<{ width: number; height: number }>(
    `SELECT width, height FROM media_assets WHERE id = $1`,
    [asset!.id],
  );
  check(
    'C3 ต้นฉบับไม่ถูกเขียนทับ — re-crop สัดส่วนอื่นได้ตลอด',
    origAfter?.width === asset!.width && origAfter?.height === asset!.height,
    `${origAfter?.width}x${origAfter?.height}`,
  );
  check('C3 variant เดิมยังอยู่', !!before1x1?.public_url);

  const igProblems = validateForInstagram(asset!.width, asset!.height, Number(asset!.bytes));
  check(
    'D7 ตรวจสัดส่วนของ IG ฝั่งเราได้ ไม่ต้องรอ Meta ปฏิเสธ',
    Array.isArray(igProblems),
    igProblems.length ? igProblems[0] : 'รูปนี้ผ่านเกณฑ์',
  );

  // ── สิ่งที่เจ้าของร้านต้องทำได้จริง ────────────────────────────
  const tid = (await one<{ id: string }>(`SELECT id FROM tenants LIMIT 1`))!.id;

  // แก้โพสต์ที่ยังไม่ออก: พิมพ์ผิดต้องแก้ได้ ไม่ใช่ลบแล้วทำใหม่
  const editable = await makePost(`ก่อนแก้ ${RUN}`, ['facebook']);
  await query(`UPDATE scheduled_posts SET scheduled_at = now() + interval '2 days' WHERE id = $1`,
              [editable]);
  const later = new Date(Date.now() + 3 * 86400_000);
  await updatePost(tid, editable, { caption: `หลังแก้ ${RUN}`, scheduledAt: later });
  const edited = await getPost(tid, editable);
  check('แก้แคปชั่นของโพสต์ที่ยังไม่ออกได้', edited?.caption === `หลังแก้ ${RUN}`);
  check('เลื่อนเวลาได้', Math.abs(new Date(edited!.scheduled_at).getTime() - later.getTime()) < 2000);

  // เปลี่ยนปลายทางได้ตราบใดที่ยังไม่มีอันไหนส่งออก
  const bothPages = await query<{ id: string }>(
    `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active`, [tid]);
  await updatePost(tid, editable, { pageIds: bothPages.map((p) => p.id) });
  const after = await getPost(tid, editable);
  check('เพิ่มปลายทางทีหลังได้', after!.page_ids.length === bothPages.length,
        `${after!.page_ids.length} ปลายทาง`);

  // โพสต์ที่ส่งออกไปแล้วต้องแก้ไม่ได้ ไม่ใช่แก้แล้วเพี้ยนเงียบๆ
  const posted = await one<{ id: string }>(
    `SELECT id FROM scheduled_posts WHERE status = 'posted' LIMIT 1`);
  let refused = false;
  try { await updatePost(tid, posted!.id, { caption: 'ห้ามแก้' }); }
  catch { refused = true; }
  check('โพสต์ที่ออกไปแล้วแก้ไม่ได้', refused);

  // ทำซ้ำโพสต์ประจำ: ได้สำเนาเป็นร่าง พร้อมปลายทางเดิม ใช้รูปใบเดิม
  const copy = await duplicatePost(tid, editable, new Date(Date.now() + 86400_000));
  const copied = await getPost(tid, copy.id);
  check('ทำซ้ำได้ และสำเนาเป็นร่าง', copied?.status === 'draft', `สถานะ=${copied?.status}`);
  check('สำเนาใช้รูปใบเดิม ไม่อัปโหลดซ้ำ', copied?.asset_id === after?.asset_id);
  check('สำเนาได้ปลายทางเดิมมาด้วย', copied?.page_ids.length === after?.page_ids.length);
  check('สำเนาได้รูปครบทั้งชุด', copied?.media.length === after?.media.length,
        `${copied?.media.length} ใบ`);

  // ร่างต้องไม่ถูกส่งจนกว่าคนจะกดเข้าคิว
  await runPublishCycle('draft-guard');
  const stillDraft = await getPost(tid, copy.id);
  check('ร่างไม่ถูกส่งออกเองโดยไม่ได้สั่ง', stillDraft?.status === 'draft',
        `สถานะ=${stillDraft?.status}`);
  await publishDraft(tid, copy.id);
  check('กดเข้าคิวแล้วสถานะเปลี่ยนเป็นรอโพสต์',
        (await getPost(tid, copy.id))?.status === 'pending');

  await cancelPost(tid, copy.id);
  await cancelPost(tid, editable);

  // ── การแจ้งเตือนต้องครอบคลุมทุกเรื่องที่คนต้องรู้ ────────────
  // โพสต์ที่ล้มทุกช่องทางเคยเงียบสนิท เพราะเตือนเฉพาะเคส partial
  const deadPost = await makePost(`ทดสอบล้มหมด ${RUN} #failall`, ['facebook']);
  for (let i = 0; i < 6; i++) {
    await query(`UPDATE post_targets SET next_attempt_at = NULL WHERE post_id = $1`, [deadPost]);
    await runPublishCycle('fail-all');
  }
  const dead = await one<{ status: string }>(
    `SELECT status::text FROM scheduled_posts WHERE id = $1`, [deadPost]);
  check('โพสต์ที่ล้มทุกช่องทางจบเป็นสถานะ failed', dead?.status === 'failed',
        `สถานะ=${dead?.status}`);

  const deadAlert = await one<{ n: string; title: string }>(
    `SELECT count(*)::text AS n, min(title) AS title FROM notifications WHERE post_id = $1`,
    [deadPost]);
  check('ล้มทุกช่องทางแล้วมีแจ้งเตือน', Number(deadAlert?.n) >= 1, deadAlert?.title ?? 'ไม่มี');

  // อ่านแล้วเกิดซ้ำ ต้องเตือนใหม่ ไม่ใช่เงียบเพราะเคยเตือนไปแล้ว
  await query(`UPDATE notifications SET read_at = now() WHERE post_id = $1`, [deadPost]);
  await query(`UPDATE post_targets SET status = 'pending', attempt_count = 0,
                      next_attempt_at = NULL WHERE post_id = $1`, [deadPost]);
  await query(`UPDATE scheduled_posts SET status = 'pending' WHERE id = $1`, [deadPost]);
  for (let i = 0; i < 6; i++) {
    await query(`UPDATE post_targets SET next_attempt_at = NULL WHERE post_id = $1`, [deadPost]);
    await runPublishCycle('fail-again');
  }
  const again = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE post_id = $1 AND read_at IS NULL`,
    [deadPost]);
  check('เกิดซ้ำหลังอ่านไปแล้ว ต้องเตือนใหม่', Number(again?.n) >= 1, `${again?.n} ใบใหม่`);

  // แต่ห้ามยิงซ้ำรัวๆ ระหว่างที่ยังไม่ได้อ่าน
  const beforeSpam = Number((await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE post_id = $1`, [deadPost]))!.n);
  await rollupPostStatus(deadPost);
  await rollupPostStatus(deadPost);
  const afterSpam = Number((await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE post_id = $1`, [deadPost]))!.n);
  check('ไม่ยิงแจ้งเตือนซ้ำระหว่างที่ยังไม่ได้อ่าน', beforeSpam === afterSpam,
        `${beforeSpam} → ${afterSpam}`);

  // ── ตารางเวลาประจำ ────────────────────────────────────────
  const slots = await listSlots(tid);
  check('มีตารางเวลาประจำตั้งต้นให้แล้ว', slots.length > 0, `${slots.length} ช่วง`);

  const free = await nextFreeSlots(tid, 3);
  check('หาช่องว่างถัดไปได้', free.length === 3,
        free.map((d) => d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok',
          weekday: 'short', hour: '2-digit', minute: '2-digit' })).join(' · '));
  check('ช่องที่เสนอต้องเป็นอนาคตเสมอ', free.every((d) => d.getTime() > Date.now()));
  check('ช่องเรียงจากใกล้ไปไกล',
        free.every((d, i) => i === 0 || d.getTime() > free[i - 1].getTime()));

  // ช่องที่มีโพสต์จองแล้วต้องถูกข้าม ไม่ใช่เสนอซ้ำจนโพสต์ชนกัน
  const taken = free[0];
  const holder = await makePost(`ทดสอบจองช่อง ${RUN}`, ['facebook']);
  await query(`UPDATE scheduled_posts SET scheduled_at = $2 WHERE id = $1`, [holder, taken]);
  const after2 = await nextFreeSlots(tid, 1);
  check('ช่องที่ถูกจองแล้วไม่ถูกเสนอซ้ำ',
        after2[0].getTime() !== taken.getTime(),
        `เดิม ${taken.toISOString().slice(11, 16)} → ใหม่ ${after2[0].toISOString().slice(11, 16)}`);

  // เพิ่มช่วงเวลาใหม่แล้วต้องโผล่มาเป็นตัวเลือก
  const sunday = 0;
  await addSlot(tid, sunday, '07:30');
  const withSunday = await listSlots(tid);
  check('เพิ่มช่วงเวลาใหม่ได้',
        withSunday.some((s) => s.weekday === sunday && s.time_of_day.startsWith('07:30')));
  await query(`DELETE FROM posting_slots WHERE tenant_id = $1 AND weekday = 0`, [tid]);

  // ── หลายรูปต่อโพสต์ (carousel) ─────────────────────────────
  const carousel = await makePost(`ทดสอบหลายรูป ${RUN}`, ['facebook', 'instagram'], 4);
  await runPublishCycle('carousel');
  const carouselPost = await getPost(tid, carousel);
  check('โพสต์หลายรูปส่งสำเร็จทุกช่องทาง', carouselPost?.status === 'posted',
        `สถานะ=${carouselPost?.status}`);
  check('เก็บรูปครบทั้ง 4 ใบ ตามลำดับ',
        carouselPost?.media.length === 4, `${carouselPost?.media.length} ใบ`);

  const carouselFeed = (await readFeed()).filter((f) => f.caption.includes(`หลายรูป ${RUN}`));
  check('ปลายทางได้รับจำนวนรูปครบ',
        carouselFeed.every((f) => f.imageCount === 4),
        carouselFeed.map((f) => `${f.platform}:${f.imageCount}`).join(' '));
  check('หลายรูปยังนับเป็นโพสต์เดียวต่อช่องทาง', carouselFeed.length === 2,
        `${carouselFeed.length} โพสต์`);

  // container ลูกถูกล้างหลังโพสต์สำเร็จตามที่ออกแบบ จึงต้องดูจาก log ไม่ใช่จากแถวปัจจุบัน
  const childLogs = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM api_call_log
      WHERE target_id IN (SELECT id FROM post_targets
                           WHERE post_id = $1 AND platform = 'instagram')
        AND operation = 'mock.instagram.carousel_item'`,
    [carousel]);
  check('Instagram สร้าง container ลูกครบทุกใบ', Number(childLogs?.n ?? 0) === 4,
        `${childLogs?.n} ลูก`);

  // เกินเพดานต้องถูกปฏิเสธตั้งแต่ตอนบันทึก ไม่ใช่ให้ Meta ปฏิเสธทีหลัง
  const assetId = (await one<{ id: string }>(
    `SELECT id FROM media_assets WHERE status='ready' LIMIT 1`))!.id;
  const pageAll = await query<{ id: string }>(
    `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active`, [tid]);
  let tooMany = false;
  try {
    await createPost({
      tenantId: tid, caption: 'เกินเพดาน', assetIds: Array(11).fill(assetId),
      scheduledAt: new Date(Date.now() + 3600_000), pageIds: pageAll.map((p) => p.id),
    });
  } catch { tooMany = true; }
  check('ใส่รูปเกิน 10 ใบถูกปฏิเสธตั้งแต่ตอนบันทึก', tooMany);

  // โพสต์รูปเดียวต้องยังทำงานเหมือนเดิม ไม่ใช่พังเพราะเพิ่ม carousel
  const single = await makePost(`ทดสอบรูปเดียว ${RUN}`, ['facebook'], 1);
  await runPublishCycle('single');
  check('โพสต์รูปเดียวยังทำงานเหมือนเดิม',
        (await getPost(tid, single))?.status === 'posted');

  // ── โปสเตอร์สินค้า ─────────────────────────────────────────
  const productPhoto = await one<{ id: string; width: number; height: number }>(
    `SELECT id, width, height FROM media_assets
      WHERE tenant_id = $1 AND storage_key LIKE 'originals/%' LIMIT 1`, [tid]);

  const posterSizes: Record<string, [number, number]> = {
    '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920],
  };
  let sizesOk = true;
  for (const [aspect, [w, h]] of Object.entries(posterSizes)) {
    const r = await renderPoster({
      tenantId: tid, templateId: 'sale', aspect: aspect as '1:1',
      input: { headline: `ลด 20% ${RUN}`, price: '฿240', oldPrice: '฿300' },
      photoAssetId: productPhoto?.id ?? null,
    });
    if (r.width !== w || r.height !== h) sizesOk = false;
  }
  check('สร้างโปสเตอร์ได้ครบทุกสัดส่วน 1:1 · 4:5 · 9:16', sizesOk);

  let allTemplates = true;
  for (const tpl of TEMPLATES) {
    const r = await renderPoster({
      tenantId: tid, templateId: tpl.id, aspect: '4:5',
      input: { ...tpl.sample, headline: `${tpl.sample.headline} ${RUN}` },
      photoAssetId: productPhoto?.id ?? null,
    });
    if (!r.assetId || !r.url) allTemplates = false;
  }
  check('เทมเพลตครบ 7 แบบ สร้างได้ทุกแบบ', allTemplates && TEMPLATES.length === 7,
        `${TEMPLATES.length} แบบ`);

  // รูปสินค้าต้นฉบับห้ามถูกเขียนทับ — ร้านต้องเอารูปเดิมไปทำแบบอื่นได้อีก
  const photoAfter = await one<{ width: number; height: number }>(
    `SELECT width, height FROM media_assets WHERE id = $1`, [productPhoto!.id]);
  check('รูปสินค้าต้นฉบับไม่ถูกแตะหลังทำโปสเตอร์',
        photoAfter?.width === productPhoto?.width && photoAfter?.height === productPhoto?.height,
        `${photoAfter?.width}x${photoAfter?.height}`);

  // ข้อความที่กรอกต้องถูกเก็บไว้ ไม่ใช่เก็บแต่ไฟล์ภาพ — เดือนหน้าแก้ราคาแล้วสร้างใหม่ได้
  const designs = await listPosters(tid, 50);
  const mine = designs.find((d) => String(d.fields.headline ?? '').includes(RUN));
  check('เก็บข้อความที่กรอกไว้ใช้ซ้ำได้', Boolean(mine?.fields.headline), mine?.template_id);

  // โปสเตอร์ต้องเป็น media_asset ปกติ เอาไปเข้าคิวโพสต์ได้ทันที
  const posterPost = await createPost({
    tenantId: tid, caption: `โพสต์จากโปสเตอร์ ${RUN}`,
    assetIds: [mine!.asset_id], scheduledAt: new Date(Date.now() + 3600_000),
    pageIds: (await query<{ id: string }>(
      `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active LIMIT 1`, [tid]))
      .map((p) => p.id),
  });
  check('โปสเตอร์เอาไปตั้งเวลาโพสต์ได้ทันที', Boolean(posterPost.id));
  await cancelPost(tid, posterPost.id);

  // ── หน่วงการเดารหัสผ่าน ────────────────────────────────────
  //
  // ระบบนี้ถือ token ที่โพสต์ลงเพจลูกค้าได้ ใครเดารหัส owner ได้ = โพสต์อะไรก็ได้
  // เดิมกรอกผิดกี่รอบก็ได้ ไม่มีอะไรหน่วงเลย
  const victim = await one<{ email: string }>(
    `SELECT email FROM users ORDER BY created_at LIMIT 1`);
  await query(`DELETE FROM login_attempts WHERE email = $1`, [victim!.email]);

  let lockedAt = 0;
  for (let i = 1; i <= 6; i++) {
    try {
      await signIn(victim!.email, `ผิดแน่นอน-${RUN}-${i}`);
    } catch (err) {
      if ((err as Error).name === 'LoginLockedError' && !lockedAt) lockedAt = i;
    }
  }
  check('กรอกรหัสผิดซ้ำๆ แล้วถูกล็อกชั่วคราว', lockedAt > 0, `ล็อกที่ครั้งที่ ${lockedAt}`);
  check('ปล่อยให้พิมพ์ผิดได้บ้างก่อนล็อก (คนพิมพ์ผิดจริงมีอยู่)', lockedAt >= 5,
        `ล็อกที่ครั้งที่ ${lockedAt}`);

  // ล็อกแล้วต้องล็อกจริง แม้กรอกรหัสถูก ไม่งั้นการล็อกไม่มีความหมาย
  let rightPwBlocked = false;
  try {
    await signIn(victim!.email, 'demo1234');
  } catch (err) {
    rightPwBlocked = (err as Error).name === 'LoginLockedError';
  }
  check('ระหว่างถูกล็อก กรอกรหัสถูกก็ยังเข้าไม่ได้', rightPwBlocked);

  // อีเมลที่ไม่มีในระบบต้องถูกนับด้วย ไม่งั้นคนเดารู้ว่าอีเมลไหนมีอยู่จริง
  await query(`DELETE FROM login_attempts WHERE email = $1`, [`ghost-${RUN}@example.com`]);
  for (let i = 0; i < 5; i++) {
    try { await signIn(`ghost-${RUN}@example.com`, 'x'); } catch { /* ตั้งใจให้ล้ม */ }
  }
  const ghost = await one<{ fails: number; locked_until: Date | null }>(
    `SELECT fails, locked_until FROM login_attempts WHERE email = $1`,
    [`ghost-${RUN}@example.com`]);
  check('อีเมลที่ไม่มีในระบบก็ถูกนับ ไม่บอกใบ้ว่าอีเมลไหนมีจริง',
        Number(ghost?.fails ?? 0) >= 5 && Boolean(ghost?.locked_until));

  await query(`DELETE FROM login_attempts WHERE email = ANY($1::text[])`,
              [[victim!.email, `ghost-${RUN}@example.com`]]);

  // ── ความพร้อมส่งมอบ ───────────────────────────────────────
  //
  // /api/health ตอบ ok ได้ทั้งที่ยังเป็น mock ทั้งระบบ — ตัวเลขเขียวไม่ได้แปลว่าส่งมอบได้
  const readiness = readinessReport();
  const keys = readiness.map((r) => r.key);
  check('รายงานความพร้อมครอบทุกจุดที่ต้องสลับจากของจำลองเป็นของจริง',
        ['DEFAULT_PROVIDER', 'PUBLIC_BASE_URL', 'STORAGE_DRIVER', 'NOTIFY_TRANSPORT',
         'WORKER_HEARTBEAT_URL', 'OPENROUTER_API_KEY'].every((k) => keys.includes(k)),
        `${keys.length} รายการ`);
  check('ยังใช้ provider จำลองอยู่ = ยังส่งมอบไม่ได้',
        readinessBlockers(readiness).some((b) => b.key === 'DEFAULT_PROVIDER'));

  // ── ภาพจาก AI ──────────────────────────────────────────────
  //
  // ข้อที่ห้ามพังที่สุดในกลุ่มนี้: prompt ต้องสั่งห้ามใส่ตัวหนังสือเสมอ
  // โมเดลเขียนไทยไม่ถูก ตัวอักษรมั่วบนโปสเตอร์ร้านค้า = ลูกค้ารู้ทันทีว่าเป็นของ AI
  const noTextEverywhere = MODES.every((m) => {
    const p = buildImagePrompt(m.id, 'ทดสอบ');
    return p.includes('ห้ามมีตัวหนังสือ') && p.includes('no text');
  });
  check('prompt ทุกโหมดสั่งห้ามใส่ตัวอักษรลงในภาพ', noTextEverywhere);

  // เรียกของจริงเมื่อไหร่ = เสียเงินจริงทุกครั้งที่รันเทสต์ ~$0.04/ใบ
  // เครื่องที่ตั้ง key ไว้จึงข้ามเฉพาะข้อที่ต้องยิงออกไปข้างนอก ไม่ข้ามทั้งหมวด
  const aiLive = Boolean(env.ai.openRouterKey);
  if (aiLive) {
    console.log('ข้าม  สร้างภาพจริง — ตั้ง OPENROUTER_API_KEY ไว้ ยิงจริงแล้วเสียเงินทุกรอบเทสต์');
  }

  let aiAssetId: string | null = null;
  if (!aiLive) {
    const madeSizes: Record<string, [number, number]> = {
      '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920],
    };
    let aiSizesOk = true;
    for (const [aspect, [w, h]] of Object.entries(madeSizes)) {
      const img = await generateImage({
        tenantId: tid, mode: 'illustration', aspect: aspect as '1:1',
        topic: `บรรยากาศร้านตอนเช้า ${RUN}`,
      });
      if (img.width !== w || img.height !== h) aiSizesOk = false;
      aiAssetId = img.assetId;
    }
    // สัดส่วนที่ผิดคือของที่ IG ปฏิเสธตอนโพสต์ ไม่ใช่ตอนสร้าง — ต้องจับที่นี่
    check('ภาพ AI ออกมาตรงสัดส่วนที่เลือกทุกแบบ', aiSizesOk);

    const rowsForAsset = await query<{ mode: string; prompt: string; model: string }>(
      `SELECT mode, prompt, model FROM ai_images WHERE asset_id = $1`, [aiAssetId]);
    check('บันทึกที่มาของภาพ AI ไว้ตามหลังได้', rowsForAsset.length === 1,
          rowsForAsset[0]?.model);
    check('ภาพที่ได้ตอนไม่มี API key บอกตัวเองว่าไม่ใช่ของจริง',
          rowsForAsset[0]?.model === 'local-placeholder');

    // คลังรูปต้องแยกให้เห็นว่าใบไหนไม่ใช่รูปถ่ายจริง
    const libAi = (await listLibrary(tid, 'ai', 100)).some((i) => i.id === aiAssetId);
    check('ภาพ AI ขึ้นในคลังรูปเป็นหมวดของตัวเอง', libAi);
    const libUploads = (await listLibrary(tid, 'upload', 100)).some((i) => i.id === aiAssetId);
    check('ภาพ AI ไม่ถูกนับปนกับรูปที่ลูกค้าอัปโหลดเอง', !libUploads);

    // ภาพ AI ต้องเดินต่อเข้าเส้นทางเดิมได้ — วางข้อความไทยทับด้วยฟอนต์จริง
    const fullBleed = await renderPoster({
      tenantId: tid, templateId: 'ai-scene', aspect: '4:5',
      input: { headline: `เปิดแล้ววันนี้ ${RUN}`, brand: 'ร้านตัวอย่าง' },
      photoAssetId: aiAssetId,
    });
    check('เอาภาพ AI มาทำโปสเตอร์เต็มใบแล้วใส่ข้อความไทยได้',
          fullBleed.width === 1080 && fullBleed.height === 1350);

    // ต้นฉบับของโหมดเปลี่ยนพื้นหลังห้ามถูกเขียนทับ — กฎเดียวกับการครอป
    const refBefore = await one<{ id: string; storage_key: string; width: number }>(
      `SELECT id, storage_key, width FROM media_assets
        WHERE tenant_id = $1 AND storage_key LIKE 'originals/%' LIMIT 1`, [tid]);
    const swapped = await generateImage({
      tenantId: tid, mode: 'replace-bg', aspect: '1:1',
      topic: `วางบนโต๊ะหินอ่อน ${RUN}`, refAssetId: refBefore!.id,
    });
    const refAfter = await one<{ storage_key: string; width: number }>(
      `SELECT storage_key, width FROM media_assets WHERE id = $1`, [refBefore!.id]);
    check('เปลี่ยนพื้นหลังแล้วรูปสินค้าต้นฉบับไม่ถูกแตะ',
          refAfter?.storage_key === refBefore?.storage_key
          && refAfter?.width === refBefore?.width
          && swapped.assetId !== refBefore!.id);

    // รูปที่ AI สร้างต้องไม่วนกลับมาเป็น "รูปสินค้าจริง" ให้เลือกเปลี่ยนพื้นหลังอีก
    const candidates = await listRefCandidates(tid, 100);
    check('ภาพ AI ไม่ถูกเสนอเป็นรูปสินค้าต้นฉบับ',
          !candidates.some((c) => c.id === aiAssetId));

    check('ภาพที่เคยสร้างเรียกกลับมาใช้ซ้ำได้',
          (await listAiImages(tid, 50)).some((r) => r.asset_id === aiAssetId));
  }

  // ของที่ต้องปฏิเสธ "ก่อน" ยิงออกไปข้างนอก — ไม่เสียเงินแม้ตั้ง key ไว้
  const rejects: Array<[string, () => Promise<unknown>]> = [
    ['ไม่บอกว่าอยากได้ภาพอะไร', () => generateImage({
      tenantId: tid, mode: 'illustration', aspect: '1:1', topic: '   ' })],
    ['เปลี่ยนพื้นหลังโดยไม่เลือกรูปต้นฉบับ', () => generateImage({
      tenantId: tid, mode: 'replace-bg', aspect: '1:1', topic: 'ฉากใหม่' })],
    ['อ้างรูปของร้านอื่น', () => generateImage({
      tenantId: tid, mode: 'replace-bg', aspect: '1:1', topic: 'ฉากใหม่',
      refAssetId: '00000000-0000-0000-0000-000000000000' })],
  ];
  for (const [label, fn] of rejects) {
    let blocked = false;
    try { await fn(); } catch { blocked = true; }
    check(`ปฏิเสธ${label}`, blocked);
  }

  // เพดานภาพต้องหยุด "ก่อน" เรียก provider ไม่ใช่หลังจ่ายเงินไปแล้ว
  await query(
    `INSERT INTO tenant_limits (tenant_id, ai_images_per_month) VALUES ($1, 0)
     ON CONFLICT (tenant_id) DO UPDATE SET ai_images_per_month = 0`, [tid]);
  let capBlocked = false;
  try {
    await generateImage({ tenantId: tid, mode: 'illustration', aspect: '1:1',
                          topic: `เกินโควตา ${RUN}` });
  } catch { capBlocked = true; }
  check('โควตาภาพเต็มแล้วสร้างต่อไม่ได้', capBlocked);
  await query(
    `UPDATE tenant_limits SET ai_images_per_month = DEFAULT WHERE tenant_id = $1`, [tid]);

  // ── แจ้งเตือนออกนอกแอป ─────────────────────────────────────
  await query(`DELETE FROM notify_channels WHERE tenant_id = $1`, [tid]);
  await addChannel({
    tenantId: tid, kind: 'line', label: `ทดสอบ ${RUN}`,
    destination: `U${RUN}0000`, secret: 'dummy-token-ไม่ใช่ของจริง', minLevel: 'critical',
  });
  const chans = await listChannels(tid);
  check('เพิ่มช่องทางแจ้งเตือนได้', chans.length === 1, chans[0]?.label);

  // token ต้องถูกเข้ารหัสก่อนเก็บ ห้ามมีข้อความดิบในฐานข้อมูล
  const raw = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notify_channels
      WHERE tenant_id = $1 AND secret_ciphertext LIKE '%dummy-token%'`, [tid]);
  check('token ของช่องทางถูกเข้ารหัสก่อนเก็บ', Number(raw?.n) === 0);

  const beforeSend = (await readSent()).length;
  await sendTest(tid, chans[0].id);
  check('ส่งข้อความทดสอบได้', (await readSent()).length === beforeSend + 1);

  // เรื่องด่วนต้องถูกส่งออก · เรื่องธรรมดาต้องไม่ไปกวนตอนดึก
  await query(
    `INSERT INTO notifications (tenant_id, level, title, body)
     VALUES ($1,'critical',$2,'ทดสอบส่งออก'), ($1,'info',$3,'ไม่ควรถูกส่ง')`,
    [tid, `ด่วน ${RUN}`, `ธรรมดา ${RUN}`]);

  const beforePush = (await readSent()).length;
  await pushPendingNotifications();
  const afterPush = await readSent();
  check('แจ้งเตือนระดับด่วนถูกส่งออก LINE',
        afterPush.some((m) => m.text.includes(`ด่วน ${RUN}`)));
  check('เรื่องระดับ info ไม่ถูกส่งตามเกณฑ์ที่ตั้งไว้',
        !afterPush.some((m) => m.text.includes(`ธรรมดา ${RUN}`)));
  check('ส่งออกเพิ่มขึ้นแค่รายการที่เข้าเกณฑ์', afterPush.length === beforePush + 1,
        `${beforePush} → ${afterPush.length}`);

  // รอบถัดไปต้องไม่ส่งซ้ำ ไม่งั้นเจ้าของร้านโดนสแปมทุก 20 วินาที
  await pushPendingNotifications();
  check('ไม่ส่งแจ้งเตือนใบเดิมซ้ำในรอบถัดไป', (await readSent()).length === afterPush.length);

  await query(`DELETE FROM notify_channels WHERE tenant_id = $1`, [tid]);
  await query(`DELETE FROM notifications WHERE title LIKE $1`, [`%${RUN}%`]);

  // ── โควตา Instagram ────────────────────────────────────────
  const q0 = await instagramQuota(tid);
  check('อ่านโควตา Instagram ได้', q0.limit === env.meta.igDailyPostLimit,
        `${q0.used}/${q0.limit}`);

  // ตั้งเพดานต่ำชั่วคราวเพื่อดูว่าระบบกันจริงไหม แทนที่จะยิงจนโดน Meta ปฏิเสธ 100 ครั้ง
  const realLimit = env.meta.igDailyPostLimit;
  (env.meta as { igDailyPostLimit: number }).igDailyPostLimit = q0.used + 1;

  const igA = await makePost(`โควตาตัวแรก ${RUN}`, ['instagram']);
  const igB = await makePost(`โควตาตัวที่สอง ${RUN}`, ['instagram']);
  const cycle = await runPublishCycle('quota');

  const aStatus = await one<{ status: string }>(
    `SELECT status::text FROM post_targets WHERE post_id = $1`, [igA]);
  const bRow = await one<{ status: string; attempt_count: number; next_attempt_at: Date | null;
                           error_message: string | null }>(
    `SELECT status::text, attempt_count, next_attempt_at, error_message
       FROM post_targets WHERE post_id = $1`, [igB]);

  check('ตัวแรกยังโพสต์ออกได้ตามปกติ', aStatus?.status === 'posted', `สถานะ=${aStatus?.status}`);
  check('ตัวที่เกินโควตาถูกเลื่อน ไม่ใช่ล้มเหลว', bRow?.status === 'pending',
        `สถานะ=${bRow?.status}`);
  check('การเลื่อนไม่กินโควตาการลองใหม่ของโพสต์', (bRow?.attempt_count ?? 9) === 0,
        `ลองไปแล้ว ${bRow?.attempt_count} ครั้ง`);
  check('ตั้งเวลาลองใหม่ไว้แล้ว', Boolean(bRow?.next_attempt_at));
  check('บอกสาเหตุให้คนอ่านรู้เรื่อง',
        Boolean(bRow?.error_message?.includes('โควตา')), bRow?.error_message ?? '');
  check('รอบนั้นรายงานว่าเลื่อนไปกี่รายการ', cycle.deferred === 1, `เลื่อน ${cycle.deferred}`);

  const qFull = await instagramQuota(tid);
  check('รู้ว่าช่องจะว่างเมื่อไหร่', qFull.exhausted && qFull.freesAt !== null,
        qFull.freesAt ? qFull.freesAt.toISOString().slice(11, 16) : 'ไม่รู้');

  // Facebook ต้องไม่ถูกโควตาของ Instagram กระทบ
  const fbDuringLimit = await makePost(`เฟซตอนไอจีเต็ม ${RUN}`, ['facebook']);
  await runPublishCycle('quota-fb');
  check('Facebook ยังโพสต์ได้ตอน Instagram เต็ม',
        (await one<{ status: string }>(
          `SELECT status::text FROM post_targets WHERE post_id = $1`, [fbDuringLimit]))
          ?.status === 'posted');

  (env.meta as { igDailyPostLimit: number }).igDailyPostLimit = realLimit;

  // เตือนล่วงหน้าตอนใกล้เต็ม ไม่ใช่ตอนเต็มแล้ว
  check('รู้ว่าเมื่อไหร่ควรเตือนว่าใกล้เต็ม',
        isQuotaLow({ used: 96, limit: 100, remaining: 4, exhausted: false, freesAt: null })
        && !isQuotaLow({ used: 10, limit: 100, remaining: 90, exhausted: false, freesAt: null }));

  // ── ที่เก็บไฟล์ ─────────────────────────────────────────────
  const localKey = randomKey('test', '.bin');
  const payload = Buffer.from(`ทดสอบ ${RUN}`.repeat(50));
  const local = storage();
  check('driver ตั้งต้นคือ local', local.kind === 'local', local.kind);

  const putLocal = await local.put(localKey, payload, 'application/octet-stream');
  check('เก็บไฟล์ลงดิสก์ได้', putLocal.bytes === payload.length);
  check('อ่านกลับได้ตรงกับต้นฉบับ',
        Buffer.compare(await local.get(localKey), payload) === 0);
  check('URL ที่คืนมาชี้ผ่าน /media ของแอป', putLocal.url.includes('/media/test/'));
  await local.delete(localKey);
  let localGone = false;
  try { await local.get(localKey); } catch { localGone = true; }
  check('ลบแล้วอ่านไม่ได้อีก', localGone);

  // key ที่พยายามไต่ออกนอกโฟลเดอร์ต้องถูกปฏิเสธ
  let escaped = false;
  try { await local.get('../../../etc/passwd'); } catch { escaped = true; }
  check('กัน key ที่ไต่ออกนอกที่เก็บไฟล์', escaped);

  // driver s3 ทดสอบกับ MinIO ในเครื่อง ไม่แตะคลาวด์จริง
  // ข้ามได้ถ้าไม่ได้เปิด: docker compose --profile s3 up -d minio
  const cfg = env.storage as Record<string, string>;
  const saved = { ...cfg };
  Object.assign(cfg, {
    driver: 's3', endpoint: 'http://minio:9000', bucket: 'post-scheduler-test',
    region: 'us-east-1', accessKey: 'minioadmin', secretKey: 'minioadmin',
  });
  resetStorage();
  try {
    const s3 = storage();
    const k = randomKey('test', '.bin');
    await s3.put(k, payload, 'application/octet-stream');
    const back = await s3.get(k);
    check('S3: อัปโหลดแล้วอ่านกลับได้ตรงกัน', Buffer.compare(back, payload) === 0);
    await s3.delete(k);
    let s3Gone = false;
    try { await s3.get(k); } catch { s3Gone = true; }
    check('S3: ลบแล้วหายจริง', s3Gone);
  } catch (err) {
    console.log('ข้าม  ทดสอบ S3 — MinIO ไม่ได้เปิด'
      + ' (docker compose --profile s3 up -d minio)');
    void err;
  } finally {
    Object.assign(cfg, saved);
    resetStorage();
  }

  // ── ขั้นตอนอนุมัติและสิทธิ์ผู้ใช้ ────────────────────────────
  const owner = (await one<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`, [tid]))!;

  const editorEmail = `editor-${RUN}@example.com`;
  const editor = (await one<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role)
     VALUES ($1,$2,$3,'editor') RETURNING id`,
    [tid, editorEmail, hashPassword('demo12345')]))!;

  // ── คอนฟิกที่พังเงียบ ──────────────────────────────────
  // เครื่องนี้ตั้งค่าครบแล้ว ต้องไม่มีปัญหาค้าง
  check('คอนฟิกเครื่องนี้ครบ ไม่มีข้อค้าง', configProblems().length === 0,
        configProblems().map((p) => p.key).join(', '));

  // คีย์หายไปต้องจับได้ ไม่ใช่รอไปพังตอนกดเชื่อมเพจ
  const realKey = process.env.ENCRYPTION_KEY_HEX;
  process.env.ENCRYPTION_KEY_HEX = '';
  check('คีย์เข้ารหัสหาย ต้องจับได้ทันที',
        probeConfig().some((p) => p.key === 'ENCRYPTION_KEY_HEX'));
  process.env.ENCRYPTION_KEY_HEX = 'ไม่ใช่hex';
  check('คีย์ผิดรูปแบบ ต้องจับได้',
        probeConfig().some((p) => p.key === 'ENCRYPTION_KEY_HEX'));
  process.env.ENCRYPTION_KEY_HEX = realKey;
  check('คืนคีย์เดิมแล้วคอนฟิกกลับมาปกติ', probeConfig().length === 0);

  // ── เปลี่ยนรหัสผ่านตัวเอง ────────────────────────────────
  // รหัสตั้งต้นที่เจ้าของส่งให้ทางแชท ค้างอยู่ในแชทตลอดไป
  // ถ้าเปลี่ยนเองไม่ได้ หรือเปลี่ยนแล้วไม่เตะ session เก่า = ไม่ได้กันใครออกจริง
  await badPath('รหัสเดิมผิด เปลี่ยนไม่ได้',
    () => changePassword(editor.id, 'wrongpass', 'newpass1234'));
  await badPath('รหัสใหม่สั้นเกินไป เปลี่ยนไม่ได้',
    () => changePassword(editor.id, 'demo12345', 'sh0rt'));
  await badPath('รหัสใหม่ซ้ำของเดิม เปลี่ยนไม่ได้',
    () => changePassword(editor.id, 'demo12345', 'demo12345'));

  // สอง session: เครื่องที่กำลังเปลี่ยน กับเครื่องอื่นที่ล็อกอินค้างไว้
  const keepTok = `keep-${RUN}`;
  const dropTok = `drop-${RUN}`;
  for (const t of [keepTok, dropTok]) {
    await query(
      `INSERT INTO sessions (token, user_id, tenant_id, expires_at)
       VALUES ($1,$2,$3, now() + interval '1 day')`, [t, editor.id, tid]);
  }

  await changePassword(editor.id, 'demo12345', 'newpass1234', keepTok);

  const stillHere = await query(`SELECT token FROM sessions WHERE token = $1`, [keepTok]);
  const kicked = await query(`SELECT token FROM sessions WHERE token = $1`, [dropTok]);
  check('เครื่องที่กดเปลี่ยนไม่โดนเตะออก', stillHere.length === 1);
  check('เครื่องอื่นที่ล็อกอินค้างไว้ถูกเตะออก', kicked.length === 0);

  const editorAfterPw = (await one<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`, [editor.id]))!;
  check('รหัสใหม่ใช้ได้', verifyPassword('newpass1234', editorAfterPw.password_hash));
  check('รหัสเดิมใช้ไม่ได้แล้ว', !verifyPassword('demo12345', editorAfterPw.password_hash));
  check('รหัสผ่านไม่ได้ถูกเก็บเป็นข้อความเปล่า',
        !editorAfterPw.password_hash.includes('newpass1234'));

  await query(`DELETE FROM sessions WHERE token = $1`, [keepTok]);

  check('เจ้าของกับผู้อนุมัติอนุมัติได้ ผู้เขียนอนุมัติไม่ได้',
        canApprove('owner') && canApprove('approver') && !canApprove('editor'));

  // ปิดขั้นตอนอนุมัติ = ทุกคนโพสต์เข้าคิวได้ทันที
  await setApprovalRequired(tid, false);
  check('ปิดขั้นตอนอนุมัติแล้ว ผู้เขียนไม่ต้องรอตรวจ',
        (await needsApproval(tid, 'editor')) === false);

  // เปิดแล้ว งานของผู้เขียนต้องรอตรวจ แต่ของเจ้าของไม่ต้อง
  await setApprovalRequired(tid, true);
  check('เปิดแล้ว งานของผู้เขียนต้องผ่านการตรวจ',
        (await needsApproval(tid, 'editor')) === true);
  check('เจ้าของไม่ต้องรออนุมัติตัวเอง',
        (await needsApproval(tid, 'owner')) === false);

  const asset2 = (await one<{ id: string }>(
    `SELECT id FROM media_assets WHERE status='ready' LIMIT 1`))!;
  const pageIds2 = (await query<{ id: string }>(
    `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active LIMIT 1`, [tid]))
    .map((p) => p.id);

  const submitPost = await createPost({
    tenantId: tid, userId: editor.id, caption: `รออนุมัติ ${RUN}`,
    assetIds: [asset2.id], scheduledAt: new Date(Date.now() + 7200_000),
    pageIds: pageIds2, status: 'pending_approval',
  });
  check('มีงานรอตรวจนับได้', (await countAwaiting(tid)) >= 1);

  // งานที่รออนุมัติต้องไม่ถูกส่งออกไปเอง
  await query(`UPDATE scheduled_posts SET scheduled_at = now() - interval '1 minute'
                WHERE id = $1`, [submitPost.id]);
  await runPublishCycle('approval-guard');
  check('งานที่รออนุมัติไม่ถูกโพสต์ออกเอง',
        (await getPost(tid, submitPost.id))?.status === 'pending_approval',
        `สถานะ=${(await getPost(tid, submitPost.id))?.status}`);

  // ตีกลับต้องมีเหตุผล
  let noReason = false;
  try { await reject(tid, submitPost.id, owner.id, '   '); } catch { noReason = true; }
  check('ตีกลับโดยไม่บอกเหตุผลไม่ได้', noReason);

  await reject(tid, submitPost.id, owner.id, `แก้ราคาก่อน ${RUN}`);
  const rejected = await one<{ status: string; rejected_reason: string | null }>(
    `SELECT status::text, rejected_reason FROM scheduled_posts WHERE id = $1`, [submitPost.id]);
  check('ตีกลับแล้วกลายเป็นร่างพร้อมเหตุผล',
        rejected?.status === 'draft' && Boolean(rejected?.rejected_reason),
        rejected?.rejected_reason ?? '');
  check('คนเขียนได้รับแจ้งเตือนว่าถูกตีกลับ',
        Number((await one<{ n: string }>(
          `SELECT count(*)::text AS n FROM notifications WHERE post_id = $1`,
          [submitPost.id]))?.n) >= 1);

  // ส่งตรวจใหม่แล้วอนุมัติ
  await submitForApproval(tid, submitPost.id);
  const approved = await approve(tid, submitPost.id, owner.id);
  check('อนุมัติแล้วเข้าคิวรอโพสต์',
        (await getPost(tid, submitPost.id))?.status === 'pending');
  check('บอกได้ว่าอนุมัติตอนเลยเวลาไปแล้ว', approved.late === true);
  check('บันทึกว่าใครอนุมัติ',
        Boolean((await one<{ approved_by: string | null }>(
          `SELECT approved_by FROM scheduled_posts WHERE id = $1`, [submitPost.id]))?.approved_by));

  // อนุมัติซ้ำต้องไม่ได้
  let twice = false;
  try { await approve(tid, submitPost.id, owner.id); } catch { twice = true; }
  check('อนุมัติซ้ำไม่ได้', twice);

  // ต้องเหลือเจ้าของอย่างน้อย 1 คนเสมอ
  let lastOwner = false;
  try { await setRole(tid, owner.id, 'editor', editor.id); } catch { lastOwner = true; }
  check('ลดสิทธิ์เจ้าของคนสุดท้ายไม่ได้', lastOwner);

  let selfEdit = false;
  try { await setRole(tid, owner.id, 'editor', owner.id); } catch { selfEdit = true; }
  check('เปลี่ยนสิทธิ์ของตัวเองไม่ได้', selfEdit);

  await removeUser(tid, editor.id, owner.id);
  check('ลบคนในทีมได้',
        (await query(`SELECT id FROM users WHERE id = $1`, [editor.id])).length === 0);

  await setApprovalRequired(tid, false);
  await cancelPost(tid, submitPost.id);

  // ── คลังรูป ────────────────────────────────────────────────
  const lib = await listLibrary(tid, 'all');
  check('คลังรูปแสดงของที่มีอยู่', lib.length > 0, `${lib.length} ไฟล์`);

  const posters = await listLibrary(tid, 'poster');
  const uploads = await listLibrary(tid, 'upload');
  check('กรองแยกโปสเตอร์กับรูปที่อัปโหลดได้',
        posters.every((x) => x.kind === 'poster') && uploads.every((x) => x.kind === 'upload'),
        `โปสเตอร์ ${posters.length} · อัปโหลด ${uploads.length}`);

  const counts = await libraryCounts(tid);
  check('นับจำนวนและขนาดรวมได้', counts.total > 0 && counts.bytes > 0,
        `${counts.total} ไฟล์ · ${Math.round(counts.bytes / 1024)} KB`);

  // รูปที่ยังมีโพสต์รอส่งใช้อยู่ ต้องลบไม่ได้ — ไม่งั้นถึงเวลาโพสต์แล้วรูปหาย
  const guardAsset = await ingestImage({
    tenantId: tid,
    buffer: await sharpTestImage(),
    mimeType: 'image/jpeg',
    originalName: `กันลบ-${RUN}.jpg`,
  });
  const guardPost = await createPost({
    tenantId: tid, caption: `ใช้รูปอยู่ ${RUN}`, assetIds: [guardAsset.id],
    scheduledAt: new Date(Date.now() + 7200_000),
    pageIds: (await query<{ id: string }>(
      `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active LIMIT 1`, [tid]))
      .map((p) => p.id),
  });

  let blocked = false;
  try { await deleteAsset(tid, guardAsset.id); } catch { blocked = true; }
  check('ลบรูปที่ยังมีโพสต์รอส่งใช้อยู่ไม่ได้', blocked);

  await cancelPost(tid, guardPost.id);
  await deleteAsset(tid, guardAsset.id);
  check('ยกเลิกโพสต์แล้วลบรูปได้',
        (await query(`SELECT id FROM media_assets WHERE id = $1`, [guardAsset.id])).length === 0);

  // ลบแล้วไฟล์จริงต้องหายจากที่เก็บด้วย ไม่ใช่แค่แถวใน DB (ค่าเก็บของยังเดินอยู่)
  let fileGone = false;
  try { await storage().get(`originals/${guardAsset.id}`); } catch { fileGone = true; }
  check('ลบแล้วไฟล์จริงหายจากที่เก็บด้วย', fileGone);

  // ── ล้าง log เก่า ───────────────────────────────────────────
  // ปลูกข้อมูลเก่าไว้ให้ล้าง แล้วดูว่าล้างถูกตัวไหม
  await query(
    `INSERT INTO job_runs (job_name, started_at, ok, claimed, succeeded, failed)
     SELECT 'publish', now() - interval '30 days', true, 0, 0, 0
       FROM generate_series(1, 25)`);
  await query(
    `INSERT INTO api_call_log (tenant_id, provider, operation, created_at)
     SELECT $1, 'mock', 'เก่ามาก', now() - interval '90 days' FROM generate_series(1, 15)`,
    [tid]);
  await query(
    `INSERT INTO notifications (tenant_id, level, title, read_at, created_at)
     VALUES ($1, 'info', $2, now() - interval '200 days', now() - interval '200 days')`,
    [tid, `เก่าอ่านแล้ว ${RUN}`]);
  await query(
    `INSERT INTO notifications (tenant_id, level, title, created_at)
     VALUES ($1, 'critical', $2, now() - interval '200 days')`,
    [tid, `เก่ายังไม่อ่าน ${RUN}`]);
  await query(
    `INSERT INTO sessions (token, user_id, tenant_id, expires_at)
     SELECT 'expired-' || $2, u.id, u.tenant_id, now() - interval '1 day'
       FROM users u WHERE u.tenant_id = $1 LIMIT 1`,
    [tid, RUN]);

  const growthBefore = await growthReport();
  const rowsOf = (list: typeof growthBefore, t: string) =>
    list.find((x) => x.table === t)?.rows ?? 0;

  const purged = await runRetention();
  check('ล้าง heartbeat เก่ากว่า 7 วัน', purged.job_runs >= 25, `${purged.job_runs} แถว`);
  check('ล้าง log การเรียก API เก่ากว่า 30 วัน', purged.api_call_log >= 15,
        `${purged.api_call_log} แถว`);
  check('ล้าง session ที่หมดอายุแล้ว', purged.sessions >= 1, `${purged.sessions} แถว`);

  // ที่ยังไม่อ่านต้องไม่ถูกลบ ไม่ว่าจะเก่าแค่ไหน
  const unreadOld = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE title = $1`,
    [`เก่ายังไม่อ่าน ${RUN}`]);
  check('แจ้งเตือนที่ยังไม่อ่านไม่ถูกลบแม้เก่ามาก', Number(unreadOld?.n) === 1);

  const readOld = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE title = $1`,
    [`เก่าอ่านแล้ว ${RUN}`]);
  check('แจ้งเตือนที่อ่านแล้วและเก่าถูกล้าง', Number(readOld?.n) === 0);

  // ของที่ลูกค้าทำเองห้ามหาย
  const growthAfter = await growthReport();
  check('โพสต์ไม่ถูกล้างไปด้วย',
        (await one<{ n: string }>(`SELECT count(*)::text AS n FROM scheduled_posts`))!.n !== '0');
  check('รูปในคลังไม่ถูกล้างไปด้วย',
        (await one<{ n: string }>(`SELECT count(*)::text AS n FROM media_assets`))!.n !== '0');
  check('log ล่าสุดยังอยู่ ไม่ได้ล้างหมดทั้งตาราง',
        rowsOf(growthAfter, 'job_runs') > 0 || rowsOf(growthBefore, 'job_runs') === 0,
        `${rowsOf(growthBefore, 'job_runs')} → ${rowsOf(growthAfter, 'job_runs')} แถว`);

  // รันวันละครั้งพอ — รันเสร็จแล้วต้องไม่รันซ้ำทันที
  await query(
    `INSERT INTO job_runs (job_name, ok, claimed, succeeded, failed)
     VALUES ('retention', true, 0, 0, 0)`);
  check('ไม่รันล้างซ้ำในวันเดียวกัน', (await shouldRunRetention()) === false);

  await query(`DELETE FROM notifications WHERE title LIKE $1`, [`%${RUN}%`]);
  await query(`DELETE FROM job_runs WHERE job_name = 'retention'`);

  // ── แฮชแท็ก ────────────────────────────────────────────────
  const messy = ['อาหาร,', '#อร่อย', '', '#อร่อย', 'กรุงเทพ'].join(' ');
  check('ทำความสะอาดแท็กที่คนพิมพ์มา — เติม # ตัดซ้ำ',
        JSON.stringify(normalizeTags(messy))
        === JSON.stringify(['#อาหาร', '#อร่อย', '#กรุงเทพ']),
        normalizeTags(messy).join(' '));

  await saveSet({ tenantId: tid, name: `ชุดทดสอบ ${RUN}`, tags: ['#หนึ่ง', '#สอง'] });
  const sets = await listSets(tid);
  check('บันทึกชุดแท็กได้', sets.some((x) => x.name === `ชุดทดสอบ ${RUN}`),
        `${sets.length} ชุด`);

  let tooManyTags = false;
  try {
    await saveSet({ tenantId: tid, name: `เกิน ${RUN}`,
      tags: Array.from({ length: 31 }, (_, i) => `#t${i}`) });
  } catch { tooManyTags = true; }
  check('ชุดเดียวเกิน 30 แท็กถูกปฏิเสธ', tooManyTags);

  const withTags = appendTags('ข้อความโพสต์', ['#หนึ่ง', '#สอง']);
  check('ต่อแท็กท้ายแคปชั่นคั่นด้วยบรรทัดว่าง',
        withTags === ['ข้อความโพสต์', '', '#หนึ่ง #สอง'].join(String.fromCharCode(10)),
        JSON.stringify(withTags));
  check('ไม่ต่อแท็กซ้ำที่มีอยู่แล้ว',
        appendTags(withTags, ['#หนึ่ง', '#สาม']).split('#หนึ่ง').length === 2);
  check('นับแท็กในแคปชั่นได้', countTags(withTags) === 2, `${countTags(withTags)} แท็ก`);

  // AI ต้องเสนอแท็กมาด้วย ไม่ใช่แค่แคปชั่น
  const withSuggest = await generateCaptions({
    tenantId: tid,
    pageId: (await query<{ id: string }>(
      `SELECT id FROM social_pages WHERE tenant_id = $1 LIMIT 1`, [tid]))[0].id,
    topic: `โปรโมชั่นกาแฟเย็น ${RUN}`,
  });
  check('ผู้ช่วยเสนอแฮชแท็กมาด้วย', withSuggest.suggestedTags.length > 0,
        withSuggest.suggestedTags.join(' '));
  check('แท็กที่เสนอขึ้นต้นด้วย # ทุกอัน',
        withSuggest.suggestedTags.every((t) => t.startsWith('#')));

  await removeSet(tid, sets.find((x) => x.name === `ชุดทดสอบ ${RUN}`)!.id);
  await query(`DELETE FROM hashtag_sets WHERE name LIKE $1`, [`%${RUN}%`]);

  // ── ลากเลื่อนวันในปฏิทิน ────────────────────────────────────
  const movePost = await createPost({
    tenantId: tid, caption: `ลากเลื่อน ${RUN}`,
    assetIds: [(await one<{ id: string }>(
      `SELECT id FROM media_assets WHERE status='ready' LIMIT 1`))!.id],
    // ตั้งเวลา 14:30 ตามเวลาไทยของพรุ่งนี้
    scheduledAt: new Date(Date.now() + 86400_000),
    pageIds: (await query<{ id: string }>(
      `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active LIMIT 1`, [tid]))
      .map((p) => p.id),
  });
  await query(
    `UPDATE scheduled_posts
        SET scheduled_at = ((now() AT TIME ZONE 'Asia/Bangkok')::date + interval '1 day'
                            + interval '14 hours 30 minutes') AT TIME ZONE 'Asia/Bangkok'
      WHERE id = $1`, [movePost.id]);

  const beforeMove = await one<{ t: string }>(
    `SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS t
       FROM scheduled_posts WHERE id = $1`, [movePost.id]);

  const targetDay = new Date(Date.now() + 5 * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  await movePostToDay(tid, movePost.id, targetDay);

  const afterMove = await one<{ d: string; t: string }>(
    `SELECT to_char((scheduled_at AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS d,
            to_char(scheduled_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS t
       FROM scheduled_posts WHERE id = $1`, [movePost.id]);

  check('ลากเลื่อนไปวันใหม่ได้', afterMove?.d === targetDay,
        `${afterMove?.d} (ตั้งใจ ${targetDay})`);
  check('เวลาในวันคงเดิมหลังเลื่อน', afterMove?.t === beforeMove?.t,
        `${beforeMove?.t} → ${afterMove?.t}`);

  // ย้ายมาไว้อดีตต้องบอกว่าเลยเวลาแล้ว ไม่ใช่เงียบ
  const pastDay = new Date(Date.now() - 2 * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const movedPast = await movePostToDay(tid, movePost.id, pastDay);
  check('ย้ายไปอดีตแล้วระบบบอกว่าเลยเวลา', movedPast.past === true);

  // โพสต์ที่ออกไปแล้วเลื่อนไม่ได้
  const donePost = await one<{ id: string }>(
    `SELECT id FROM scheduled_posts WHERE status = 'posted' LIMIT 1`);
  let cannotMove = false;
  if (donePost) {
    try { await movePostToDay(tid, donePost.id, targetDay); } catch { cannotMove = true; }
  }
  check('โพสต์ที่ออกไปแล้วลากเลื่อนไม่ได้', donePost ? cannotMove : true);

  // ปฏิทินต้องดึงโพสต์ทั้งเดือนมาแสดงได้
  const monthStart = new Date(Date.now() - 10 * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
  const inRange = await postsInRange(tid, monthStart, 42);
  check('ดึงโพสต์ทั้งเดือนมาวางในปฏิทินได้', inRange.length > 0, `${inRange.length} โพสต์`);
  check('แต่ละโพสต์มีวันกับเวลาแยกกัน พร้อมวางในช่อง',
        inRange.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day) && /^\d{2}:\d{2}$/.test(p.time)));

  await cancelPost(tid, movePost.id);

  // ── เลือกกรอบครอปเอง ────────────────────────────────────────
  // กรอบต้องอยู่ในภาพเสมอ ไม่ล้นขอบ ไม่ว่าจะชี้ตรงมุมแค่ไหน
  const corners = [
    { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }, { x: 0, y: 1 }, { x: 1, y: 0 },
  ];
  const inBounds = corners.every((f) => {
    const r = cropRect(1600, 1200, 1080, 1350, f);
    return r.left >= 0 && r.top >= 0
      && r.left + r.width <= 1600 && r.top + r.height <= 1200;
  });
  check('กรอบครอปไม่ล้นขอบภาพไม่ว่าชี้ตรงไหน', inBounds);

  // สัดส่วนของกรอบต้องตรงกับที่ขอ
  const r45 = cropRect(1600, 1200, 1080, 1350, { x: 0.5, y: 0.5 });
  check('กรอบได้สัดส่วนตรงกับที่ขอ',
        Math.abs((r45.width / r45.height) - (1080 / 1350)) < 0.02,
        `${r45.width}x${r45.height} = ${(r45.width / r45.height).toFixed(3)}`);

  // ชี้ซ้ายสุดกับขวาสุดต้องได้กรอบคนละที่
  const rl = cropRect(1600, 1200, 1080, 1350, { x: 0, y: 0.5 });
  const rr = cropRect(1600, 1200, 1080, 1350, { x: 1, y: 0.5 });
  check('ชี้คนละจุดได้กรอบคนละที่', rl.left !== rr.left, `${rl.left} vs ${rr.left}`);

  // ครอปจริงตามจุดที่เลือก แล้วเก็บจุดไว้ให้กลับมาแก้ได้
  const cropAsset = await ingestImage({
    tenantId: tid, buffer: await sharpTestImage(),
    mimeType: 'image/jpeg', originalName: `ครอป-${RUN}.jpg`,
  });
  const cropped = await makeVariant({
    tenantId: tid, assetId: cropAsset.id, aspect: '9:16', focus: { x: 0.2, y: 0.8 },
  });
  check('ครอปตามจุดที่เลือกได้', cropped.width === 1080 && cropped.height === 1920,
        `${cropped.width}x${cropped.height}`);

  const savedFocus = await one<{ overlay: { focus?: { x: number } } | null }>(
    `SELECT overlay FROM media_variants WHERE asset_id = $1 AND aspect_ratio = '9:16'`,
    [cropAsset.id]);
  check('เก็บจุดที่เลือกไว้ กลับมาแก้ได้', savedFocus?.overlay?.focus?.x === 0.2,
        JSON.stringify(savedFocus?.overlay));

  // ครอปใหม่ทับได้ ต้นฉบับไม่ถูกแตะ
  await makeVariant({
    tenantId: tid, assetId: cropAsset.id, aspect: '9:16', focus: { x: 0.8, y: 0.2 },
  });
  const reFocus = await one<{ overlay: { focus?: { x: number } } | null }>(
    `SELECT overlay FROM media_variants WHERE asset_id = $1 AND aspect_ratio = '9:16'`,
    [cropAsset.id]);
  check('เปลี่ยนจุดแล้วครอปใหม่ทับของเดิม', reFocus?.overlay?.focus?.x === 0.8);
  check('ต้นฉบับไม่ถูกแตะหลังครอปสองรอบ',
        (await one<{ width: number }>(
          `SELECT width FROM media_assets WHERE id = $1`, [cropAsset.id]))?.width === 900);

  await deleteAsset(tid, cropAsset.id);

  // ── สถิติผลตอบรับ ───────────────────────────────────────────
  // โพสต์ที่เพิ่งขึ้นยังไม่ถึงเวลาเก็บ 1 ชม. — ต้องไม่เก็บก่อนเวลา
  const freshPost = await makePost(`วัดผลสด ${RUN}`, ['facebook']);
  await runPublishCycle('metrics-fresh');
  await collectDue();
  const tooEarly = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM post_metrics m
       JOIN post_targets t ON t.id = m.target_id WHERE t.post_id = $1`, [freshPost]);
  check('ไม่เก็บสถิติก่อนถึงช่วงเวลาที่กำหนด', Number(tooEarly?.n) === 0);

  // ย้อนเวลาให้ผ่านไป 25 ชม. แล้วเก็บ — ต้องได้ทั้ง 1h และ 24h ไม่ใช่ 7d
  await query(
    `UPDATE post_targets SET updated_at = now() - interval '25 hours' WHERE post_id = $1`,
    [freshPost]);
  const got = await collectDue();
  check('เก็บสถิติเมื่อถึงเวลาแล้ว', got >= 2, `${got} รายการ`);

  const buckets = await query<{ age_bucket: string; reach: number | null; likes: number | null }>(
    `SELECT m.age_bucket, m.reach, m.likes FROM post_metrics m
       JOIN post_targets t ON t.id = m.target_id
      WHERE t.post_id = $1 ORDER BY m.age_bucket`, [freshPost]);
  check('แยกเก็บเป็นช่วงเวลา ไม่ทับกันเป็นตัวเดียว',
        buckets.length === 2 && buckets.some((b) => b.age_bucket === '1h')
        && buckets.some((b) => b.age_bucket === '24h'),
        buckets.map((b) => b.age_bucket).join(' '));
  check('ยังไม่เก็บ 7 วัน เพราะยังไม่ถึงเวลา',
        !buckets.some((b) => b.age_bucket === '7d'));
  check('ได้ตัวเลขจริงไม่ใช่ค่าว่าง',
        buckets.every((b) => (b.reach ?? 0) > 0 && (b.likes ?? 0) >= 0),
        buckets.map((b) => `${b.age_bucket}:${b.reach}`).join(' '));

  // เก็บซ้ำต้องไม่สร้างแถวใหม่ แต่ทับของเดิมได้
  const beforeAgain = buckets.length;
  await collectDue();
  const afterAgain = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM post_metrics m
       JOIN post_targets t ON t.id = m.target_id WHERE t.post_id = $1`, [freshPost]);
  check('เก็บซ้ำไม่สร้างแถวซ้ำ', Number(afterAgain?.n) === beforeAgain,
        `${beforeAgain} → ${afterAgain?.n}`);

  const insights = await listInsights(tid, 10);
  check('หน้าผลตอบรับดึงข้อมูลได้', insights.length > 0, `${insights.length} โพสต์`);
  const withBuckets = insights.find((i) => Object.keys(i.buckets).length > 0);
  check('สถิติผูกกับโพสต์ถูกตัว', Boolean(withBuckets),
        withBuckets ? Object.keys(withBuckets.buckets).join(' ') : 'ไม่มี');

  check('มีช่วงเวลาที่เก็บครบ 3 ช่วง', BUCKETS.length === 3,
        BUCKETS.map((b) => b.id).join(' '));

  // ช่วงเวลาที่ดีที่สุดต้องมีข้อมูลพอถึงจะแสดง
  const times = await bestTimes(tid);
  check('ช่วงเวลาที่ดีที่สุดแสดงเฉพาะที่มีข้อมูลพอ (>=2 โพสต์)',
        times.every((t) => Number(t.posts) >= 2), `${times.length} ช่วง`);

  await cancelPost(tid, freshPost).catch(() => {});

  // ── จัดการการเชื่อมต่อจากเว็บ ────────────────────────────────
  const conn = await connectPage({
    tenantId: tid, platform: 'facebook', provider: 'mock',
    remoteId: `page-${RUN}`, displayName: `เพจทดสอบ ${RUN}`,
    token: 'TOKEN-ทดสอบ-ไม่ใช่ของจริง',
  });
  check('เชื่อมต่อเพจใหม่จากเว็บได้', Boolean(conn.pageId && conn.credentialId));

  // token ต้องถูกเข้ารหัส ห้ามมีข้อความดิบใน DB
  const rawToken = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM meta_credentials
      WHERE tenant_id = $1 AND token_ciphertext LIKE '%TOKEN-ทดสอบ%'`, [tid]);
  check('token ถูกเข้ารหัสก่อนเก็บ ไม่มีข้อความดิบ', Number(rawToken?.n) === 0);

  // ตรวจแล้วต้องบันทึกผลลง DB
  const verified = await verifyConnection(tid, conn.pageId);
  check('กดตรวจแล้วรู้ผลทันที', verified.ok === true);
  const status = await one<{ status: string; checked: Date | null }>(
    `SELECT c.status::text, c.last_checked_at AS checked
       FROM meta_credentials c JOIN page_credentials pc ON pc.credential_id = c.id
      WHERE pc.page_id = $1`, [conn.pageId]);
  check('บันทึกผลการตรวจไว้ดูย้อนหลังได้',
        status?.status === 'healthy' && status.checked !== null, status?.status);

  // เปลี่ยน token แล้วต้องผูกตัวใหม่ ไม่ใช่ค้างตัวเก่า
  await replaceToken(tid, conn.pageId, 'TOKEN-ตัวใหม่');
  const bound = await query<{ id: string }>(
    `SELECT credential_id AS id FROM page_credentials WHERE page_id = $1`, [conn.pageId]);
  check('เปลี่ยน token แล้วผูกตัวใหม่ตัวเดียว',
        bound.length === 1 && bound[0].id !== conn.credentialId);
  check('token ตัวใหม่ก็ยังไม่ถูกตรวจจนกว่าจะกด',
        (await one<{ s: string }>(
          `SELECT c.status::text AS s FROM meta_credentials c
             JOIN page_credentials pc ON pc.credential_id = c.id
            WHERE pc.page_id = $1`, [conn.pageId]))?.s === 'unchecked');

  // ปิดเพจที่ยังมีโพสต์รอส่งไม่ได้
  const blockPost = await createPost({
    tenantId: tid, caption: `กันปิดเพจ ${RUN}`,
    assetIds: [(await one<{ id: string }>(
      `SELECT id FROM media_assets WHERE status='ready' LIMIT 1`))!.id],
    scheduledAt: new Date(Date.now() + 7200_000), pageIds: [conn.pageId],
  });
  let blockedDisconnect = false;
  try { await disconnectPage(tid, conn.pageId); } catch { blockedDisconnect = true; }
  check('ปิดเพจที่ยังมีโพสต์รอส่งไม่ได้', blockedDisconnect);

  await cancelPost(tid, blockPost.id);
  await disconnectPage(tid, conn.pageId);
  check('ยกเลิกโพสต์แล้วปิดเพจได้',
        (await one<{ a: boolean }>(
          `SELECT is_active AS a FROM social_pages WHERE id = $1`, [conn.pageId]))?.a === false);
  check('ปิดเพจแล้วประวัติยังอยู่ ไม่ได้ลบทิ้ง',
        (await query(`SELECT id FROM social_pages WHERE id = $1`, [conn.pageId])).length === 1);

  await query(`DELETE FROM social_pages WHERE tenant_id = $1 AND remote_id = $2`,
              [tid, `page-${RUN}`]);

  // D9 — heartbeat ต้องบันทึกทุกรอบ
  const hb = await one<{ n: string }>(`SELECT count(*) AS n FROM job_runs WHERE job_name = 'publish'`);
  check('D9 มี heartbeat ของ worker', Number(hb?.n) > 0, `${hb?.n} รอบ`);

  // C9 — ต้องมี log ของทุก call
  const logs = await one<{ n: string }>(`SELECT count(*) AS n FROM api_call_log`);
  check('C9 มี log การเรียก API', Number(logs?.n) > 0, `${logs?.n} รายการ`);

  // E2 — token ต้องไม่โผล่ใน log
  const leak = await one<{ n: string }>(
    `SELECT count(*) AS n FROM api_call_log WHERE request_meta::text ILIKE '%token%'`,
  );
  check('E2 ไม่มี token ใน api_call_log', Number(leak?.n) === 0);

  // ── ลืมรหัสผ่าน ────────────────────────────────────────────
  //
  // เดิมลืมรหัส = ต้องรบกวนเจ้าของให้ตั้งใหม่ให้ ซึ่งแปลว่าเจ้าของต้องรู้รหัสของคนอื่น
  // และรหัสนั้นค้างอยู่ในแชทตลอดไป — ปัญหาเดียวกับที่ changePassword มีไว้แก้
  const forgetful = await one<{ id: string; email: string; password_hash: string }>(
    `SELECT id, email, password_hash FROM users ORDER BY created_at LIMIT 1`);
  await query(`DELETE FROM password_resets WHERE user_id = $1`, [forgetful!.id]);
  await query(`DELETE FROM login_attempts WHERE lower(email) = lower($1)`, [forgetful!.email]);
  const mailBefore = (await readMail()).length;

  await requestReset(forgetful!.email);
  const mailAfter = await readMail();
  check('ขอลิงก์แล้วมีอีเมลออกไป 1 ฉบับ', mailAfter.length === mailBefore + 1);
  const link = (mailAfter[0]?.text ?? '').split('\n').find((l) => l.includes('/reset/')) ?? '';
  const token = link.trim().split('/reset/')[1] ?? '';
  check('อีเมลมีลิงก์ตั้งรหัสใหม่', token.length > 20);

  // เก็บลายนิ้วมือ ไม่ใช่ตัว token — ใครอ่าน DB ได้ต้องเอาไปตั้งรหัสใหม่ไม่ได้
  const stored = await one<{ n: string }>(
    `SELECT count(*) AS n FROM password_resets WHERE token_fp = $1`, [token]);
  check('DB ไม่ได้เก็บ token ตัวเต็ม', Number(stored?.n) === 0);

  // อีเมลที่ไม่มีในระบบต้องเงียบสนิท ไม่งั้นหน้านี้กลายเป็นเครื่องมือไล่เช็คว่าใครมีบัญชี
  const beforeUnknown = (await readMail()).length;
  await requestReset(`ไม่มีจริง-${RUN}@example.com`);
  check('อีเมลที่ไม่มีบัญชี ไม่ส่งอะไรออกไปเลย',
        (await readMail()).length === beforeUnknown);

  check('ลิงก์ที่ยังไม่ถูกใช้ ใช้ได้', await resetTokenValid(token));
  await badPath('รหัสใหม่สั้นเกินไปต้องไม่ผ่าน', () => consumeReset(token, 'สั้น'));

  // session ที่ค้างอยู่ต้องตาย: คนที่มาถึงหน้านี้คือคนที่เข้าไม่ได้อยู่แล้ว
  // ส่วนคนที่ยังล็อกอินค้างอาจเป็นคนที่เรากำลังไล่ออก
  await query(
    `INSERT INTO sessions (user_id, tenant_id, token, expires_at)
     SELECT $1, tenant_id, $2, now() + interval '1 day' FROM users WHERE id = $1`,
    [forgetful!.id, `ค้างอยู่-${RUN}`]);
  await consumeReset(token, `รหัสใหม่ยาวพอ-${RUN}`);
  const liveSessions = await one<{ n: string }>(
    `SELECT count(*) AS n FROM sessions WHERE user_id = $1`, [forgetful!.id]);
  check('ตั้งรหัสใหม่แล้ว session เดิมถูกเตะออกหมด', Number(liveSessions?.n) === 0);

  const afterReset = await one<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`, [forgetful!.id]);
  check('รหัสใหม่ใช้ได้จริง', verifyPassword(`รหัสใหม่ยาวพอ-${RUN}`, afterReset!.password_hash));

  await badPath('ลิงก์เดิมใช้ซ้ำไม่ได้',
                () => consumeReset(token, `พยายามอีกรอบ-${RUN}`));
  check('ลิงก์ที่ใช้แล้วไม่ผ่านการตรวจ', !(await resetTokenValid(token)));

  // ขอใหม่ต้องฆ่าของเก่า ไม่งั้นลิงก์ในเมลฉบับก่อน (และในมือคนที่เห็นเมลนั้น) ยังใช้ได้
  await query(`DELETE FROM password_resets WHERE user_id = $1`, [forgetful!.id]);
  await requestReset(forgetful!.email);
  const first = tokenFrom((await readMail())[0]?.text ?? '');
  await requestReset(forgetful!.email);
  const second = tokenFrom((await readMail())[0]?.text ?? '');
  check('ขอลิงก์ใหม่แล้วลิงก์เก่าใช้ไม่ได้ทันที', !(await resetTokenValid(first)));
  check('ลิงก์ล่าสุดใช้ได้', await resetTokenValid(second));

  // หมดอายุแล้วต้องไม่ผ่าน — ย้อนเวลาแทนการรอจริง
  await query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'
                WHERE user_id = $1 AND used_at IS NULL`, [forgetful!.id]);
  check('ลิงก์หมดอายุใช้ไม่ได้', !(await resetTokenValid(second)));

  // ยิงซ้ำจนกล่องจดหมายเจ้าของร้านเต็มไม่ได้
  await query(`DELETE FROM password_resets WHERE user_id = $1`, [forgetful!.id]);
  let sentInHour = 0;
  const beforeFlood = (await readMail()).length;
  for (let i = 0; i < 6; i++) await requestReset(forgetful!.email);
  sentInHour = (await readMail()).length - beforeFlood;
  check('ขอถี่ๆ ถูกจำกัดจำนวนอีเมลต่อชั่วโมง', sentInHour <= 3, `ส่งออกไป ${sentInHour} ฉบับ`);

  // ล็อกจากการเดารหัสต้องหลุดหลังตั้งรหัสใหม่ ไม่งั้นตั้งเสร็จแล้วยังเข้าไม่ได้อีก 15 นาที
  await query(
    `INSERT INTO login_attempts (email, fails, locked_until)
     VALUES ($1, 9, now() + interval '15 minutes')
     ON CONFLICT (email) DO UPDATE SET fails = 9, locked_until = now() + interval '15 minutes'`,
    [forgetful!.email]);
  await query(`DELETE FROM password_resets WHERE user_id = $1`, [forgetful!.id]);
  await requestReset(forgetful!.email);
  await consumeReset(tokenFrom((await readMail())[0]?.text ?? ''), `ปลดล็อกด้วย-${RUN}`);
  const stillLocked = await one(
    `SELECT 1 FROM login_attempts WHERE lower(email) = lower($1)`, [forgetful!.email]);
  check('ตั้งรหัสใหม่แล้วการล็อกจากการเดารหัสถูกล้าง', !stillLocked);

  // ── ส่งอีเมลจริงผ่าน SMTP ──────────────────────────────────
  //
  // mock พิสูจน์ได้แค่ว่าเราเรียกฟังก์ชันส่ง ไม่ได้พิสูจน์ว่าพูด SMTP เป็น
  // เซิร์ฟเวอร์จำลองตัวนี้พูดตามโปรโตคอลจริง แล้วเก็บสิ่งที่เราส่งมาให้ตรวจ
  const smtp = await fakeSmtp();
  try {
    Object.assign(env.mail, {
      transport: 'smtp', host: '127.0.0.1', port: smtp.port,
      secure: false, starttls: false, user: 'ผู้ใช้', pass: 'ลับ',
      from: 'no-reply@example.com',
    });
    await sendMail({ to: forgetful!.email, subject: 'ทดสอบ ภาษาไทย', text: 'บรรทัดแรก\n.จุดนำหน้า' });
    const wire = smtp.transcript();
    check('SMTP: บอกผู้ส่งและผู้รับถูกต้อง',
          wire.includes('MAIL FROM:<no-reply@example.com>')
          && wire.includes(`RCPT TO:<${forgetful!.email}>`));
    check('SMTP: ล็อกอินด้วย AUTH LOGIN ที่ถอดกลับได้',
          wire.includes(Buffer.from('ผู้ใช้').toString('base64')));
    check('SMTP: หัวข้อภาษาไทยถูกเข้ารหัสตาม RFC 2047',
          wire.includes('=?UTF-8?B?') && !wire.includes('Subject: ทดสอบ'));
    check('SMTP: จุดต้นบรรทัดถูกเบิ้ล ข้อความไม่ถูกตัดกลางคัน',
          wire.includes('\r\n..จุดนำหน้า\r\n'));
    check('SMTP: ปิดท้ายด้วยจุดเดี่ยวแล้วจึง QUIT',
          wire.includes('\r\n.\r\nQUIT'));
  } finally {
    Object.assign(env.mail, { transport: 'mock', host: '', user: '', pass: '' });
    await smtp.close();
  }

  // คืนรหัสเดิมให้บัญชีที่ยืมมาทดสอบ — เทสต์ชุดนี้เปลี่ยนรหัสจริงไปหลายรอบ
  // ไม่คืน = รันเทสต์ทีไร รหัสที่ README บอกไว้ (demo1234) ก็ใช้เข้าไม่ได้อีกเลย
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
              [forgetful!.id, forgetful!.password_hash]);
  await query(`DELETE FROM password_resets WHERE user_id = $1`, [forgetful!.id]);
  const restored = await one<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`, [forgetful!.id]);
  check('เทสต์คืนรหัสผ่านเดิมของบัญชีที่ยืมมาใช้',
        restored!.password_hash === forgetful!.password_hash);

  await badPath('ตั้งค่า SMTP ไม่ครบแล้วส่ง ต้องฟ้อง ไม่ใช่เงียบ', async () => {
    Object.assign(env.mail, { transport: 'smtp', host: '', from: '' });
    try {
      await sendMail({ to: 'a@example.com', subject: 'x', text: 'y' });
    } finally {
      Object.assign(env.mail, { transport: 'mock' });
    }
  });


  console.log(`\n${failures === 0 ? 'ผ่านทั้งหมด' : `ไม่ผ่าน ${failures} ข้อ`}`);
  // เก็บกวาดของที่รอบนี้สร้าง ไม่ให้ปนกับข้อมูลตัวอย่างที่เอาไว้โชว์
  const wiped = await query<{ id: string }>(
    `DELETE FROM scheduled_posts WHERE caption LIKE $1 RETURNING id`, [`%${RUN}%`]);

  // โปสเตอร์กับรูปที่รอบนี้สร้างต้องล้างด้วย ไม่งั้นคลังรูปบวมทุกครั้งที่รันเทสต์
  const junk = await query<{ storage_key: string }>(
    `DELETE FROM media_assets
      WHERE tenant_id = (SELECT id FROM tenants LIMIT 1)
        AND (original_name LIKE $1
             OR id IN (SELECT asset_id FROM poster_designs
                        WHERE fields->>'headline' LIKE $1)
             OR id IN (SELECT asset_id FROM ai_images WHERE prompt LIKE $1))
      RETURNING storage_key`,
    [`%${RUN}%`]);
  for (const j of junk) await storage().delete(j.storage_key).catch(() => {});
  console.log(`เก็บกวาดข้อมูลทดสอบ ${wiped.length} โพสต์ · ${junk.length} รูป`);

  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ทดสอบล้มเหลว:', err);
  process.exit(1);
});
