import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { query } from '../../lib/db.js';
import { Icon, fmtDateTime } from '../ui.js';
import {
  addChannelAction, addSlotAction, removeChannelAction, removeSlotAction,
  addUserAction, connectPageAction, disconnectPageAction, removeHashtagSetAction,
  removeUserAction, replaceTokenAction, saveBrandVoiceAction, saveHashtagSetAction,
  changePasswordAction, setRoleAction, testChannelAction, toggleApprovalAction,
  verifyConnectionAction,
} from '../actions.js';
import { listChannels } from '../../core/notify.js';
import { listSets, MAX_TAGS_IG } from '../../content/hashtags.js';
import {
  ROLE_HINT, ROLE_LABEL, canManageUsers, isApprovalRequired, listUsers, type Role,
} from '../../core/approval.js';
import ConfirmButton from '../ConfirmButton.js';
import { listSlots, WEEKDAY_TH } from '../../core/slots.js';
import Flash from '../Flash.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

  const [conns, voices, usage, slots, channels, users, approvalOn, tagSets] =
    await Promise.all([
    query<{
      id: string; display_name: string; platform: string; remote_id: string;
      cred_status: string | null; last_checked_at: Date | null; last_error_message: string | null;
      label: string | null;
    }>(
      `SELECT sp.id, sp.display_name, sp.platform::text, sp.remote_id,
              c.status::text AS cred_status, c.last_checked_at, c.last_error_message, c.label
         FROM social_pages sp
         LEFT JOIN page_credentials pc ON pc.page_id = sp.id
         LEFT JOIN meta_credentials c  ON c.id = pc.credential_id
        WHERE sp.tenant_id = $1
        ORDER BY sp.platform`,
      [session.tenantId],
    ),
    query<{
      page_id: string; display_name: string; tone_description: string | null;
      example_captions: string[] | null; keywords_include: string[] | null;
      keywords_avoid: string[] | null;
    }>(
      `SELECT sp.id AS page_id, sp.display_name,
              b.tone_description, b.example_captions, b.keywords_include, b.keywords_avoid
         FROM social_pages sp
         LEFT JOIN brand_voice_profiles b ON b.page_id = sp.id
        WHERE sp.tenant_id = $1 AND sp.is_active
        ORDER BY sp.platform`,
      [session.tenantId],
    ),
    query<{
      calls: string; cost: string; call_cap: string; cost_cap: string; model: string;
      images: string; image_cap: string;
    }>(
      `SELECT COALESCE(u.calls, 0)::text AS calls,
              COALESCE(u.cost_usd, 0)::text AS cost,
              COALESCE(l.ai_calls_per_month, 300)::text AS call_cap,
              COALESCE(l.ai_cost_cap_usd, 5.0)::text AS cost_cap,
              COALESCE(l.ai_images_per_month, 60)::text AS image_cap,
              (SELECT count(*) FROM ai_images i
                WHERE i.tenant_id = t.id
                  AND i.created_at >= date_trunc('month', now()))::text AS images,
              '' AS model
         FROM tenants t
         LEFT JOIN tenant_limits l ON l.tenant_id = t.id
         LEFT JOIN ai_usage u ON u.tenant_id = t.id
                             AND u.period_month = date_trunc('month', now())::date
        WHERE t.id = $1`,
      [session.tenantId],
    ),
    listSlots(session.tenantId),
    listChannels(session.tenantId),
    listUsers(session.tenantId),
    isApprovalRequired(session.tenantId),
    listSets(session.tenantId),
  ]);

  const isOwner = canManageUsers(session.role);

  const activeVoice = typeof sp.page === 'string'
    ? voices.find((v) => v.page_id === sp.page) ?? voices[0]
    : voices[0];

  const u = usage[0];
  const calls = Number(u?.calls ?? 0);
  const cap = Number(u?.call_cap ?? 300);

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>การเชื่อมต่อและโทนเสียง</span>
        <span className="grow" />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{session.email}</span>
      </header>

      {typeof sp.flash === 'string' && <Flash code={sp.flash} />}

      {/* ทางลัดไปแต่ละหมวด — หน้านี้ยาวพอที่จะเลื่อนหาไม่เจอ */}
      <nav className="settings-jump" aria-label="ทางลัดไปหมวดตั้งค่า">
        {[
          ['pages', 'เพจที่เชื่อมต่อ'],
          ['schedule', 'ตารางเวลาประจำ'],
          ['team', 'ทีมงาน'],
          ['notify', 'แจ้งเตือน'],
          ['tags', 'ชุดแฮชแท็ก'],
          ['voice', 'โทนเสียง'],
          ['quota', 'โควตา AI'],
          ['account', 'บัญชีของฉัน'],
        ].map(([id, label]) => (
          <a key={id} className="btn btn-sm" href={`#${id}`}>{label}</a>
        ))}
      </nav>

      <div className="settings">
        {/* ตารางเวลาประจำ — ของที่ทำให้ไม่ต้องคิดเรื่องเวลาใหม่ทุกครั้งที่เขียนโพสต์ */}
        <section className="panel" id="schedule" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>ตารางเวลาประจำ</h2>
            <span className="hint">
              ตั้งไว้ครั้งเดียว โพสต์ใหม่จะถูกเสนอให้ลงช่องว่างถัดไปเอง
            </span>
          </div>

          <div className="slot-grid">
            {WEEKDAY_TH.map((name, wd) => {
              const mine = slots.filter((s) => s.weekday === wd);
              return (
                <div key={wd} className="slot-day" data-empty={mine.length === 0}>
                  <span className="slot-dayname">{name}</span>
                  {mine.length === 0 && (
                    <span className="hint-sm">ไม่โพสต์</span>
                  )}
                  {mine.map((s) => (
                    <form key={s.id} action={removeSlotAction} className="slot-chip">
                      <input type="hidden" name="id" value={s.id} />
                      <span className="num">{s.time_of_day.slice(0, 5)}</span>
                      <button className="slot-x" aria-label={`ลบช่วง ${s.time_of_day.slice(0, 5)} ของวัน${name}`}>
                        <svg width="11" height="11" viewBox="0 0 20 20" fill="none"
                             stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                             aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
                      </button>
                    </form>
                  ))}
                </div>
              );
            })}
          </div>

          <form action={addSlotAction} className="slot-add">
            <span className="label">เพิ่มช่วงเวลา</span>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
              {WEEKDAY_TH.map((name, wd) => (
                <label key={wd} className="slot-pick">
                  <input type="checkbox" name="weekday" value={wd}
                         defaultChecked={wd >= 1 && wd <= 5} />
                  {name.slice(0, 2)}
                </label>
              ))}
              <input type="time" name="time" defaultValue="12:00"
                     style={{ width: 120 }} aria-label="เวลา" />
              <button className="btn">เพิ่ม</button>
            </div>
          </form>
        </section>

        {/* บัญชีตัวเอง — ทุกบทบาทเห็น ไม่ใช่แค่เจ้าของ */}
        <section className="panel" id="account" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>บัญชีของฉัน</h2>
            <span className="num hint">
              {session.email} · {ROLE_LABEL[session.role as Role] ?? session.role}
            </span>
          </div>

          <form action={changePasswordAction} style={{
            display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
          }}>
            <label className="field" style={{ minWidth: 190, flexGrow: 1 }}>
              <span style={{ fontSize: 12.5 }}>รหัสผ่านเดิม</span>
              <input name="current" type="password" autoComplete="current-password" required />
            </label>
            <label className="field" style={{ minWidth: 190, flexGrow: 1 }}>
              <span style={{ fontSize: 12.5 }}>รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</span>
              <input name="next" type="password" autoComplete="new-password"
                     minLength={8} required />
            </label>
            <button className="btn btn-primary">เปลี่ยนรหัสผ่าน</button>
          </form>

          <p className="note" style={{ display: 'flex', gap: 9 }}>
            <span style={{ flex: 'none', marginTop: 2 }}><Icon.info size={15} /></span>
            <span>
              เจ้าของตั้งรหัสตั้งต้นให้แล้วส่งต่อทางแชท — รหัสนั้นค้างอยู่ในแชทตลอดไป
              เปลี่ยนเองตรงนี้ครั้งแรกที่เข้าใช้ พอเปลี่ยนแล้วอุปกรณ์อื่นที่ล็อกอินค้างไว้
              จะถูกเตะออกทั้งหมด เครื่องที่กำลังใช้อยู่ไม่โดน
            </span>
          </p>
        </section>

        {/* ทีมงานกับขั้นตอนตรวจ — เจ้าของเท่านั้นที่แก้ได้ */}
        <section className="panel" id="team" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>ทีมงานและการอนุมัติ</h2>
            <span className="hint">
              {isOwner ? 'เพิ่มคนช่วยทำคอนเทนต์ได้ โดยยังคุมว่าอะไรขึ้นเพจ'
                       : 'เฉพาะเจ้าของที่แก้ส่วนนี้ได้'}
            </span>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '12px 14px', borderRadius: 'var(--r)',
            background: approvalOn ? 'var(--accent-soft)' : 'var(--surface-2)',
          }}>
            <span style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 220 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                {approvalOn ? 'เปิดขั้นตอนอนุมัติอยู่' : 'ปิดขั้นตอนอนุมัติอยู่'}
              </span>
              <span className="hint">
                {approvalOn
                  ? 'โพสต์ของผู้เขียนต้องผ่านการตรวจก่อนถึงจะเข้าคิว'
                  : 'ทุกคนที่มีสิทธิ์เขียน โพสต์เข้าคิวได้ทันที'}
              </span>
            </span>
            {isOwner && (
              <form action={toggleApprovalAction}>
                <input type="hidden" name="on" value={approvalOn ? '0' : '1'} />
                <button className="btn">{approvalOn ? 'ปิดขั้นตอนนี้' : 'เปิดขั้นตอนนี้'}</button>
              </form>
            )}
          </div>

          {users.map((u) => (
            <div key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '11px 14px', border: '1px solid var(--line)', borderRadius: 'var(--r)',
            }}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 180,
                             flexGrow: 1 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {u.email}
                  {u.id === session.userId && (
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
                      {' '}· คุณ
                    </span>
                  )}
                </span>
                <span className="hint-sm">
                  {ROLE_HINT[u.role as Role] ?? u.role}
                </span>
              </span>

              {isOwner && u.id !== session.userId ? (
                <>
                  <form action={setRoleAction} style={{ display: 'flex', gap: 6 }}>
                    <input type="hidden" name="userId" value={u.id} />
                    <select name="role" defaultValue={u.role} style={{ width: 130 }}>
                      {(['owner', 'approver', 'editor'] as Role[]).map((r) => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                    <button className="btn btn-sm">เปลี่ยน</button>
                  </form>
                  <form action={removeUserAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <ConfirmButton className="btn btn-sm btn-danger"
                                   question="ลบบัญชีนี้ออกจากทีม"
                                   confirmLabel="ยืนยันลบ">
                      ลบ
                    </ConfirmButton>
                  </form>
                </>
              ) : (
                <span className="pill">{ROLE_LABEL[u.role as Role] ?? u.role}</span>
              )}
            </div>
          ))}

          {isOwner && (
            <form action={addUserAction} style={{
              display: 'flex', flexDirection: 'column', gap: 12,
              borderTop: '1px solid var(--line)', paddingTop: 14,
            }}>
              <span className="label">เพิ่มคนในทีม</span>
              <div style={{
                display: 'grid', gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              }}>
                <label className="field">
                  <span style={{ fontSize: 13 }}>อีเมล</span>
                  <input name="email" type="email" placeholder="staff@example.com" required />
                </label>
                <label className="field">
                  <span style={{ fontSize: 13 }}>รหัสผ่านตั้งต้น</span>
                  <input name="password" type="password" minLength={8}
                         placeholder="อย่างน้อย 8 ตัวอักษร" required />
                </label>
                <label className="field">
                  <span style={{ fontSize: 13 }}>สิทธิ์</span>
                  <select name="role" defaultValue="editor">
                    {(['editor', 'approver', 'owner'] as Role[]).map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]} — {ROLE_HINT[r]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                เพิ่มคน
              </button>
              <p className="note">
                รหัสผ่านตั้งต้นตั้งให้แล้วส่งให้เจ้าตัวเปลี่ยนเอง — ระบบยังไม่มีเมลรีเซ็ตรหัสผ่าน
              </p>
            </form>
          )}
        </section>

        {/* แจ้งเตือนออกนอกแอป — ในแอปมีค่าก็ต่อเมื่อมีคนเปิดดู */}
        <section className="panel" id="notify" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>แจ้งเตือนเข้า LINE</h2>
            <span className="hint">
              โพสต์ล้มตอนตี 2 จะได้รู้ทันที ไม่ต้องรอเปิดคอมตอนเช้า
            </span>
          </div>

          {channels.length === 0 && (
            <p className="note">
              ยังไม่ได้ตั้งช่องทางไหน — แจ้งเตือนจะขึ้นแค่ในเว็บเท่านั้น
            </p>
          )}

          {channels.map((c) => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 'var(--r)',
            }}>
              <span className={`pill ${c.is_active ? 'posted' : 'failed'}`}>
                <span className="dot" aria-hidden="true" />
                {c.is_active ? 'เปิดใช้งาน' : 'ปิดอัตโนมัติเพราะส่งไม่สำเร็จหลายครั้ง'}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{c.label}</span>
                <span className="num hint-sm">
                  {c.kind} · {c.destination.slice(0, 12)}…
                </span>
              </span>
              <span style={{ flexGrow: 1, minWidth: 170, fontSize: 12.5,
                             color: c.last_error ? 'var(--bad)' : 'var(--muted)' }}>
                {c.last_error
                  ?? (c.last_sent_at
                    ? `ส่งล่าสุด ${fmtDateTime(c.last_sent_at)}`
                    : 'ยังไม่เคยส่ง')}
              </span>
              <form action={testChannelAction}>
                <input type="hidden" name="id" value={c.id} />
                <button className="btn btn-sm">ส่งทดสอบ</button>
              </form>
              <form action={removeChannelAction}>
                <input type="hidden" name="id" value={c.id} />
                <ConfirmButton className="btn btn-sm btn-danger"
                               question="ลบแล้วจะไม่ได้รับแจ้งเตือนทางนี้อีก"
                               confirmLabel="ยืนยันลบ">
                  ลบ
                </ConfirmButton>
              </form>
            </div>
          ))}

          <form action={addChannelAction} style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            borderTop: '1px solid var(--line)', paddingTop: 14,
          }}>
            <span className="label">เพิ่มช่องทาง</span>
            <div style={{
              display: 'grid', gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            }}>
              <label className="field">
                <span style={{ fontSize: 13 }}>ชื่อเรียก</span>
                <input name="label" placeholder="LINE เจ้าของร้าน" />
              </label>
              <label className="field">
                <span style={{ fontSize: 13 }}>ปลายทาง (userId หรือ groupId)</span>
                <input name="destination" placeholder="Uxxxxxxxx…" required />
              </label>
              <label className="field">
                <span style={{ fontSize: 13 }}>Channel access token</span>
                <input name="secret" type="password" placeholder="จาก LINE Developers Console"
                       required />
              </label>
              <label className="field">
                <span style={{ fontSize: 13 }}>ส่งเมื่อ</span>
                <select name="minLevel" defaultValue="critical">
                  <option value="critical">เฉพาะเรื่องด่วน (โพสต์ล้ม / token เสีย)</option>
                  <option value="warning">เรื่องด่วน + เลยเวลา</option>
                  <option value="info">ทุกเรื่อง</option>
                </select>
              </label>
            </div>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
              เพิ่มช่องทาง
            </button>
            <p className="note">
              ใช้ <b>LINE Messaging API</b> ไม่ใช่ LINE Notify (ปิดบริการไปแล้ว 31 มี.ค. 2025)
              — สร้าง Official Account ฟรีที่ LINE Developers Console แล้วเอา channel access token
              กับ userId มาใส่ · token ถูกเข้ารหัสก่อนเก็บเหมือน token ของ Meta
            </p>
          </form>
        </section>

        {/* สิ่งเดียวที่ทำให้ทั้งระบบหยุดได้ จึงอยู่บนสุด */}
        <section className="panel" id="pages" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>เพจที่เชื่อมต่อไว้</h2>
            <span className="hint">
              {isOwner ? 'ใส่ token เองได้จากหน้านี้ ไม่ต้องผ่านฐานข้อมูล'
                       : 'เฉพาะเจ้าของที่แก้ส่วนนี้ได้'}
            </span>
          </div>

          {conns.map((c) => {
            const ok = c.cred_status === 'healthy';
            const never = c.cred_status === null || c.cred_status === 'unchecked';
            return (
              <div key={c.id} style={{
                display: 'flex', flexDirection: 'column', gap: 10,
                padding: '13px 15px', border: '1px solid var(--line)', borderRadius: 'var(--r)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <span className="target-icon" data-platform={c.platform}>
                    {c.platform === 'instagram' ? 'IG' : 'FB'}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 170 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{c.display_name}</span>
                    <span className="num hint-sm">
                      {c.platform === 'instagram' ? 'ig' : 'page'} {c.remote_id}
                    </span>
                  </span>

                  <span className={`pill ${ok ? 'posted' : never ? 'pending' : 'failed'}`}>
                    <span className="dot" aria-hidden="true" />
                    {c.cred_status === null ? 'ยังไม่ผูก token'
                      : never ? 'ยังไม่ได้ตรวจ'
                      : ok ? 'ใช้งานได้' : 'ใช้งานไม่ได้'}
                  </span>

                  <span style={{
                    display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 180,
                  }}>
                    <span style={{ fontSize: 12.5, color: ok ? 'var(--muted)' : 'var(--bad)' }}>
                      {c.last_error_message ?? 'System User token · ไม่มีวันหมดอายุ'}
                    </span>
                    <span className="num hint-sm">
                      {c.last_checked_at
                        ? `ตรวจล่าสุด ${fmtDateTime(c.last_checked_at)}`
                        : 'ยังไม่เคยตรวจ'}
                    </span>
                  </span>

                  {isOwner && (
                    <>
                      <form action={verifyConnectionAction}>
                        <input type="hidden" name="pageId" value={c.id} />
                        <button className="btn btn-sm">ตรวจเดี๋ยวนี้</button>
                      </form>
                      <form action={disconnectPageAction}>
                        <input type="hidden" name="pageId" value={c.id} />
                        <ConfirmButton className="btn btn-sm btn-danger"
                                       question="ปิดใช้งานเพจนี้"
                                       confirmLabel="ยืนยันปิด">
                          ปิดใช้งาน
                        </ConfirmButton>
                      </form>
                    </>
                  )}
                </div>

                {isOwner && (
                  <form action={replaceTokenAction} style={{
                    display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end',
                    borderTop: '1px dashed var(--line)', paddingTop: 10,
                  }}>
                    <input type="hidden" name="pageId" value={c.id} />
                    <label className="field" style={{ flexGrow: 1, minWidth: 220 }}>
                      <span style={{ fontSize: 12.5 }}>เปลี่ยน token (ใช้ตอน token เดิมพัง)</span>
                      <input name="token" type="password" placeholder="EAAG…" required />
                    </label>
                    <button className="btn btn-sm">บันทึก token ใหม่</button>
                  </form>
                )}
              </div>
            );
          })}

          {isOwner && (
            <form action={connectPageAction} style={{
              display: 'flex', flexDirection: 'column', gap: 12,
              borderTop: '1px solid var(--line)', paddingTop: 14,
            }}>
              <span className="label">เชื่อมต่อเพจใหม่</span>
              <div style={{
                display: 'grid', gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              }}>
                <label className="field">
                  <span style={{ fontSize: 13 }}>ปลายทาง</span>
                  <select name="platform" defaultValue="facebook">
                    <option value="facebook">Facebook Page</option>
                    <option value="instagram">Instagram Professional</option>
                  </select>
                </label>
                <label className="field">
                  <span style={{ fontSize: 13 }}>ชื่อเรียก</span>
                  <input name="displayName" placeholder="เพจร้านของลูกค้า" required />
                </label>
                <label className="field">
                  <span style={{ fontSize: 13 }}>ID ของเพจ / บัญชี IG</span>
                  <input name="remoteId" placeholder="1234567890" required />
                </label>
                <label className="field">
                  <span style={{ fontSize: 13 }}>System User token</span>
                  <input name="token" type="password" placeholder="EAAG…" required />
                </label>
              </div>
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                เชื่อมต่อ
              </button>
              <p className="note" style={{ display: 'flex', gap: 9 }}>
                <span style={{ flex: 'none', marginTop: 2 }}><Icon.info size={15} /></span>
                <span>
                  token ถูกเข้ารหัส AES-256-GCM ก่อนเก็บ และไม่เคยถูกอ่านกลับมาแสดงอีก —
                  ถ้าลืมต้องออกใหม่จาก Business Manager · ขั้นตอนอยู่ใน
                  {' '}<code>docs/onboarding-runbook.md</code> · ตรวจก่อนใช้จริงด้วย
                  {' '}<code>npm run verify-meta</code>
                </span>
              </p>
            </form>
          )}
        </section>

        {/* ชุดแฮชแท็ก — ร้านใช้แท็กประจำซ้ำๆ ไม่ควรพิมพ์ใหม่ทุกโพสต์ */}
        <section className="panel" id="tags" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>ชุดแฮชแท็ก</h2>
            <span className="hint">
              ตั้งไว้แล้วกดแทรกได้ตอนเขียนโพสต์ — AI จะเสนอแท็กตามเนื้อหาเพิ่มให้อีกทาง
            </span>
          </div>

          {tagSets.map((set) => (
            <form key={set.id} action={saveHashtagSetAction} style={{
              display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
              padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 'var(--r)',
            }}>
              <input type="hidden" name="id" value={set.id} />
              <label className="field" style={{ width: 170 }}>
                <span style={{ fontSize: 12.5 }}>ชื่อชุด</span>
                <input name="name" defaultValue={set.name} required />
              </label>
              <label className="field" style={{ flexGrow: 1, minWidth: 240 }}>
                <span style={{ fontSize: 12.5 }}>
                  แท็ก ({set.tags.length}/{MAX_TAGS_IG}) — คั่นด้วยช่องว่าง
                </span>
                <input name="tags" defaultValue={set.tags.join(' ')} required />
              </label>
              <button className="btn">บันทึก</button>
              <button className="btn btn-danger" formAction={removeHashtagSetAction}
                      name="id" value={set.id}>ลบ</button>
            </form>
          ))}

          <form action={saveHashtagSetAction} style={{
            display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
            borderTop: '1px solid var(--line)', paddingTop: 14,
          }}>
            <label className="field" style={{ width: 170 }}>
              <span style={{ fontSize: 12.5 }}>ชื่อชุดใหม่</span>
              <input name="name" placeholder="เช่น แท็กเมนูอาหาร" required />
            </label>
            <label className="field" style={{ flexGrow: 1, minWidth: 240 }}>
              <span style={{ fontSize: 12.5 }}>แท็ก — ไม่ต้องใส่ # ก็ได้ ระบบเติมให้</span>
              <input name="tags" placeholder="อาหารอร่อย ร้านเด็ด กรุงเทพ" required />
            </label>
            <button className="btn btn-primary">เพิ่มชุด</button>
          </form>

          <p className="note">
            Instagram นับแท็กได้ {MAX_TAGS_IG} อันต่อโพสต์ เกินนั้นโพสต์ไม่ขึ้น —
            ระบบเตือนตอนเขียนถ้าเกิน
          </p>
        </section>

        {/* โทนเสียงผูกกับเพจ ไม่ใช่กับลูกค้า */}
        <section className="panel" id="voice">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 14.5 }}>โทนเสียงของเพจ</h2>
            <span className="grow" />
            <nav className="tabs">
              {voices.map((v) => (
                <a key={v.page_id} className="tab"
                   data-active={v.page_id === activeVoice?.page_id}
                   href={`?page=${v.page_id}`}>
                  {v.display_name}
                </a>
              ))}
            </nav>
          </div>

          {activeVoice && (
            <form action={saveBrandVoiceAction} key={activeVoice.page_id}
                  style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <input type="hidden" name="pageId" value={activeVoice.page_id} />

              <label className="field">
                <span className="label">อธิบายโทนเสียง</span>
                <textarea name="tone" defaultValue={activeVoice.tone_description ?? ''}
                          style={{ minHeight: 70 }}
                          placeholder="เช่น เป็นกันเอง สุภาพ ลงท้ายด้วยค่ะ ไม่ขายตรงจนเกินไป" />
              </label>

              <label className="field">
                <span className="label">ตัวอย่างแคปชั่นที่เจ้าของเพจชอบ (บรรทัดละ 1 ชิ้น)</span>
                <textarea name="examples"
                          defaultValue={(activeVoice.example_captions ?? []).join('\n')} />
              </label>

              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14,
              }}>
                <label className="field">
                  <span className="label">คำที่ควรมี (คั่นด้วยจุลภาค)</span>
                  <input name="include"
                         defaultValue={(activeVoice.keywords_include ?? []).join(', ')} />
                </label>
                <label className="field">
                  <span className="label">คำที่ห้ามใช้</span>
                  <input name="avoid" defaultValue={(activeVoice.keywords_avoid ?? []).join(', ')} />
                </label>
              </div>

              <p className="note">
                ตัวอย่างแคปชั่นถูกส่งให้ AI เป็นข้อมูลอ้างอิงโทนเสียงเท่านั้น
                ไม่ใช่คำสั่ง — ข้อความสั่งงานที่แปะไว้ในนี้จะไม่ถูกทำตาม
              </p>

              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                บันทึกโทนเสียง
              </button>
            </form>
          )}
        </section>

        {/* เห็นค่าใช้จ่ายก่อนบิลมา */}
        <section className="panel" id="quota">
          <h2 style={{ margin: 0, fontSize: 14.5 }}>โควตา AI เดือนนี้</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="num" style={{ fontSize: 30, fontWeight: 600 }}>{calls}</span>
              <span className="num" style={{ fontSize: 14, color: 'var(--muted)' }}>
                / {cap} ครั้ง
              </span>
            </span>
            <span className="progress" style={{ height: 7 }}>
              <span style={{ width: `${Math.min(100, (calls / cap) * 100)}%` }} />
            </span>
          </div>

          <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 9, fontSize: 13 }}>
            {[
              // ภาพมีเพดานของตัวเองเพราะแพงกว่าข้อความราว 40 เท่าต่อครั้ง
              ['ภาพที่สร้างด้วย AI', `${Number(u?.images ?? 0)} / ${Number(u?.image_cap ?? 60)} ใบ`],
              ['ค่าใช้จ่ายสะสม', `${Number(u?.cost ?? 0).toFixed(2)} USD`],
              ['เพดานของเดือนนี้', `${Number(u?.cost_cap ?? 5).toFixed(2)} USD`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 10 }}>
                <dt style={{ color: 'var(--muted)', flexGrow: 1 }}>{k}</dt>
                <dd className="num" style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
              </div>
            ))}
          </dl>

          <p className="note">
            เมื่อถึงเพดาน ระบบจะปิดปุ่มร่างอัตโนมัติ แต่ไม่หยุดการโพสต์ตามเวลาที่ตั้งไว้
          </p>
        </section>
      </div>
    </>
  );
}
