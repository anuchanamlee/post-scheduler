'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { changePassword, requireRole, requireSession, signIn, signOut } from '../lib/auth.js';
import {
  cancelPost, createPost, duplicatePost, movePostToDay, publishDraft, retryFailedTargets,
  updatePost, MAX_MEDIA,
} from '../core/scheduler.js';
import { generateCaptions } from '../content/caption.js';
import { ingestImage, makeVariant, validateForInstagram, type Aspect } from '../content/media.js';
import { deleteAsset } from '../content/library.js';
import { normalizeTags, removeSet, saveSet } from '../content/hashtags.js';
import { one, query } from '../lib/db.js';
import { hashPassword } from '../lib/crypto.js';
import { addSlot, removeSlot } from '../core/slots.js';
import { addChannel, removeChannel, sendTest } from '../core/notify.js';
import {
  connectPage, disconnectPage, replaceToken, verifyConnection,
} from '../core/connections.js';
import {
  approve, needsApproval, reject, removeUser, setApprovalRequired, setRole,
  submitForApproval, type Role,
} from '../core/approval.js';
import { renderPoster, type PosterAspect, type PosterInput } from '../content/poster.js';


/** ทุก action ที่เปลี่ยนของจริงต้องบอกผลกลับ ไม่ใช่รีเฟรชเงียบๆ */
function backWith(code: string, to = '/', detail?: string): never {
  const q = new URLSearchParams({ flash: code });
  if (detail) q.set('detail', detail);
  redirect(`${to}${to.includes('?') ? '&' : '?'}${q.toString()}`);
}

/** error จาก action ที่ไม่มี useActionState ต้องกลับมาเป็นข้อความในหน้า ไม่ใช่หน้า error เต็มจอ */
async function guard(fn: () => Promise<string>, to = '/'): Promise<never> {
  let code: string;
  try {
    code = await fn();
  } catch (err) {
    backWith('failed', to, (err as Error).message);
  }
  backWith(code, to);
}

export async function loginAction(_prev: unknown, form: FormData) {
  try {
    await signIn(String(form.get('email') ?? ''), String(form.get('password') ?? ''));
  } catch (err) {
    return { error: (err as Error).message };
  }
  redirect('/');
}

export async function logoutAction() {
  await signOut();
  redirect('/login');
}

/** อัปโหลดรูปทั้งชุดที่ผู้ใช้เลือก คืน id ตามลำดับไฟล์ */
async function ingestFromForm(tenantId: string, form: FormData): Promise<string[]> {
  const files = form.getAll('image').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return [];
  if (files.length > MAX_MEDIA) {
    throw new Error(`ใส่รูปได้สูงสุด ${MAX_MEDIA} ใบต่อโพสต์ (ข้อจำกัดของ Instagram)`);
  }

  const pageIds = form.getAll('pages').map(String);
  const wantsInstagram = pageIds.length > 0 && (
    await query<{ n: string }>(
      `SELECT count(*) AS n FROM social_pages
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND platform = 'instagram'`,
      [tenantId, pageIds],
    )
  )[0].n !== '0';

  const ids: string[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const asset = await ingestImage({
      tenantId, buffer, mimeType: file.type || 'image/jpeg', originalName: file.name,
    });

    // ตรวจตั้งแต่ตอนอัปโหลด ไม่ใช่ให้ Meta ปฏิเสธตอนตี 2 (รายงานข้อ D7)
    if (wantsInstagram && validateForInstagram(asset.width, asset.height, buffer.length).length) {
      const v = await makeVariant({ tenantId, assetId: asset.id, aspect: '4:5' as Aspect });
      await query(
        `UPDATE media_assets SET public_url = $2, width = $3, height = $4 WHERE id = $1`,
        [asset.id, v.url, v.width, v.height],
      );
    }
    ids.push(asset.id);
  }
  return ids;
}

