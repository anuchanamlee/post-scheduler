import { query } from '../lib/db.js';
import { env } from '../lib/env.js';
import { pushPendingNotifications } from './notify.js';
import { instagramQuota } from './quota.js';
import { runRetention, shouldRunRetention } from './retention.js';
import { collectDue } from './metrics.js';
import { getProvider } from '../providers/index.js';
import { ProviderError, backoffMs, isRetryable } from '../providers/errors.js';
import { withMarker } from '../providers/meta/index.js';
import type { PublishRequest } from '../providers/types.js';
import {
  claimDueTargets,
  finishTarget,
  heartbeat,
  logApiCall,
  markMissed,
  reclaimStaleLocks,
  saveContainer,
  appendChildContainer,
  type ClaimedTarget,
} from './queue.js';

/**
 * ชั้น "คนโพสต์" — ไม่รู้จักคอนเทนต์ ไม่รู้ว่าแคปชั่นมาจากคนหรือ AI
 * รับแค่แถวในคิวที่ถึงเวลา แล้วพยายามส่งให้ปลายทางให้สำเร็จ
 */

export async function runPublishCycle(workerId: string) {
  const stats = { claimed: 0, succeeded: 0, failed: 0, deferred: 0 };

  await reclaimStaleLocks();
  await markMissed();

  const targets = await claimDueTargets(workerId);
  stats.claimed = targets.length;

  // เช็คโควตา IG ครั้งเดียวต่อรอบต่อลูกค้า ไม่ใช่ต่อโพสต์ — เลขไม่เปลี่ยนระหว่างรอบ
  const igQuota = new Map<string, Awaited<ReturnType<typeof instagramQuota>>>();

  for (const t of targets) {
    try {
      if (t.platform === 'instagram') {
        if (!igQuota.has(t.tenant_id)) {
          igQuota.set(t.tenant_id, await instagramQuota(t.tenant_id));
        }
        const q = igQuota.get(t.tenant_id)!;
        if (q.exhausted) {
          // เลื่อนไปรอจนช่องว่าง แทนที่จะยิงแล้วโดนปฏิเสธ
          // ไม่นับเป็น attempt ที่ล้มเหลว เพราะไม่มีอะไรผิดที่ตัวโพสต์
          await deferForQuota(t, q.freesAt);
          stats.deferred++;
          continue;
        }
        // จองช่องล่วงหน้าในรอบนี้ กันหลายโพสต์ในรอบเดียวกันทะลุเพดานพร้อมกัน
        q.used++;
        q.remaining--;
        q.exhausted = q.remaining <= 0;
      }

      const ok = await publishOne(t);
      ok ? stats.succeeded++ : stats.failed++;
    } catch (err) {
      stats.failed++;
      await finishTarget(t.target_id, {
        kind: 'failed',
        message: `ข้อผิดพลาดที่ไม่คาดคิด: ${(err as Error).message}`,
      });
    }
  }

  // ส่งแจ้งเตือนที่ค้างออกนอกแอป ทำนอก transaction ของการโพสต์โดยตั้งใจ
  // ถ้าไปยิง HTTP ตอนเขียนสถานะ แล้ว LINE ช้า จะลาก transaction ค้างตามไปด้วย
  try {
    await pushPendingNotifications();
  } catch (err) {
    console.error('[worker] ส่งแจ้งเตือนออกไม่สำเร็จ:', (err as Error).message);
  }

  // เก็บสถิติของโพสต์ที่ถึงช่วงเวลาเก็บแล้ว — ทำหลังส่งโพสต์เสร็จ
  try {
    const got = await collectDue();
    if (got > 0) console.log(`[worker] เก็บสถิติ ${got} รายการ`);
  } catch (err) {
    console.error('[worker] เก็บสถิติไม่สำเร็จ:', (err as Error).message);
  }

  /**
   * ล้าง log เก่าวันละครั้ง — ทำหลังส่งโพสต์เสร็จเสมอ
   * งานบ้านต้องไม่มาก่อนงานที่ลูกค้าจ่ายเงินให้ทำ
   */
  if (await shouldRunRetention()) {
    try {
      const purged = await runRetention();
      const total = Object.values(purged).reduce((a, b) => a + b, 0);
      await heartbeat('retention', {
        claimed: 0, succeeded: total, failed: 0, ok: true,
        note: Object.entries(purged).filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}:${n}`).join(' ') || 'ไม่มีอะไรให้ล้าง',
      });
      if (total > 0) console.log(`[worker] ล้าง log เก่า ${total} แถว`);
    } catch (err) {
      console.error('[worker] ล้าง log ไม่สำเร็จ:', (err as Error).message);
    }
  }

  await heartbeat('publish', {
    ...stats,
    ok: true,
    note: stats.deferred ? `เลื่อนเพราะโควตา IG เต็ม ${stats.deferred} รายการ` : undefined,
  });

  /**
   * บอกโลกภายนอกว่ายังมีชีวิต — worker ที่ตายแล้วส่งแจ้งเตือนบอกว่าตัวเองตายไม่ได้
   * ต้องให้บริการภายนอกเป็นคนสังเกตว่า "ปิงหายไป" แทน
   */
  if (env.notify.heartbeatUrl) {
    try {
      await fetch(env.notify.heartbeatUrl, { signal: AbortSignal.timeout(5000) });
    } catch { /* ปิงไม่ถึงก็ไม่ควรทำให้รอบพัง */ }
  }

  return stats;
}

/**
 * เลื่อนโพสต์ที่ติดโควตา — คืน lock แล้วตั้งเวลาลองใหม่ตอนช่องว่าง
 * ไม่แตะ attempt_count เพราะโพสต์ไม่ได้ผิดอะไร แค่ยังไม่ถึงคิว
 */
async function deferForQuota(t: ClaimedTarget, freesAt: Date | null) {
  const retryAt = freesAt ?? new Date(Date.now() + 30 * 60_000);
  await query(
    `UPDATE post_targets
        SET status = 'pending', locked_until = NULL, locked_by = NULL,
            attempt_count = GREATEST(0, attempt_count - 1),
            next_attempt_at = $2,
            error_message = $3,
            updated_at = now()
      WHERE id = $1`,
    [t.target_id, retryAt,
     `โควตา Instagram 24 ชั่วโมงเต็ม — จะลองใหม่อัตโนมัติเมื่อมีช่องว่าง`],
  );
  await logApiCall({
    tenantId: t.tenant_id,
    targetId: t.target_id,
    provider: t.provider,
    operation: 'instagram.quota_deferred',
    meta: { retryAt: retryAt.toISOString() },
  });
}

async function publishOne(t: ClaimedTarget): Promise<boolean> {
  // รูปต้องพร้อมก่อนถึงเวลา ถ้าไม่พร้อมคือปัญหาที่ควรถูกจับตั้งแต่ตอนบันทึก (รายงานข้อ D6)
  if (t.image_urls.length === 0 || !t.assets_ready) {
    await finishTarget(t.target_id, {
      kind: 'failed',
      message: 'รูปยังไม่พร้อมใช้งานตอนถึงเวลาโพสต์',
    });
    return false;
  }

  const provider = getProvider(t.provider);
  const req: PublishRequest = {
    tenantId: t.tenant_id,
    targetId: t.target_id,
    page: {
      id: t.page_id,
      platform: t.platform,
      provider: t.provider,
      remoteId: t.remote_page_id,
      displayName: t.page_name,
      timezone: t.page_timezone,
    },
    caption: withMarker(t.caption, t.idempotency_key),
    imageUrls: t.image_urls,
    idempotencyKey: t.idempotency_key,
    existingContainerId: t.container_id,
    containerExpiresAt: t.container_expires_at,
    existingChildIds: t.child_container_ids,
  };

  /**
   * ก่อน retry ต้องถามปลายทางก่อนว่าโพสต์นี้ขึ้นไปแล้วหรือยัง (รายงานข้อ D2)
   * เคสจริง: publish สำเร็จ แต่ตอบกลับ timeout — retry ตาบอด = ลูกค้าเห็นโพสต์ซ้ำบนเพจ
   */
  if (t.attempt_count > 1) {
    try {
      const existing = await provider.findExisting(req);
      if (existing) {
        await logApiCall({
          tenantId: t.tenant_id,
          targetId: t.target_id,
          provider: provider.name,
          operation: 'idempotency.hit',
          meta: { remoteId: existing.remoteId },
        });
        await finishTarget(t.target_id, { kind: 'posted', ...existing });
        return true;
      }
    } catch {
      // ตรวจไม่ได้ก็ไปต่อ — ยังดีกว่าค้างคิวถาวร
    }
  }

  try {
    const result = await provider.publish(req, {
      onContainer: (id, exp) => saveContainer(t.target_id, id, exp),
      onChildContainer: (childId) => appendChildContainer(t.target_id, childId),
      log: (e) =>
        logApiCall({
          tenantId: t.tenant_id,
          targetId: t.target_id,
          provider: provider.name,
          ...e,
          errorMessage: e.errorMessage,
        }),
    });
    await finishTarget(t.target_id, { kind: 'posted', ...result });
    return true;
  } catch (err) {
    const c = err instanceof ProviderError
      ? err.classified
      : { class: 'unknown' as const, message: (err as Error).message };

    await logApiCall({
      tenantId: t.tenant_id,
      targetId: t.target_id,
      provider: provider.name,
      operation: `${t.platform}.publish.error`,
      errorCode: c.code,
      errorMessage: c.message,
    });

    // token ใช้ไม่ได้ = ปัญหาระดับลูกค้า ไม่ใช่ระดับโพสต์ (รายงานข้อ A3/E3)
    if (c.class === 'credential') {
      await flagCredential(t, c.code, c.message);
      await finishTarget(t.target_id, { kind: 'failed', code: c.code, message: c.message });
      return false;
    }

    if (isRetryable(c)) {
      await finishTarget(t.target_id, {
        kind: 'retry',
        retryAfterMs: c.retryAfterMs ?? backoffMs(t.attempt_count),
        code: c.code,
        message: c.message,
      });
      return false;
    }

    await finishTarget(t.target_id, { kind: 'failed', code: c.code, message: c.message });
    return false;
  }
}

async function flagCredential(t: ClaimedTarget, code: number | undefined, message: string) {
  await query(
    `UPDATE meta_credentials c
        SET status = 'invalid', last_checked_at = now(),
            last_error_code = $2, last_error_message = $3, updated_at = now()
       FROM page_credentials pc
      WHERE pc.credential_id = c.id AND pc.page_id = $1`,
    [t.page_id, code ?? null, message],
  );
  await query(
    `INSERT INTO notifications (tenant_id, level, title, body, post_id)
     VALUES ($1, 'critical', 'การเชื่อมต่อกับ Meta ใช้งานไม่ได้',
             $2, $3)`,
    [
      t.tenant_id,
      `เพจ ${t.page_name}: ${message} — โพสต์ที่เหลือในคิวจะไม่ถูกส่งจนกว่าจะสร้าง System User token ใหม่`,
      t.post_id,
    ],
  );
}
