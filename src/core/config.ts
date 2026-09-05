import { env } from '../lib/env.js';

/**
 * ตรวจคอนฟิกที่ "ไม่พังตอนบูต แต่พังตอนอยู่หน้าลูกค้า"
 *
 * ENCRYPTION_KEY_HEX ว่างไม่ทำให้เว็บขึ้นไม่ได้ — มันไปพังตอนกดเชื่อมเพจ
 * ซึ่งคือนาทีที่กำลังส่งมอบงานอยู่ ตรวจตรงนี้แล้วโผล่ที่ /api/health
 * จะได้เห็นตั้งแต่ก่อนถึงวันนั้น รัน `node scripts/setup.mjs` แก้ได้ทันที
 */

export type ConfigProblem = { key: string; problem: string; fix: string };

export function configProblems(): ConfigProblem[] {
  const out: ConfigProblem[] = [];

  const hex = env.encryptionKeyHex;
  if (!hex) {
    out.push({
      key: 'ENCRYPTION_KEY_HEX',
      problem: 'ยังไม่ได้ตั้ง — เชื่อมต่อเพจไม่ได้ เพราะเก็บ token แบบเข้ารหัสไม่ได้',
      fix: 'node scripts/setup.mjs',
    });
  } else if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    out.push({
      key: 'ENCRYPTION_KEY_HEX',
      problem: 'ต้องเป็น hex 64 ตัวอักษร (32 ไบต์)',
      fix: 'node scripts/setup.mjs หรือ openssl rand -hex 32',
    });
  }

  if (!env.cronSecret) {
    out.push({
      key: 'CRON_SECRET',
      problem: 'ยังไม่ได้ตั้ง — ใครก็ยิง /api/cron สั่งให้ระบบโพสต์ได้',
      fix: 'node scripts/setup.mjs',
    });
  }

  // ของจริงต้องให้ Meta โหลดรูปจาก URL นี้ได้ — localhost ไม่มีทางโหลดได้
  if (env.defaultProvider === 'meta' && /localhost|127\.0\.0\.1/.test(env.publicBaseUrl)) {
    out.push({
      key: 'PUBLIC_BASE_URL',
      problem: 'ชี้มาที่ localhost ทั้งที่ใช้ provider meta — Instagram โหลดรูปไม่ได้',
      fix: 'ตั้งเป็นโดเมนจริง หรือ cloudflared tunnel --url http://localhost:3000',
    });
  }

  if (env.defaultProvider === 'meta' && env.storage.driver === 'local') {
    out.push({
      key: 'STORAGE_DRIVER',
      problem: 'เก็บรูปในดิสก์ container ทั้งที่ใช้ของจริง — เครื่องตายทีเดียวรูปหายหมด',
      fix: 'ตั้ง STORAGE_DRIVER=s3 พร้อมค่า S3_* (R2/S3/MinIO)',
    });
  }

  return out;
}

/**
 * เหมือน configProblems แต่อ่าน process.env สดทุกครั้ง
 * env.ts อ่านครั้งเดียวตอน import โดยตั้งใจ (คอนฟิกไม่ควรเปลี่ยนกลางทาง)
 * ตัวนี้เลยมีไว้ให้เทสต์พิสูจน์ได้ว่าคอนฟิกพังแล้วจับได้จริง
 */
export function probeConfig(): ConfigProblem[] {
  const hex = process.env.ENCRYPTION_KEY_HEX ?? '';
  const out: ConfigProblem[] = [];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    out.push({
      key: 'ENCRYPTION_KEY_HEX',
      problem: hex ? 'ต้องเป็น hex 64 ตัวอักษร (32 ไบต์)' : 'ยังไม่ได้ตั้ง',
      fix: 'node scripts/setup.mjs',
    });
  }
  if (!(process.env.CRON_SECRET ?? '')) {
    out.push({
      key: 'CRON_SECRET',
      problem: 'ยังไม่ได้ตั้ง — ใครก็ยิง /api/cron สั่งให้ระบบโพสต์ได้',
      fix: 'node scripts/setup.mjs',
    });
  }
  return out;
}

/**
 * "พร้อมส่งมอบลูกค้าจริงหรือยัง" — คนละคำถามกับ configProblems
 *
 * configProblems ตอบว่า "คอนฟิกที่ตั้งไว้จะพังไหม"
 * ตัวนี้ตอบว่า "ของที่ยังเป็นของจำลองอยู่ มีอะไรบ้าง"
 *
 * ทำไมต้องแยก: ตอน DEFAULT_PROVIDER=mock ระบบทำงานครบทุกอย่างและ /api/health ตอบ ok
 * ซึ่งอ่านแล้วเหมือนพร้อมใช้ ทั้งที่ยังไม่เคยมีโพสต์ขึ้นเพจจริงสักโพสต์
 * เคยเกือบพลาดตรงนี้ — ตัวเลขเขียวทั้งแถบไม่ได้แปลว่าส่งมอบได้
 */

