import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../lib/env.js';
import { ProviderError } from './errors.js';
import type {
  Platform,
  PublishHooks,
  PublishProvider,
  PublishRequest,
  PublishResult,
  TargetPage,
} from './types.js';

/**
 * ปลายทางจำลอง — ทำหน้าที่เหมือน Meta ทุกอย่างยกเว้นการยิงออกอินเทอร์เน็ตจริง
 *
 * มีไว้เพื่อ 2 เรื่อง
 * 1. ทดสอบ pipeline ทั้งเส้น (คิว → claim → container → publish → สถานะ) ได้โดยไม่ต้องมี
 *    Meta App, ไม่ต้องมี public URL, ไม่ต้องรอผลข้อ A1
 * 2. พิสูจน์ว่าชั้น provider ถอดเปลี่ยนได้จริง — ถ้าโค้ด core ต้องแก้เพื่อรองรับตัวนี้
 *    แปลว่าการแยกชั้นยังไม่จริง
 *
 * จำลองพฤติกรรมที่ทำให้ระบบจริงพัง:
 * - Instagram เป็น 2 เฟส และ container ใช้เวลาสักครู่กว่าจะ FINISHED
 * - แคปชั่นที่มี #failig → IG ล้ม (ใช้ดูเคส "โพสต์ครึ่งเดียว" ข้อ D3)
 * - แคปชั่นที่มี #failall → ล้มทุกช่องทาง (ใช้ดูเคสโพสต์ที่ไม่ขึ้นเลย)
 * - แคปชั่นที่มี #timeout → publish สำเร็จฝั่งปลายทาง แต่ตอบกลับหาย (ใช้ดูข้อ D2)
 */
export class MockProvider implements PublishProvider {
  readonly name = 'mock';

  private get feedPath(): string {
    return path.join(env.storageDir, 'mock-feed.json');
  }

  supports(_platform: Platform): boolean {
    return true;
  }

  private async readFeed(): Promise<MockPost[]> {
    try {
      return JSON.parse(await fs.readFile(this.feedPath, 'utf8')) as MockPost[];
    } catch {
      return [];
    }
  }

  private async appendFeed(post: MockPost): Promise<void> {
    const feed = await this.readFeed();
    feed.unshift(post);
    await fs.mkdir(path.dirname(this.feedPath), { recursive: true });
    await fs.writeFile(this.feedPath, JSON.stringify(feed.slice(0, 200), null, 2));
  }

  async publish(req: PublishRequest, hooks?: PublishHooks): Promise<PublishResult> {
    const started = Date.now();

    if (req.caption.includes('#failall')) {
      throw new ProviderError({
        class: 'permanent',
        code: 100,
        message: 'จำลอง: ปลายทางปฏิเสธโพสต์นี้',
      });
    }

    if (req.page.platform === 'instagram') {
      let containerId = req.existingContainerId ?? null;
      if (containerId && req.containerExpiresAt && req.containerExpiresAt.getTime() < Date.now()) {
        containerId = null;
      }
      if (!containerId) {
        containerId = `mock_container_${crypto.randomUUID().slice(0, 8)}`;
        await hooks?.log?.({ operation: 'mock.instagram.media', meta: { containerId } });
        await hooks?.onContainer?.(containerId, new Date(Date.now() + 24 * 3600_000));
      }
      // carousel: จำลองการสร้าง container ลูกใบละรูปก่อนรวมเป็นแม่
      if (req.imageUrls.length > 1) {
        for (let i = req.existingChildIds?.length ?? 0; i < req.imageUrls.length; i++) {
          const childId = `mock_child_${crypto.randomUUID().slice(0, 8)}`;
          await hooks?.onChildContainer?.(childId);
          await hooks?.log?.({ operation: 'mock.instagram.carousel_item', meta: { childId } });
        }
      }
      // จำลองช่วงรอ container ประมวลผล (ของจริงคือ poll นาทีละครั้ง)
      await new Promise((r) => setTimeout(r, 400));
      await hooks?.log?.({ operation: 'mock.instagram.container_status', meta: { code: 'FINISHED' } });

      if (req.caption.includes('#failig')) {
        throw new ProviderError({
          class: 'permanent',
          code: 100,
          message: 'จำลอง: Instagram ปฏิเสธรูป (aspect ratio ไม่ผ่าน)',
        });
      }
    }

    const remoteId = `mock_${req.page.platform}_${crypto.randomUUID().slice(0, 8)}`;
    await this.appendFeed({
      remoteId,
      platform: req.page.platform,
      pageName: req.page.displayName,
      caption: req.caption,
      imageUrl: req.imageUrls[0],
      imageCount: req.imageUrls.length,
      idempotencyKey: req.idempotencyKey,
      publishedAt: new Date().toISOString(),
    });

    if (req.caption.includes('#timeout')) {
      // ปลายทางรับไปแล้ว แต่เราไม่ได้คำตอบ — รอบหน้าต้องเจอด้วย findExisting ไม่ใช่โพสต์ซ้ำ
      throw new ProviderError({
        class: 'retryable',
        message: 'จำลอง: หมดเวลารอคำตอบ (แต่ปลายทางรับไปแล้ว)',
        retryAfterMs: 1_000,
      });
    }

    await hooks?.log?.({
      operation: `mock.${req.page.platform}.publish`,
      httpStatus: 200,
      durationMs: Date.now() - started,
    });
    return { remoteId, permalink: `/mock-feed#${remoteId}` };
  }

  async findExisting(req: PublishRequest): Promise<PublishResult | null> {
    const feed = await this.readFeed();
    const hit = feed.find(
      (p) => p.idempotencyKey === req.idempotencyKey && p.platform === req.page.platform,
    );
    return hit ? { remoteId: hit.remoteId, permalink: `/mock-feed#${hit.remoteId}` } : null;
  }

  async checkCredential(_page: TargetPage): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  /**
   * สถิติจำลอง — คงที่ต่อโพสต์ (คำนวณจาก remoteId) เพื่อให้ทดสอบซ้ำได้ผลเดิม
   * และเพิ่มขึ้นตามเวลาเหมือนของจริง ไม่ใช่สุ่มใหม่ทุกครั้ง
   */
  async fetchMetrics(args: { remoteId: string; page: TargetPage }) {
    const seed = [...args.remoteId].reduce((a, c) => a + c.charCodeAt(0), 0);
    const feed = await this.readFeed();
    const post = feed.find((p) => p.remoteId === args.remoteId);
    const ageHours = post
      ? (Date.now() - new Date(post.publishedAt).getTime()) / 3600_000
      : 1;

    // ยอดโตเร็วช่วงแรกแล้วค่อยๆ นิ่ง — เหมือนโพสต์จริง
    const growth = Math.log10(Math.max(1, ageHours) + 1) + 1;
    const base = 40 + (seed % 160);

    return {
      impressions: Math.round(base * 6 * growth),
      reach: Math.round(base * 4 * growth),
      likes: Math.round(base * 0.4 * growth),
      comments: Math.round(base * 0.05 * growth),
      shares: Math.round(base * 0.03 * growth),
      saves: args.page.platform === 'instagram'
        ? Math.round(base * 0.08 * growth) : undefined,
    };
  }
}

export type MockPost = {
  remoteId: string;
  platform: Platform;
  pageName: string;
  caption: string;
  imageUrl: string;
  imageCount: number;
  idempotencyKey: string;
  publishedAt: string;
};
