import { env } from '../../lib/env.js';
import { ProviderError } from '../errors.js';
import type {
  CredentialResolver,
  PublishHooks,
  PublishProvider,
  PublishRequest,
  PublishResult,
  TargetPage,
  Platform,
} from '../types.js';
import { graph } from './client.js';

/**
 * Provider ของ Meta — ครอบทั้ง Facebook Page และ Instagram
 *
 * Facebook: 1 call (POST /{page-id}/photos)
 * Instagram: 2 เฟส (POST /{ig-user-id}/media → poll → POST /{ig-user-id}/media_publish)
 *
 * ทุก call ใช้ System User token ที่ผูกกับเพจนั้น — resolver เป็นคนถอดรหัสให้
 */
export class MetaProvider implements PublishProvider {
  readonly name = 'meta';
  private resolveToken: CredentialResolver;
  private appSecret?: string;

  constructor(resolveToken: CredentialResolver, appSecret?: string) {
    this.resolveToken = resolveToken;
    this.appSecret = appSecret;
  }

  supports(platform: Platform): boolean {
    return platform === 'facebook' || platform === 'instagram';
  }

  async publish(req: PublishRequest, hooks?: PublishHooks): Promise<PublishResult> {
    const token = await this.resolveToken(req.page);
    return req.page.platform === 'facebook'
      ? this.publishFacebook(req, token, hooks)
      : this.publishInstagram(req, token, hooks);
  }

  // ── Facebook ──────────────────────────────────────────────
  private async publishFacebook(
    req: PublishRequest,
    token: string,
    hooks?: PublishHooks,
  ): Promise<PublishResult> {
    const started = Date.now();

    // รูปเดียว: ยิงตรงไปที่ /photos จบในครั้งเดียว
    if (req.imageUrls.length === 1) {
      const { body } = await graph<{ id: string; post_id?: string }>({
        path: `${req.page.remoteId}/photos`,
        method: 'POST',
        token,
        appSecret: this.appSecret,
        params: { url: req.imageUrls[0], caption: req.caption, published: 'true' },
      });
      await hooks?.log?.({
        operation: 'facebook.photos', httpStatus: 200, durationMs: Date.now() - started,
      });
      const remoteId = body.post_id ?? body.id;
      return { remoteId, permalink: `https://facebook.com/${remoteId}` };
    }

    /**
     * หลายรูป: Facebook ไม่มี endpoint เดียวที่รับหลายรูปพร้อมแคปชั่น
     * ต้องอัปทีละใบแบบ published=false (รูปจะยังไม่โผล่บนเพจ) แล้วเอา id
     * ทั้งหมดผูกเข้าโพสต์เดียวผ่าน attached_media ตอนยิง /feed
     */
    const photoIds: string[] = [];
    for (const url of req.imageUrls) {
      const { body } = await graph<{ id: string }>({
        path: `${req.page.remoteId}/photos`,
        method: 'POST',
        token,
        appSecret: this.appSecret,
        params: { url, published: 'false' },
      });
      photoIds.push(body.id);
      await hooks?.onChildContainer?.(body.id);
      await hooks?.log?.({ operation: 'facebook.photo_unpublished', meta: { id: body.id } });
    }

    const attached = Object.fromEntries(
      photoIds.map((id, i) => [`attached_media[${i}]`, JSON.stringify({ media_fbid: id })]),
    );
    const { body } = await graph<{ id: string }>({
      path: `${req.page.remoteId}/feed`,
      method: 'POST',
      token,
      appSecret: this.appSecret,
      params: { message: req.caption, ...attached },
    });
    await hooks?.log?.({
      operation: 'facebook.feed_carousel', httpStatus: 200,
      durationMs: Date.now() - started, meta: { photos: photoIds.length },
    });
    return { remoteId: body.id, permalink: `https://facebook.com/${body.id}` };
  }

