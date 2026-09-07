'use client';

import { useActionState } from 'react';
import { requestResetAction } from '../actions.js';

export default function ForgotPage() {
  const [state, action, pending] = useActionState(
    requestResetAction, null as { ok?: string } | null);

  return (
    <div className="wrap">
      <form className="panel login" action={action}>
        <h2>ลืมรหัสผ่าน</h2>
        <p className="hint">กรอกอีเมลที่ใช้เข้าระบบ แล้วเราจะส่งลิงก์ตั้งรหัสใหม่ไปให้</p>
        {state?.ok && <p className="msg ok">{state.ok}</p>}
        <label>
          อีเมล
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <button disabled={pending}>{pending ? 'กำลังส่ง…' : 'ส่งลิงก์ตั้งรหัสใหม่'}</button>
        <p className="hint"><a href="/login">กลับไปหน้าเข้าสู่ระบบ</a></p>
      </form>
    </div>
  );
}