export async function createPostAction(_prev: unknown, form: FormData) {
  let created: string;
  let submitted = false;
  const again = form.get('intent') === 'save_and_new';
  try {
    const s = await requireSession();
    const uploaded = await ingestFromForm(s.tenantId, form);
    const assetIds = uploaded.length ? uploaded : form.getAll('assetId').map(String).filter(Boolean);
    if (!assetIds.length) return { error: 'ต้องเลือกรูปก่อนถึงจะบันทึกได้' };

    const scheduledAt = new Date(String(form.get('scheduledAt')));
    if (Number.isNaN(scheduledAt.getTime())) {
      return { error: 'ยังไม่ได้เลือกวันเวลาที่จะโพสต์' };
    }

    const post = await createPost({
      tenantId: s.tenantId,
      userId: s.userId,
      caption: String(form.get('caption') ?? ''),
      assetIds,
      scheduledAt,
      pageIds: form.getAll('pages').map(String),
      // ผู้เขียนที่ไม่มีสิทธิ์อนุมัติ งานต้องผ่านการตรวจก่อนเข้าคิว
      status: form.get('intent') === 'draft'
        ? 'draft'
        : (await needsApproval(s.tenantId, s.role)) ? 'pending_approval' : 'pending',
    });
    created = post.id;
    submitted = await needsApproval(s.tenantId, s.role);
    revalidatePath('/');
  } catch (err) {
    return { error: (err as Error).message };
  }

  // เตรียมโพสต์ทั้งสัปดาห์รวดเดียวได้ ไม่ต้องเข้าออกหน้าใหม่ทุกครั้ง
  if (again) redirect(`/new?saved=${created}`);
  backWith(
    form.get('intent') === 'draft' ? 'drafted' : (submitted ? 'submitted' : 'queued'),
    `/?post=${created}`,
  );
}

export async function updatePostAction(_prev: unknown, form: FormData) {
  const postId = String(form.get('postId'));
  try {
    const s = await requireSession();
    const uploaded = await ingestFromForm(s.tenantId, form);
    const kept = form.getAll('assetId').map(String).filter(Boolean);
    const scheduledAt = new Date(String(form.get('scheduledAt')));

    await updatePost(s.tenantId, postId, {
      caption: String(form.get('caption') ?? ''),
      scheduledAt: Number.isNaN(scheduledAt.getTime()) ? undefined : scheduledAt,
      // อัปใหม่ = แทนที่ทั้งชุด · ไม่อัป = ใช้ชุดเดิมที่ฟอร์มส่งกลับมา
      assetIds: uploaded.length ? uploaded : (kept.length ? kept : undefined),
      pageIds: form.getAll('pages').map(String),
    });
    if (form.get('intent') === 'queue') await publishDraft(s.tenantId, postId);
    revalidatePath('/');
  } catch (err) {
    return { error: (err as Error).message };
  }
  backWith('saved', `/?post=${postId}`);
}

/** ทำซ้ำโพสต์ประจำ — เปิดสำเนาเป็นร่างให้แก้ก่อนเข้าคิว */
export async function duplicatePostAction(form: FormData) {
  const s = await requireSession();
  const when = new Date(Date.now() + 24 * 3600_000);
  const copy = await duplicatePost(s.tenantId, String(form.get('postId')), when);
  backWith('duplicated', `/post/${copy.id}`);
}