  // ── Instagram ─────────────────────────────────────────────
  private async publishInstagram(
    req: PublishRequest,
    token: string,
    hooks?: PublishHooks,
  ): Promise<PublishResult> {
    let containerId = req.existingContainerId ?? null;

    // container หมดอายุ 24 ชม. — ของเก่าที่หมดอายุต้องสร้างใหม่ ไม่ใช่ publish ทับ (รายงานข้อ D5)
    if (containerId && req.containerExpiresAt && req.containerExpiresAt.getTime() < Date.now()) {
      containerId = null;
    }

    if (!containerId) {
      containerId = req.imageUrls.length === 1
        ? await this.createSingleContainer(req, token, hooks)
        : await this.createCarouselContainer(req, token, hooks);
      // บันทึกทันที: ถ้า process ตายตรงนี้ รอบหน้าจะใช้ container เดิมต่อ ไม่สร้างซ้ำ
      await hooks?.onContainer?.(containerId, new Date(Date.now() + 24 * 3600_000));
    }

    await this.waitForContainer(containerId, token, hooks);

    const started = Date.now();
    const { body } = await graph<{ id: string }>({
      path: `${req.page.remoteId}/media_publish`,
      method: 'POST',
      token,
      appSecret: this.appSecret,
      params: { creation_id: containerId },
    });
    await hooks?.log?.({
      operation: 'instagram.media_publish', httpStatus: 200, durationMs: Date.now() - started,
    });
    return { remoteId: body.id, permalink: `https://www.instagram.com/p/${body.id}` };
  }

  private async createSingleContainer(
    req: PublishRequest, token: string, hooks?: PublishHooks,
  ): Promise<string> {
    const started = Date.now();
    const { body } = await graph<{ id: string }>({
      path: `${req.page.remoteId}/media`,
      method: 'POST',
      token,
      appSecret: this.appSecret,
      params: { image_url: req.imageUrls[0], caption: req.caption },
    });
    await hooks?.log?.({
      operation: 'instagram.media', httpStatus: 200,
      durationMs: Date.now() - started, meta: { containerId: body.id },
    });
    return body.id;
  }

  /**
   * carousel ของ Instagram เป็น 2 ชั้น
   *   1. container ลูกใบละรูป (is_carousel_item=true) — ไม่มีแคปชั่น
   *   2. container แม่ (media_type=CAROUSEL) ที่ถือ children ทั้งหมด + แคปชั่น
   *
   * ลูกที่สร้างไปแล้วถูกบันทึกทีละใบ เพราะถ้า process ตายตอนสร้างใบที่ 7
   * รอบหน้าจะได้ไม่สร้าง 6 ใบแรกซ้ำ (แต่ละใบคือ 1 API call ที่กินโควตา)
   */
  private async createCarouselContainer(
    req: PublishRequest, token: string, hooks?: PublishHooks,
  ): Promise<string> {
    const started = Date.now();
    const children = [...(req.existingChildIds ?? [])];

    for (const url of req.imageUrls.slice(children.length)) {
      const { body } = await graph<{ id: string }>({
        path: `${req.page.remoteId}/media`,
        method: 'POST',
        token,
        appSecret: this.appSecret,
        params: { image_url: url, is_carousel_item: 'true' },
      });
      children.push(body.id);
      await hooks?.onChildContainer?.(body.id);
      await hooks?.log?.({ operation: 'instagram.carousel_item', meta: { id: body.id } });
    }

    const { body } = await graph<{ id: string }>({
      path: `${req.page.remoteId}/media`,
      method: 'POST',
      token,
      appSecret: this.appSecret,
      params: {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption: req.caption,
      },
    });
    await hooks?.log?.({
      operation: 'instagram.carousel_container', httpStatus: 200,
      durationMs: Date.now() - started, meta: { children: children.length },
    });
    return body.id;
  }

  /** Meta แนะนำ poll นาทีละครั้ง ไม่เกิน 5 นาที (รายงานข้อ A4/D1) */
  private async waitForContainer(
    containerId: string,
    token: string,
    hooks?: PublishHooks,
  ): Promise<void> {
    const deadline = Date.now() + env.meta.containerPollMaxMs;

    for (;;) {
      const { body } = await graph<{ status_code?: string; status?: string }>({
        path: containerId,
        token,
        appSecret: this.appSecret,
        params: { fields: 'status_code,status' },
      });
      const code = body.status_code ?? 'IN_PROGRESS';
      await hooks?.log?.({ operation: 'instagram.container_status', meta: { code } });

      if (code === 'FINISHED') return;
      if (code === 'ERROR') {
        throw new ProviderError({
          class: 'permanent',
          message: `Instagram สร้าง container ไม่สำเร็จ: ${body.status ?? 'ไม่ระบุสาเหตุ'}`,
        });
      }
      if (code === 'EXPIRED') {
        throw new ProviderError({
          class: 'retryable',
          message: 'container หมดอายุก่อน publish — ต้องสร้างใหม่',
          retryAfterMs: 5_000,
        });
      }
      if (Date.now() > deadline) {
        throw new ProviderError({
          class: 'retryable',
          message: 'container ยังไม่พร้อมภายใน 5 นาที',
          retryAfterMs: 5 * 60_000,
        });
      }
      await new Promise((r) => setTimeout(r, env.meta.containerPollIntervalMs));
    }
  }

