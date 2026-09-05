/**
 * สัญญาระหว่าง "ชั้นคนโพสต์" กับผู้ให้บริการแต่ละเจ้า
 *
 * ทุกอย่างที่ pipeline รู้จักปลายทาง มีแค่ interface นี้ — ไม่มีที่ไหนใน core
 * เรียก graph.facebook.com ตรงๆ ดังนั้นการเพิ่ม TikTok / LINE OA หรือย้ายไป
 * aggregator วันหน้า = เขียน provider ใหม่ 1 ไฟล์ ไม่ต้องแตะ pipeline
 */

export type Platform = 'facebook' | 'instagram';

export type TargetPage = {
  id: string;
  platform: Platform;
  provider: string;
  remoteId: string;
  displayName: string;
  timezone: string;
};

export type PublishRequest = {
  tenantId: string;
  targetId: string;
  page: TargetPage;
  caption: string;
  /**
   * รูปของโพสต์ เรียงตามลำดับที่จะแสดง — 1 ใบคือโพสต์ธรรมดา มากกว่านั้นคือ carousel
   * ทุก URL ต้องเข้าถึงได้จริงจากอินเทอร์เน็ต (รายงานข้อ B2)
   */
  imageUrls: string[];
  /** ใช้จับคู่ตอน retry ว่าเคยโพสต์สำเร็จไปแล้วหรือยัง (รายงานข้อ D2) */
  idempotencyKey: string;
  /** container ที่ค้างจากรอบก่อน ถ้ามีและยังไม่หมดอายุ ใช้ต่อได้ */
  existingContainerId?: string | null;
  containerExpiresAt?: Date | null;
  /** container ลูกของ carousel ที่สร้างไปแล้ว — กันสร้างซ้ำเมื่อ process ตายกลางคัน */
  existingChildIds?: string[];
};

export type PublishResult = {
  remoteId: string;
  permalink?: string;
};

/** hook ให้ provider บันทึกความคืบหน้าลง DB ระหว่างทำงาน */
export type PublishHooks = {
  /** IG: เก็บ creation_id ทันทีที่สร้างได้ เผื่อ process ตายกลางคัน */
  onContainer?: (containerId: string, expiresAt: Date) => Promise<void>;
  /** IG carousel: เก็บ id ของ container ลูกทีละใบระหว่างสร้าง */
  onChildContainer?: (childId: string) => Promise<void>;
  log?: (entry: {
    operation: string;
    httpStatus?: number;
    errorCode?: number;
    errorMessage?: string;
    durationMs?: number;
    meta?: Record<string, unknown>;
  }) => Promise<void>;
};

export interface PublishProvider {
  readonly name: string;
  supports(platform: Platform): boolean;

  publish(req: PublishRequest, hooks?: PublishHooks): Promise<PublishResult>;

  /**
   * ก่อน retry ต้องถามปลายทางก่อนว่าโพสต์นี้ขึ้นไปแล้วหรือยัง
   * คืน remoteId ถ้าเจอ — ป้องกันโพสต์ซ้ำตอน timeout แต่จริงๆ สำเร็จ (รายงานข้อ D2)
   */
  findExisting(req: PublishRequest): Promise<PublishResult | null>;

  /** ตรวจว่า credential ยังใช้ได้ไหม — ไม่ใช่ "เหลือกี่วัน" (รายงานข้อ B3/A3) */
  checkCredential(page: TargetPage): Promise<{ ok: boolean; message?: string; code?: number }>;

  /**
   * ดึงสถิติของโพสต์ที่ขึ้นไปแล้ว — ไม่บังคับ ปลายทางที่ไม่มีข้อมูลก็ไม่ต้องมี
   * ตัวเลขที่ได้เป็นค่าสะสม ณ เวลาที่ถาม ไม่ใช่ค่าของช่วงเวลานั้น
   */
  fetchMetrics?(args: { remoteId: string; page: TargetPage }): Promise<{
    impressions?: number; reach?: number; likes?: number;
    comments?: number; shares?: number; saves?: number;
  }>;
}

export type CredentialResolver = (page: TargetPage) => Promise<string>;
