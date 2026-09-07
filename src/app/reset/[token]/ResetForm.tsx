'use client';

import { useActionState } from 'react';
import { consumeResetAction } from '../../actions.js';

export default function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    consumeResetAction, null as { error?: string } | null);

  return (
    <div className="wrap">
      <form className="panel login" action={action}>
        <h2>ตั้งรหัสผ่านใหม่</h2>
        <input type="hidden" name="token" value={token} />
        {state?.error && <p className="msg bad">{state.error}</p>}
        <label>
          รหัสผ่านใหม่
          <input name="password" type="password" minLength={8} required
                 autoComplete="new-password" />
        </label>
        <label>
          พิมพ์อีกครั้ง
          <input name="confirm" type="password" minLength={8} required
                 autoComplete="new-password" />
        </label>
        <p className="hint">
          ตั้งเสร็จแล้วเครื่องอื่นที่ยังเข้าระบบค้างอยู่จะถูกให้ออกทั้งหมด
        </p>
        <button disabled={pending}>{pending ? 'กำลังบันทึก…' : 'บันทึกรหัสผ่านใหม่'}</button>
      </form>
    </div>
  );
}
