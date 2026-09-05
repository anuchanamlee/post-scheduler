import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../lib/db.js';
import { env } from '../lib/env.js';
import { open, seal } from '../lib/crypto.js';

/**
 * ส่งแจ้งเตือนออกนอกแอป
 *
 * แจ้งเตือนในแอปมีค่าก็ต่อเมื่อมีคนเปิดแอปดู — โพสต์ล้มตอนตี 2 เจ้าของร้านจะรู้ตอนเช้า
 * ซึ่งสายเกินไปสำหรับโปรที่ลงเวลาเฉพาะ
 *
 * ใช้ LINE Messaging API ไม่ใช่ LINE Notify (ปิดบริการ 31 มี.ค. 2025)
 *
 * ชั้นนี้ไม่รู้จักโพสต์หรือ Meta เลย รับแค่ "ข้อความที่ต้องถึงคน" กับ "ช่องทาง"
 * จึงเพิ่ม Telegram/อีเมล/webhook ทีหลังได้โดยไม่แตะโค้ดที่เรียกใช้
 */

const LEVEL_RANK: Record<string, number> = { info: 1, warning: 2, critical: 3 };

export type Channel = {
  id: string;
  tenant_id: string;
  kind: string;
  label: string;
  destination: string;
  min_level: string;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_auth_tag: string | null;
  key_version: number;
};

export async function listChannels(tenantId: string) {
  return query<Channel & { last_sent_at: Date | null; last_error: string | null;
                           failure_count: number; is_active: boolean }>(
    `SELECT id, tenant_id, kind, label, destination, min_level,
            secret_ciphertext, secret_iv, secret_auth_tag, key_version,
            last_sent_at, last_error, failure_count, is_active
       FROM notify_channels
      WHERE tenant_id = $1
      ORDER BY created_at`,
    [tenantId],
  );
}

