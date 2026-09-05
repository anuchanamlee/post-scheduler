import type { ReactNode } from 'react';

/**
 * ของที่ใช้ซ้ำทุกหน้า — ไอคอนเป็น SVG ล้วน ไม่ใช้ emoji เป็นไอคอน
 * และคำอธิบายสถานะเป็น "คำ" เสมอ สีเป็นแค่ตัวช่วยซ้ำ
 */

export const TZ = 'Asia/Bangkok';

export const STATUS_LABEL: Record<string, string> = {
  draft: 'ร่าง',
  pending_approval: 'รออนุมัติ',
  pending: 'รอโพสต์',
  publishing: 'กำลังส่ง',
  posted: 'สำเร็จ',
  partial: 'ขึ้นไม่ครบ',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิกแล้ว',
  missed: 'เลยเวลา',
  skipped: 'ข้าม',
};

/** คำสั้นที่ต่อท้ายชื่อเพจในชิป เพื่อไม่ให้ความหมายพึ่งสีอย่างเดียว */
export const TARGET_WORD: Record<string, string> = {
  posted: 'ขึ้นแล้ว',
  publishing: 'กำลังส่ง',
  pending: 'รอโพสต์',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิก',
  skipped: 'ข้าม',
};

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={`pill ${status}`}>
      <span className="dot" aria-hidden="true" />
      {children ?? STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function fmtTime(d: Date | string) {
  return new Date(d).toLocaleTimeString('th-TH', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDateTime(d: Date | string) {
  return new Date(d).toLocaleString('th-TH', {
    timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** yyyy-mm-dd ตามเวลาไทย ไม่ใช่ตาม UTC ของเซิร์ฟเวอร์ */
export function bangkokDate(d: Date | string = new Date()) {
  return new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });
}

export function fmtDayTitle(iso: string) {
  return new Date(iso + 'T00:00:00+07:00').toLocaleDateString('th-TH', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  });
}

const S = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const,
            strokeLinejoin: 'round' as const, viewBox: '0 0 20 20' };

export const Icon = {
  calendar: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="14" rx="2" />
      <path d="M2.5 8h15M6.5 2v3M13.5 2v3" />
    </svg>
  ),
  check: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="2.2" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  ),
  plus: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="2.2" aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  ),
  warning: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.7" aria-hidden="true">
      <path d="M10 2.5L18 17H2L10 2.5zM10 8v4M10 14.5h.01" />
    </svg>
  ),
  clock: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" /><path d="M10 5.5V10l3 2" />
    </svg>
  ),
  sparkle: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <path d="M10 2.5l1.9 4.6 4.6 1.9-4.6 1.9L10 15.5 8.1 10.9 3.5 9l4.6-1.9L10 2.5z" />
    </svg>
  ),
  back: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.8" aria-hidden="true">
      <path d="M12 4l-6 6 6 6" />
    </svg>
  ),
  info: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6.5h.01" />
    </svg>
  ),
  chart: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.7" aria-hidden="true">
      <path d="M3 17V9M8 17V4M13 17v-6M18 17v-9" />
    </svg>
  ),
  /* คลังรูปต้องไม่ใช้ไอคอนเดียวกับฟีด IG — สองปุ่มนี้อยู่ติดกันในแถบบน แยกไม่ออก */
  photo: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 12.5l4-3.5 4 3 3-2.5 4 3.5" />
      <circle cx="7" cy="7.5" r="1.2" />
    </svg>
  ),
  /* "ขึ้นไม่ครบ" ต้องมีสัญลักษณ์ของตัวเอง ไม่ใช่แยกด้วยสีอย่างเดียว */
  half: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.7" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 3v14" />
    </svg>
  ),
  close: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.9" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  ),
  move: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.7" aria-hidden="true">
      <path d="M4 10h12M12 6l4 4-4 4" />
    </svg>
  ),
  grid: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1" />
    </svg>
  ),
  settings: (p: { size?: number }) => (
    <svg width={p.size ?? 16} height={p.size ?? 16} {...S} strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" />
    </svg>
  ),
};