  /**
   * ถามปลายทางว่าโพสต์นี้ขึ้นไปแล้วหรือยัง ก่อนจะ retry (รายงานข้อ D2)
   * ใช้ caption ที่มี idempotency key ฝังอยู่ (zero-width marker) เป็นตัวจับคู่
   */
  async findExisting(req: PublishRequest): Promise<PublishResult | null> {
    const token = await this.resolveToken(req.page);
    const marker = idempotencyMarker(req.idempotencyKey);

    if (req.page.platform === 'instagram') {
      const { body } = await graph<{ data?: Array<{ id: string; caption?: string; permalink?: string }> }>({
        path: `${req.page.remoteId}/media`,
        token,
        appSecret: this.appSecret,
        params: { fields: 'id,caption,permalink', limit: 25 },
      });
      const hit = body.data?.find((m) => m.caption?.includes(marker));
      return hit ? { remoteId: hit.id, permalink: hit.permalink } : null;
    }

    const { body } = await graph<{ data?: Array<{ id: string; message?: string; permalink_url?: string }> }>({
      path: `${req.page.remoteId}/posts`,
      token,
      appSecret: this.appSecret,
      params: { fields: 'id,message,permalink_url', limit: 25 },
    });
    const hit = body.data?.find((p) => p.message?.includes(marker));
    return hit ? { remoteId: hit.id, permalink: hit.permalink_url } : null;
  }

  /**
   * ดึงสถิติ — FB กับ IG ให้ข้อมูลคนละชุดและคนละ endpoint
   * FB: นับจาก summary ของ likes/comments/shares บนตัวโพสต์
   * IG: ต้องเรียก /insights แยกจาก field ปกติ และ saved มีเฉพาะ IG
   */
  async fetchMetrics(args: { remoteId: string; page: TargetPage }) {
    const token = await this.resolveToken(args.page);

    if (args.page.platform === 'instagram') {
      const [basic, insights] = await Promise.all([
        graph<{ like_count?: number; comments_count?: number }>({
          path: args.remoteId, token, appSecret: this.appSecret,
          params: { fields: 'like_count,comments_count' },
        }),
        graph<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>({
          path: `${args.remoteId}/insights`, token, appSecret: this.appSecret,
          params: { metric: 'impressions,reach,saved' },
        }).catch(() => ({ body: { data: [] } })),
      ]);

      const pick = (name: string) =>
        insights.body.data?.find((d) => d.name === name)?.values?.[0]?.value;

      return {
        likes: basic.body.like_count,
        comments: basic.body.comments_count,
        impressions: pick('impressions'),
        reach: pick('reach'),
        saves: pick('saved'),
      };
    }

    const { body } = await graph<{
      likes?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
      insights?: { data?: Array<{ name: string; values?: Array<{ value: number }> }> };
    }>({
      path: args.remoteId, token, appSecret: this.appSecret,
      params: {
        fields: 'likes.summary(true),comments.summary(true),shares,'
          + 'insights.metric(post_impressions,post_impressions_unique)',
      },
    });

    const pick = (name: string) =>
      body.insights?.data?.find((d) => d.name === name)?.values?.[0]?.value;

    return {
      likes: body.likes?.summary?.total_count,
      comments: body.comments?.summary?.total_count,
      shares: body.shares?.count,
      impressions: pick('post_impressions'),
      reach: pick('post_impressions_unique'),
    };
  }

  async checkCredential(page: TargetPage): Promise<{ ok: boolean; message?: string; code?: number }> {
    try {
      const token = await this.resolveToken(page);
      await graph({ path: page.remoteId, token, appSecret: this.appSecret, params: { fields: 'id' } });
      return { ok: true };
    } catch (err) {
      const c = err instanceof ProviderError ? err.classified : undefined;
      return { ok: false, message: c?.message ?? (err as Error).message, code: c?.code };
    }
  }
}

/**
 * marker ที่มองไม่เห็นในแคปชั่น ใช้จับคู่ตอน retry
 * เป็นอักขระ zero-width ผู้อ่านไม่เห็น แต่ค้นเจอผ่าน API
 */
export function idempotencyMarker(key: string): string {
  const bits = key
    .slice(0, 10)
    .split('')
    .map((c) => c.charCodeAt(0).toString(2).padStart(8, '0'))
    .join('');
  return bits.replace(/0/g, '​').replace(/1/g, '‌');
}

export function withMarker(caption: string, key: string): string {
  return `${caption}${idempotencyMarker(key)}`;
}
