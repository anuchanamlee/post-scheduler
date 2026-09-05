/**
 * ค่าคอนฟิกทั้งหมดอ่านที่เดียว — ที่ไหนต้องใช้ ให้ import จากไฟล์นี้
 * ห้ามอ่าน process.env กระจายทั่วโค้ด (หา key ที่หลุดยาก)
 */

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`ต้องตั้งค่า env ${name}`);
  return v;
}

export const env = {
  databaseUrl: required('DATABASE_URL', 'postgres://app:app@db:5432/scheduler'),

  /** ต้นทางของ public URL ที่ Meta ต้องเข้าถึงได้จริง (รายงานข้อ B2)
   *  localhost ใช้ไม่ได้กับ Instagram — ต้อง tunnel หรือ object storage */
  publicBaseUrl: required('PUBLIC_BASE_URL', 'http://localhost:3000'),
  storageDir: required('STORAGE_DIR', '/data/storage'),

  /** คีย์เข้ารหัส token — 32 ไบต์ hex, มาจาก env/KMS เท่านั้น ไม่เคยอยู่ใน DB */
  encryptionKeyHex: process.env.ENCRYPTION_KEY_HEX ?? '',
  encryptionKeyVersion: Number(process.env.ENCRYPTION_KEY_VERSION ?? 1),

  /** secret ของ endpoint ที่ trigger worker (รายงานข้อ E5) */
  cronSecret: process.env.CRON_SECRET ?? '',

  worker: {
    intervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 20_000),
    lockSeconds: Number(process.env.WORKER_LOCK_SECONDS ?? 300),
    batchSize: Number(process.env.WORKER_BATCH_SIZE ?? 10),
    /** เลยเวลาเกินเท่านี้ = ไม่โพสต์ย้อนหลัง mark missed (รายงานข้อ D10) */
    graceMinutes: Number(process.env.WORKER_GRACE_MINUTES ?? 120),
    heartbeatStaleMinutes: Number(process.env.WORKER_HEARTBEAT_STALE_MINUTES ?? 10),
  },

  meta: {
    graphVersion: process.env.META_GRAPH_VERSION ?? 'v26.0',
    graphBaseUrl: process.env.META_GRAPH_BASE_URL ?? 'https://graph.facebook.com',
    /** Meta แนะนำ poll นาทีละครั้ง ไม่เกิน 5 นาที (รายงานข้อ A4/D1) */
    containerPollIntervalMs: Number(process.env.IG_POLL_INTERVAL_MS ?? 60_000),
    containerPollMaxMs: Number(process.env.IG_POLL_MAX_MS ?? 300_000),
    /** 100 โพสต์ / 24 ชม. moving window — เลข 25 คือของปี 2018 (รายงานข้อ A4) */
    igDailyPostLimit: Number(process.env.IG_DAILY_POST_LIMIT ?? 100),
  },

  ai: {
    /** ไม่ตั้ง key = ใช้ตัวร่างแบบ local ที่ยังเคารพ brand voice (ลองใช้งานได้โดยไม่ต้องมี key) */
    openRouterKey: process.env.OPENROUTER_API_KEY ?? '',
    model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-5',
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    /**
     * โมเดลสร้างภาพ — คนละตัวกับโมเดลข้อความ และเรียกคนละ endpoint
     * (`/images` ไม่ใช่ `/chat/completions`)
     * gemini-2.5-flash-image รับรูปอ้างอิงได้ ซึ่งจำเป็นกับโหมดเปลี่ยนพื้นหลังสินค้า
     */
    imageModel: process.env.OPENROUTER_IMAGE_MODEL ?? 'google/gemini-2.5-flash-image',
    /** '512' | '1K' | '2K' | '4K' — 1K พอสำหรับฟีด IG (1080px) และถูกกว่ากันหลายเท่า */
    imageResolution: process.env.OPENROUTER_IMAGE_RESOLUTION ?? '1K',
  },

  /**
   * เก็บ log ไว้กี่วัน — ของที่ระบบเขียนทิ้งเท่านั้น
   * โพสต์ รูป โปสเตอร์ credential ไม่เคยถูกลบอัตโนมัติ
   */
  retention: {
    jobRunsDays: Number(process.env.RETAIN_JOB_RUNS_DAYS ?? 7),
    apiLogDays: Number(process.env.RETAIN_API_LOG_DAYS ?? 30),
    notificationDays: Number(process.env.RETAIN_NOTIFICATION_DAYS ?? 90),
    draftDays: Number(process.env.RETAIN_DRAFT_DAYS ?? 90),
  },

  storage: {
    /**
     * local = ดิสก์ของ container (ใช้ตอนพัฒนา)
     * s3    = S3-compatible ภายนอก — ใช้ตอนโปรดักชัน เพราะรูปที่ลูกค้าทำเองหายไม่ได้
     *         และ VPS ตายทีเดียว volume หายหมด
     */
    driver: process.env.STORAGE_DRIVER ?? 'local',
    endpoint: process.env.S3_ENDPOINT ?? '',
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'auto',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    /** โดเมนสาธารณะของ bucket ถ้ามี (R2 custom domain) — ไม่ตั้งจะใช้ endpoint/bucket */
    publicBase: process.env.S3_PUBLIC_BASE ?? '',
  },

  notify: {
    /** mock = เขียนลงไฟล์แทนการยิงออกเน็ต กันส่งข้อความจริงหาคนโดยไม่ตั้งใจตอนทดสอบ */
    transport: process.env.NOTIFY_TRANSPORT ?? 'mock',
    /**
     * dead-man switch: worker ยิง GET ไป URL นี้ทุกรอบที่ทำงานสำเร็จ
     * ถ้าหยุดยิง บริการภายนอก (เช่น healthchecks.io) จะเตือนแทน
     * — จำเป็นเพราะถ้า worker ตาย มันก็ส่งแจ้งเตือนบอกว่าตัวเองตายไม่ได้
     */
    heartbeatUrl: process.env.WORKER_HEARTBEAT_URL ?? '',
  },

  /** ผู้ให้บริการโพสต์ที่ใช้จริง — สลับเป็น mock เพื่อทดสอบทั้ง pipeline โดยไม่ต้องมี Meta app */
  defaultProvider: process.env.DEFAULT_PROVIDER ?? 'mock',
};

export type Env = typeof env;
