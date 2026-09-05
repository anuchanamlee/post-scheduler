'use client';

import { useState } from 'react';

/**
 * ตีกลับต้องบอกเหตุผลเสมอ — ไม่บอกว่าทำไม คนเขียนก็แก้ไม่ถูกแล้วส่งกลับมาแบบเดิม
 * ช่องเหตุผลเลยเปิดออกมาก่อน ไม่ใช่ปุ่มที่กดแล้วตีกลับทันที
 */
export default function RejectForm({
  postId, action,
}: { postId: string; action: (form: FormData) => void }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        ตีกลับให้แก้
      </button>
    );
  }

  return (
    <form action={action} style={{
      display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
      flexGrow: 1, minWidth: 240,
    }}>
      <input type="hidden" name="postId" value={postId} />
      <input
        name="reason"
        placeholder="บอกว่าต้องแก้อะไร เช่น ราคาผิด / รูปเบลอ"
        required
        autoFocus
        style={{ flexGrow: 1, minWidth: 200 }}
      />
      <button className="btn btn-danger">ส่งกลับ</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>ยกเลิก</button>
    </form>
  );
}