export async function draftCaptionAction(_prev: unknown, form: FormData) {
  try {
    const s = await requireSession();
    const result = await generateCaptions({
      tenantId: s.tenantId,
      pageId: String(form.get('pageId')),
      topic: String(form.get('topic') ?? ''),
      userId: s.userId,
    });
    return {
      options: result.options,
      suggestedTags: result.suggestedTags,
      model: result.model,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function cancelPostAction(form: FormData) {
  const s = await requireSession();
  const postId = String(form.get('postId'));
  return guard(async () => {
    await cancelPost(s.tenantId, postId);
    revalidatePath('/');
    return 'cancelled';
  });
}

export async function retryPostAction(form: FormData) {
  const s = await requireSession();
  const postId = String(form.get('postId'));
  return guard(async () => {
    const n = await retryFailedTargets(s.tenantId, postId);
    revalidatePath('/');
    return n > 0 ? 'retried' : 'nothing';
  }, `/?post=${postId}`);
}

export async function postNowAction(form: FormData) {
  const s = await requireSession();
  const postId = String(form.get('postId'));
  await query(
    `UPDATE scheduled_posts SET scheduled_at = now(), status = 'pending', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status IN ('missed', 'pending')`,
    [s.tenantId, postId],
  );
  await query(
    `UPDATE post_targets SET status = 'pending', next_attempt_at = NULL, attempt_count = 0,
            error_code = NULL, error_message = NULL, updated_at = now()
      WHERE tenant_id = $1 AND post_id = $2 AND status IN ('skipped', 'failed', 'pending')`,
    [s.tenantId, postId],
  );
  revalidatePath('/');
  backWith('posting', `/?post=${postId}`);
}

export async function saveBrandVoiceAction(form: FormData) {
  const s = await requireSession();
  const pageId = String(form.get('pageId'));

  const lines = (v: FormDataEntryValue | null) =>
    String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const commas = (v: FormDataEntryValue | null) =>
    String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  // ผูกกับเพจ ไม่ใช่กับลูกค้า — FB กับ IG คนละโทน (รายงานข้อ C5)
  await query(
    `INSERT INTO brand_voice_profiles
       (tenant_id, page_id, tone_description, example_captions, keywords_include, keywords_avoid)
     SELECT $1, sp.id, $3, $4::text[], $5::text[], $6::text[]
       FROM social_pages sp WHERE sp.id = $2 AND sp.tenant_id = $1
     ON CONFLICT (page_id) DO UPDATE
       SET tone_description = EXCLUDED.tone_description,
           example_captions = EXCLUDED.example_captions,
           keywords_include = EXCLUDED.keywords_include,
           keywords_avoid   = EXCLUDED.keywords_avoid,
           updated_at = now()`,
    [s.tenantId, pageId, String(form.get('tone') ?? ''), lines(form.get('examples')),
     commas(form.get('include')), commas(form.get('avoid'))],
  );
  revalidatePath('/settings');
  backWith('voice_saved', '/settings');
}

/** ปิดแจ้งเตือนทีละใบ ไม่ใช่ล้างทั้งกองพร้อมกัน */
export async function dismissNotificationAction(form: FormData) {
  const s = await requireSession();
  await query(
    `UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND id = $2 AND read_at IS NULL`,
    [s.tenantId, String(form.get('id'))],
  );
  revalidatePath('/');
  revalidatePath('/alerts');
  backWith('read', String(form.get('back') ?? '/'));
}

/** ตารางเวลาประจำ — ตั้งครั้งเดียวแล้วโพสต์ใหม่ไหลลงช่องว่างถัดไปเอง */
export async function addSlotAction(form: FormData) {
  const s = await requireSession();
  const days = form.getAll('weekday').map((d) => Number(d));
  const time = String(form.get('time') ?? '09:00');
  return guard(async () => {
    if (!days.length) throw new Error('เลือกวันอย่างน้อย 1 วัน');
    for (const d of days) await addSlot(s.tenantId, d, time);
    revalidatePath('/settings');
    return 'slot_added';
  }, '/settings');
}

export async function removeSlotAction(form: FormData) {
  const s = await requireSession();
  await removeSlot(s.tenantId, String(form.get('id')));
  revalidatePath('/settings');
  backWith('slot_removed', '/settings');
}

/**
 * ประกอบโปสเตอร์จากเทมเพลต + รูปสินค้าจริง
 * ผลลัพธ์เป็น media_asset ปกติ จึงเอาไปเข้าคิวโพสต์ได้ทันทีโดยไม่ต้องแปลงอะไร
 */
export async function makePosterAction(_prev: unknown, form: FormData) {
  let url: string;
  let assetId: string;
  try {
    const s = await requireSession();

    // รูปสินค้าเป็นตัวเลือก — โปสเตอร์ข้อความล้วนก็ใช้ได้
    // รูปที่เลือกไว้แล้ว (ภาพ AI ที่เพิ่งสร้าง หรือรูปจากคลัง) มาทาง photoAssetId
    // ไฟล์ที่เพิ่งอัปโหลดชนะเสมอ เพราะเป็นสิ่งที่คนเพิ่งทำล่าสุด
    let photoAssetId: string | null = String(form.get('photoAssetId') ?? '') || null;
    if (photoAssetId) {
      const owned = await one<{ id: string }>(
        `SELECT id FROM media_assets WHERE id = $1 AND tenant_id = $2 AND status = 'ready'`,
        [photoAssetId, s.tenantId],
      );
      if (!owned) return { error: 'ไม่พบรูปที่เลือกไว้' };
    }
    const photo = form.get('photo');
    if (photo instanceof File && photo.size > 0) {
      const asset = await ingestImage({
        tenantId: s.tenantId,
        buffer: Buffer.from(await photo.arrayBuffer()),
        mimeType: photo.type || 'image/jpeg',
        originalName: photo.name,
      });
      photoAssetId = asset.id;
    }

    const text = (k: string) => {
      const v = String(form.get(k) ?? '').trim();
      return v.length ? v : undefined;
    };
    const headline = text('headline');
    if (!headline) return { error: 'ต้องมีข้อความหลักอย่างน้อย 1 บรรทัด' };

    const input: PosterInput = {
      headline,
      subline: text('subline'),
      price: text('price'),
      oldPrice: text('oldPrice'),
      note: text('note'),
      brand: text('brand'),
    };

    const result = await renderPoster({
      tenantId: s.tenantId,
      templateId: String(form.get('templateId') ?? 'sale'),
      aspect: (String(form.get('aspect') ?? '4:5') as PosterAspect),
      input,
      photoAssetId,
    });
    url = result.url;
    assetId = result.assetId;
    revalidatePath('/poster');
  } catch (err) {
    return { error: (err as Error).message };
  }
  redirect(`/poster?made=${encodeURIComponent(url)}&asset=${assetId}&flash=poster_made`);
}

/** ช่องทางแจ้งเตือนออกนอกแอป — LINE Messaging API (LINE Notify ปิดบริการแล้ว) */
export async function addChannelAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    const destination = String(form.get('destination') ?? '').trim();
    const secret = String(form.get('secret') ?? '').trim();
    if (!destination) throw new Error('ต้องใส่ปลายทาง (userId หรือ groupId ของ LINE)');
    if (!secret) throw new Error('ต้องใส่ channel access token');

    await addChannel({
      tenantId: s.tenantId,
      kind: String(form.get('kind') ?? 'line'),
      label: String(form.get('label') ?? '').trim() || 'LINE',
      destination,
      secret,
      minLevel: String(form.get('minLevel') ?? 'critical'),
    });
    revalidatePath('/settings');
    return 'channel_added';
  }, '/settings');
}