export async function addChannel(args: {
  tenantId: string; kind: string; label: string; destination: string;
  secret: string; minLevel: string;
}) {
  const sealed = seal(args.secret);
  await query(
    `INSERT INTO notify_channels
       (tenant_id, kind, label, destination, min_level,
        secret_ciphertext, secret_iv, secret_auth_tag, key_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [args.tenantId, args.kind, args.label, args.destination, args.minLevel,
     sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
}

export async function removeChannel(tenantId: string, id: string) {
  await query(`DELETE FROM notify_channels WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
}

/**
 * ส่งข้อความจริง
 *
 * NOTIFY_TRANSPORT=mock เขียนลงไฟล์แทนการยิงออกเน็ต — ใช้ตอนทดสอบและตอนเดโม่
 * เพื่อไม่ให้ระบบยิงข้อความจริงหาใครโดยไม่ได้ตั้งใจ
 */
async function deliver(ch: Channel, text: string): Promise<void> {
  if (env.notify.transport === 'mock') {
    const file = path.join(env.storageDir, 'sent-messages.json');
    let sent: unknown[] = [];
    try {
      sent = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { /* ยังไม่มีไฟล์ */ }
    sent.unshift({
      channelId: ch.id, kind: ch.kind, destination: ch.destination,
      text, sentAt: new Date().toISOString(),
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(sent.slice(0, 200), null, 2));
    return;
  }

  if (ch.kind === 'line') {
    if (!ch.secret_ciphertext || !ch.secret_iv || !ch.secret_auth_tag) {
      throw new Error('ช่องทาง LINE ยังไม่มี channel access token');
    }
    const token = open({
      ciphertext: ch.secret_ciphertext,
      iv: ch.secret_iv,
      authTag: ch.secret_auth_tag,
      keyVersion: ch.key_version,
    });

    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: ch.destination,
        messages: [{ type: 'text', text: text.slice(0, 4900) }],
      }),
    });
    if (!res.ok) {
      // ข้อความจาก LINE บอกสาเหตุตรงๆ (token ผิด / userId ไม่ถูก / เกินโควตาเดือน)
      throw new Error(`LINE ตอบกลับ ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return;
  }

  if (ch.kind === 'webhook') {
    const res = await fetch(ch.destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`webhook ตอบกลับ ${res.status}`);
    return;
  }

  throw new Error(`ไม่รู้จักช่องทาง "${ch.kind}"`);
}

function compose(n: { level: string; title: string; body: string | null }) {
  const mark = n.level === 'critical' ? '⚠️' : n.level === 'warning' ? '❗' : 'ℹ️';
  const lines = [`${mark} ${n.title}`];
  if (n.body) lines.push(n.body);
  lines.push('', `เปิดดู: ${env.publicBaseUrl}/alerts`);
  return lines.join('\n');
}

/**
 * ส่งแจ้งเตือนที่ยังไม่เคยส่งออก
 *
 * เรียกจาก worker ทุกรอบ ไม่ใช่ตอนสร้างแจ้งเตือน — เพราะการสร้างอยู่ใน transaction
 * ที่กำลังเขียนสถานะโพสต์ ถ้าไปยิง HTTP ตรงนั้นแล้ว LINE ช้า transaction จะค้างตาม
 */
export async function pushPendingNotifications(): Promise<number> {
  const pending = await query<{
    id: string; tenant_id: string; level: string; title: string; body: string | null;
  }>(
    `SELECT id, tenant_id, level, title, body
       FROM notifications
      WHERE pushed_at IS NULL
        AND created_at > now() - interval '1 day'   -- ของเก่ากว่านั้นส่งไปก็ไม่ทันการณ์
      ORDER BY created_at
      LIMIT 20`,
  );
  if (!pending.length) return 0;

  let sent = 0;
  for (const n of pending) {
    const channels = await query<Channel>(
      `SELECT id, tenant_id, kind, label, destination, min_level,
              secret_ciphertext, secret_iv, secret_auth_tag, key_version
         FROM notify_channels
        WHERE tenant_id = $1 AND is_active`,
      [n.tenant_id],
    );

    for (const ch of channels) {
      if ((LEVEL_RANK[n.level] ?? 0) < (LEVEL_RANK[ch.min_level] ?? 3)) continue;
      try {
        await deliver(ch, compose(n));
        await query(
          `UPDATE notify_channels
              SET last_sent_at = now(), last_error = NULL, failure_count = 0
            WHERE id = $1`,
          [ch.id],
        );
        sent++;
      } catch (err) {
        // ช่องทางส่งไม่ได้ต้องไม่ทำให้ทั้งรอบล้ม — บันทึกไว้แล้วไปต่อ
        await query(
          `UPDATE notify_channels
              SET last_error = $2, failure_count = failure_count + 1,
                  is_active = CASE WHEN failure_count >= 9 THEN false ELSE is_active END
            WHERE id = $1`,
          [ch.id, (err as Error).message.slice(0, 300)],
        );
      }
    }

    // ทำเครื่องหมายว่าส่งแล้วเสมอ แม้ไม่มีช่องทาง — ไม่งั้นคิวจะบวมและวนส่งซ้ำ
    await query(`UPDATE notifications SET pushed_at = now() WHERE id = $1`, [n.id]);
  }
  return sent;
}

/** ส่งข้อความทดสอบไปช่องทางเดียว — ให้คนกดปุ่มยืนยันได้ว่าตั้งค่าถูก */
export async function sendTest(tenantId: string, channelId: string) {
  const rows = await query<Channel>(
    `SELECT id, tenant_id, kind, label, destination, min_level,
            secret_ciphertext, secret_iv, secret_auth_tag, key_version
       FROM notify_channels WHERE tenant_id = $1 AND id = $2`,
    [tenantId, channelId],
  );
  if (!rows.length) throw new Error('ไม่พบช่องทางนี้');
  await deliver(rows[0], 'ทดสอบการแจ้งเตือนจากระบบตั้งเวลาโพสต์ — ถ้าเห็นข้อความนี้แปลว่าตั้งค่าถูกแล้ว');
  await query(
    `UPDATE notify_channels SET last_sent_at = now(), last_error = NULL, failure_count = 0
      WHERE id = $1`,
    [channelId],
  );
}
