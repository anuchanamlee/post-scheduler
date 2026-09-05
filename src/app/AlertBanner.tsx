'use client';

import { useState, type ReactNode } from 'react';

/**
 * แถบแจ้งเตือนที่ปิดได้ทีละใบ
 *
 * ปิดในหน้าจอ = ซ่อนชั่วคราวเท่านั้น ยังไม่ mark ว่าอ่านแล้วในฐานข้อมูล
 * เพราะบางเรื่อง (token ใช้ไม่ได้) ต้องกลับมาเตือนอีกจนกว่าจะแก้จริง
 * ปุ่ม "รับทราบ" ต่างหากที่บันทึกว่าอ่านแล้ว
 */
export default function AlertBanner({
  level, children,
}: { level: 'info' | 'warning' | 'critical'; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <div className={`banner banner-${level}`} role={level === 'critical' ? 'alert' : 'status'}>
      {children}
      <button type="button" className="flash-close" onClick={() => setOpen(false)}
              aria-label="ซ่อนแจ้งเตือนนี้ชั่วคราว">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      </button>
    </div>
  );
}