export async function removeChannelAction(form: FormData) {
  const s = await requireRole('owner');
  await removeChannel(s.tenantId, String(form.get('id')));
  revalidatePath('/settings');
  backWith('channel_removed', '/settings');
}

export async function testChannelAction(form: FormData) {
  const s = await requireSession();
  const id = String(form.get('id'));
  return guard(async () => {
    await sendTest(s.tenantId, id);
    revalidatePath('/settings');
    return 'channel_tested';
  }, '/settings');
}

// ── ขั้นตอนอนุมัติ ───────────────────────────────────────────

export async function approveAction(form: FormData) {
  const s = await requireRole('owner', 'approver');
  const postId = String(form.get('postId'));
  return guard(async () => {
    const r = await approve(s.tenantId, postId, s.userId);
    revalidatePath('/');
    revalidatePath('/approvals');
    return r.late ? 'approved_late' : 'approved';
  }, '/approvals');
}

export async function rejectAction(form: FormData) {
  const s = await requireRole('owner', 'approver');
  const postId = String(form.get('postId'));
  const reason = String(form.get('reason') ?? '');
  return guard(async () => {
    await reject(s.tenantId, postId, s.userId, reason);
    revalidatePath('/');
    revalidatePath('/approvals');
    return 'rejected';
  }, '/approvals');
}

export async function submitForApprovalAction(form: FormData) {
  const s = await requireSession();
  const postId = String(form.get('postId'));
  return guard(async () => {
    await submitForApproval(s.tenantId, postId);
    revalidatePath('/');
    return 'submitted';
  }, `/?post=${postId}`);
}

export async function toggleApprovalAction(form: FormData) {
  const s = await requireRole('owner');
  const on = form.get('on') === '1';
  return guard(async () => {
    await setApprovalRequired(s.tenantId, on);
    revalidatePath('/settings');
    return on ? 'approval_on' : 'approval_off';
  }, '/settings');
}

// ── จัดการผู้ใช้ ─────────────────────────────────────────────

export async function setRoleAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    await setRole(s.tenantId, String(form.get('userId')),
                  String(form.get('role')) as Role, s.userId);
    revalidatePath('/settings');
    return 'role_changed';
  }, '/settings');
}

export async function addUserAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    const email = String(form.get('email') ?? '').toLowerCase().trim();
    const password = String(form.get('password') ?? '');
    if (!email.includes('@')) throw new Error('อีเมลไม่ถูกต้อง');
    if (password.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');

    const exists = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    if (exists.length) throw new Error('อีเมลนี้ถูกใช้แล้ว');

    await query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
      [s.tenantId, email, hashPassword(password), String(form.get('role') ?? 'editor')],
    );
    revalidatePath('/settings');
    return 'user_added';
  }, '/settings');
}

