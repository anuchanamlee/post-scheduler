'use client';

import { useActionState } from 'react';
import { loginAction } from '../actions.js';

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, null as { error?: string } | null);

  return (
    <div className="wrap">
      <form className="panel login" action={action}>
        <h2>เข้าสู่ระบบ</h2>
        <p className="hint">ระบบนี้ถือ token ที่โพสต์ลงเพจได้ จึงต้องเข้าสู่ระบบเสมอ</p>
        {state?.error && <p className="msg bad">{state.error}</p>}
        <label>
          อีเมล
          <input name="email" type="email" defaultValue="owner@example.com" required />
        </label>
        <label>
          รหัสผ่าน
          <input name="password" type="password" defaultValue="demo1234" required />
        </label>
        <button disabled={pending}>{pending ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button>
        <p className="hint"><a href="/forgot">ลืมรหัสผ่าน</a></p>
      </form>
    </div>
  );
}
