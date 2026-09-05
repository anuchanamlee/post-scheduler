'use client';

import { useState, type ReactNode } from 'react';

/**
 * ยกเลิกโพสต์แล้วกู้คืนไม่ได้ จึงต้องถามซ้ำก่อน
 * ไม่ใช้ window.confirm เพราะบนมือถือมันดูเหมือน pop-up ของเบราว์เซอร์ที่คนกดปิดทิ้ง
 */
export default function ConfirmButton({
  children, confirmLabel, className = 'btn', question,
}: {
  children: ReactNode;
  confirmLabel: string;
  className?: string;
  question: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button type="button" className={className} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{question}</span>
      <button className={className}>{confirmLabel}</button>
      <button type="button" className="btn btn-sm" onClick={() => setAsking(false)}>
        ไม่ใช่
      </button>
    </span>
  );
}