/** เปลี่ยนรหัสผ่านตัวเอง — ทุกบทบาททำได้ ไม่ต้องรอเจ้าของ */
export async function changePasswordAction(form: FormData) {
  const s = await requireSession();
  return guard(async () => {
    await changePassword(
      s.userId,
      String(form.get('current') ?? ''),
      String(form.get('next') ?? ''),
    );
    return 'password_changed';
  }, '/settings');
}

export async function removeUserAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    await removeUser(s.tenantId, String(form.get('userId')), s.userId);
    revalidatePath('/settings');
    return 'user_removed';
  }, '/settings');
}

// ── คลังรูป ─────────────────────────────────────────────────

/** ครอปตามจุดที่คนเลือกเอง แล้วพากลับมาดูผล */
export async function cropAction(_prev: unknown, form: FormData) {
  const s = await requireSession();
  const assetId = String(form.get('assetId'));
  try {
    const x = Number(form.get('focusX'));
    const y = Number(form.get('focusY'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('จุดโฟกัสไม่ถูกต้อง');

    await makeVariant({
      tenantId: s.tenantId,
      assetId,
      aspect: String(form.get('aspect') ?? '1:1') as Aspect,
      focus: { x, y },
    });
    revalidatePath(`/crop/${assetId}`);
    revalidatePath('/library');
  } catch (err) {
    return { error: (err as Error).message };
  }
  redirect(`/crop/${assetId}?flash=cropped`);
}

export async function deleteAssetAction(form: FormData) {
  const s = await requireSession();
  return guard(async () => {
    await deleteAsset(s.tenantId, String(form.get('assetId')));
    revalidatePath('/library');
    return 'asset_deleted';
  }, '/library');
}

// ── แฮชแท็ก ─────────────────────────────────────────────────

export async function saveHashtagSetAction(form: FormData) {
  const s = await requireSession();
  return guard(async () => {
    await saveSet({
      tenantId: s.tenantId,
      id: String(form.get('id') ?? '') || undefined,
      name: String(form.get('name') ?? ''),
      tags: normalizeTags(String(form.get('tags') ?? '')),
      isDefault: form.get('isDefault') === '1',
    });
    revalidatePath('/settings');
    revalidatePath('/new');
    return 'tags_saved';
  }, '/settings');
}

export async function removeHashtagSetAction(form: FormData) {
  const s = await requireSession();
  await removeSet(s.tenantId, String(form.get('id')));
  revalidatePath('/settings');
  backWith('tags_removed', '/settings');
}

/** ลากเลื่อนวันในปฏิทิน — คงเวลาในวันไว้เท่าเดิม */
export async function movePostAction(form: FormData) {
  const s = await requireSession();
  const day = String(form.get('day') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('วันที่ไม่ถูกต้อง');

  const r = await movePostToDay(s.tenantId, String(form.get('postId')), day);
  revalidatePath('/');
  return { moved: true, past: r.past };
}

// ── การเชื่อมต่อเพจ ─────────────────────────────────────────

export async function connectPageAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    await connectPage({
      tenantId: s.tenantId,
      platform: String(form.get('platform') ?? 'facebook') as 'facebook' | 'instagram',
      remoteId: String(form.get('remoteId') ?? ''),
      displayName: String(form.get('displayName') ?? ''),
      token: String(form.get('token') ?? ''),
      appId: String(form.get('appId') ?? '') || undefined,
    });
    revalidatePath('/settings');
    return 'page_connected';
  }, '/settings');
}

export async function replaceTokenAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    await replaceToken(s.tenantId, String(form.get('pageId')), String(form.get('token') ?? ''));
    revalidatePath('/settings');
    return 'token_replaced';
  }, '/settings');
}

export async function verifyConnectionAction(form: FormData) {
  const s = await requireRole('owner');
  const pageId = String(form.get('pageId'));
  return guard(async () => {
    const r = await verifyConnection(s.tenantId, pageId);
    revalidatePath('/settings');
    revalidatePath('/');
    if (!r.ok) throw new Error(r.message ?? 'token ใช้งานไม่ได้');
    return 'connection_ok';
  }, '/settings');
}

export async function disconnectPageAction(form: FormData) {
  const s = await requireRole('owner');
  return guard(async () => {
    await disconnectPage(s.tenantId, String(form.get('pageId')));
    revalidatePath('/settings');
    return 'page_disconnected';
  }, '/settings');
}

export async function markNotificationsRead() {
  const s = await requireSession();
  await query(`UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND read_at IS NULL`, [
    s.tenantId,
  ]);
  revalidatePath('/');
  revalidatePath('/alerts');
  backWith('read', '/alerts');
}