export type ReadinessLevel = 'blocker' | 'warn' | 'ok';

export type ReadinessItem = {
  key: string;
  level: ReadinessLevel;
  what: string;
  /** ต้องทำอะไรถึงจะผ่าน — ว่างเมื่อผ่านแล้ว */
  fix?: string;
};

export function readinessReport(): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const live = env.defaultProvider === 'meta';

  for (const p of configProblems()) {
    out.push({ key: p.key, level: 'blocker', what: p.problem, fix: p.fix });
  }

  out.push(live
    ? { key: 'DEFAULT_PROVIDER', level: 'ok', what: 'ยิงเข้า Meta ของจริง' }
    : {
        key: 'DEFAULT_PROVIDER',
        level: 'blocker',
        what: 'ยังเป็น mock — โพสต์ไม่เคยขึ้นเพจจริง ขึ้นแค่ที่ /mock-feed',
        fix: 'ตั้ง DEFAULT_PROVIDER=meta หลัง onboard ลูกค้าและเก็บ token แล้ว',
      });

  out.push(/^https:\/\//.test(env.publicBaseUrl)
    ? { key: 'PUBLIC_BASE_URL', level: 'ok', what: `เข้าถึงจากภายนอกได้ (${env.publicBaseUrl})` }
    : {
        key: 'PUBLIC_BASE_URL',
        level: live ? 'blocker' : 'warn',
        what: `ยังไม่ใช่ HTTPS สาธารณะ (${env.publicBaseUrl}) — Instagram รับแต่ image_url ที่เปิดจากเน็ตได้`,
        fix: 'ตั้งโดเมนจริง หรือ cloudflared tunnel --url http://localhost:3000',
      });

  out.push(env.storage.driver === 's3'
    ? { key: 'STORAGE_DRIVER', level: 'ok', what: 'เก็บรูปนอกเครื่อง (S3/R2)' }
    : {
        key: 'STORAGE_DRIVER',
        level: live ? 'blocker' : 'warn',
        what: 'เก็บรูปในดิสก์ของ container — เครื่องตายทีเดียวรูปลูกค้าหายหมด',
        fix: 'ตั้ง STORAGE_DRIVER=s3 พร้อม S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY',
      });

  out.push(env.notify.transport === 'line'
    ? { key: 'NOTIFY_TRANSPORT', level: 'ok', what: 'แจ้งเตือนเข้า LINE จริง' }
    : {
        key: 'NOTIFY_TRANSPORT',
        level: 'warn',
        what: 'แจ้งเตือนยังเขียนลงไฟล์ ไม่ได้ส่งถึงใคร — โพสต์ล้มแล้วไม่มีใครรู้',
        fix: 'ตั้ง NOTIFY_TRANSPORT=line แล้วเพิ่มช่องทางที่ /settings',
      });

  out.push(env.notify.heartbeatUrl
    ? { key: 'WORKER_HEARTBEAT_URL', level: 'ok', what: 'มีคนนอกคอยดูว่า worker ยังหายใจ' }
    : {
        key: 'WORKER_HEARTBEAT_URL',
        level: 'warn',
        what: 'ไม่มีใครเฝ้า worker — worker ที่ตายแล้วส่งแจ้งเตือนบอกว่าตัวเองตายไม่ได้',
        fix: 'สมัคร uptime monitor (เช่น healthchecks.io) แล้วใส่ URL ที่ได้',
      });

  out.push(env.ai.openRouterKey
    ? { key: 'OPENROUTER_API_KEY', level: 'ok', what: 'ผู้ช่วยแคปชั่นและสร้างภาพใช้ของจริง' }
    : {
        key: 'OPENROUTER_API_KEY',
        level: 'warn',
        what: 'ยังไม่มี key — แคปชั่นร่างในเครื่อง และภาพเป็นภาพตัวอย่างไล่สี ไม่ใช่ผลจากโมเดล',
        fix: 'ใส่ OPENROUTER_API_KEY (ไม่ใส่ก็ใช้ระบบได้ครบ แค่ไม่มีผู้ช่วย AI)',
      });

  return out;
}

/** ผ่านหรือไม่ผ่าน — ใช้เป็น exit code ของสคริปต์ตรวจก่อนส่งมอบ */
export function readinessBlockers(items = readinessReport()): ReadinessItem[] {
  return items.filter((i) => i.level === 'blocker');
}
