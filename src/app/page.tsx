import { redirect } from 'next/navigation';
import { currentSession } from '../lib/auth.js';
import { query } from '../lib/db.js';
import {
  dayCounts, listQueue, listQueueForDay, postsInRange, type QueueRow,
} from '../core/scheduler.js';
import { workerIsAlive } from '../core/queue.js';
import { instagramQuota, isQuotaLow } from '../core/quota.js';
import { canApprove, countAwaiting } from '../core/approval.js';
import {
  Icon, Pill, STATUS_LABEL, TARGET_WORD, bangkokDate, fmtDateTime, fmtDayTitle, fmtTime,
} from './ui.js';
import ConfirmButton from './ConfirmButton.js';
import Flash from './Flash.js';
import AlertBanner from './AlertBanner.js';
import MonthGrid from './MonthGrid.js';
import {
  cancelPostAction, dismissNotificationAction, duplicatePostAction, logoutAction,
  postNowAction, retryPostAction, submitForApprovalAction,
} from './actions.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

export default async function QueuePage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');

  const sp = await searchParams;
  const view = sp.view === 'list' ? 'list' : sp.view === 'month' ? 'month' : 'calendar';
  const today = bangkokDate();
  const day = typeof sp.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sp.day) ? sp.day : today;

  // แถบสัปดาห์เริ่มจากวันจันทร์ของสัปดาห์ที่กำลังดูอยู่
  const anchor = new Date(day + 'T00:00:00+07:00');
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

  // มุมมองเดือน: กริด 6 สัปดาห์เริ่มจากวันจันทร์ของสัปดาห์ที่มีวันที่ 1 อยู่
  const first = new Date(day.slice(0, 8) + '01T00:00:00+07:00');
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const monthGrid = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const rangeStart = view === 'month' ? monthGrid[0] : weekStart;
  const rangeDays = view === 'month' ? 42 : 7;

  const [posts, counts, pages, notifications, health, igQuota, awaiting, monthPosts,
         slotsByDay, warn] =
    await Promise.all([
    view === 'list' ? listQueue(session.tenantId, 60) : listQueueForDay(session.tenantId, day),
    dayCounts(session.tenantId, rangeStart, rangeDays),
    query<{ id: string }>(
      `SELECT id FROM social_pages WHERE tenant_id = $1 AND is_active`, [session.tenantId]),
    query<{
      id: string; level: string; title: string; body: string | null;
      post_id: string | null; created_at: Date; total: string;
    }>(
      `SELECT id, level, title, body, post_id, created_at,
              count(*) OVER ()::text AS total
         FROM notifications
        WHERE tenant_id = $1 AND read_at IS NULL
        ORDER BY CASE level WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 3`,
      [session.tenantId]),
    workerIsAlive(),
    instagramQuota(session.tenantId),
    countAwaiting(session.tenantId),
    view === 'month' ? postsInRange(session.tenantId, monthGrid[0], 42) : Promise.resolve([]),
    query<{ weekday: number; n: string }>(
      `SELECT weekday, count(*)::text AS n FROM posting_slots
        WHERE tenant_id = $1 AND is_active GROUP BY weekday`,
      [session.tenantId]),
    query<{ bad_creds: string; ai_used: string; ai_cap: string }>(
      `SELECT (SELECT count(*) FROM meta_credentials
                WHERE tenant_id = $1 AND status = 'invalid')::text AS bad_creds,
              COALESCE((SELECT calls FROM ai_usage
                         WHERE tenant_id = $1
                           AND period_month = date_trunc('month', now())::date), 0)::text AS ai_used,
              COALESCE((SELECT ai_calls_per_month FROM tenant_limits
                         WHERE tenant_id = $1), 300)::text AS ai_cap`,
      [session.tenantId]),
  ]);

  const NEEDS_ACTION = ['partial', 'failed', 'missed'];
  const firstToDecide = posts.find((p) => NEEDS_ACTION.includes(p.status));
  const selectedId = typeof sp.post === 'string' ? sp.post : (firstToDecide ?? posts[0])?.id;
  const selected = posts.find((p) => p.id === selectedId) ?? firstToDecide ?? posts[0];
  const countOf = (iso: string) => counts.find((c) => c.day === iso);
  const slotsPerWeekday: Record<number, number> = Object.fromEntries(
    slotsByDay.map((r) => [r.weekday, Number(r.n)]));
  const igUsed = igQuota.used;

  const href = (patch: Record<string, string>) => {
    const q = new URLSearchParams({ view, day, ...patch });
    return '?' + q.toString();
  };

  return (
    <>
      <header className="topbar">
        <span className="brand">
          <span style={{ color: 'var(--accent)', display: 'flex' }}><Icon.calendar size={20} /></span>
          คิวโพสต์
        </span>

        <span className={`pill ${health.alive ? 'posted' : 'failed'}`}>
          <span className="dot" aria-hidden="true" />
          {health.alive ? 'ตัวส่งโพสต์ทำงานปกติ' : 'ตัวส่งโพสต์ไม่ตอบสนอง'}
        </span>

        <span className="grow" />

        <nav className="tabs" aria-label="มุมมอง">
          <a className="tab" data-active={view === 'calendar'} href={`?view=calendar&day=${day}`}>
            ปฏิทิน
          </a>
          <a className="tab" data-active={view === 'month'} href={`?view=month&day=${day}`}>
            เดือน
          </a>
          <a className="tab" data-active={view === 'list'} href={`?view=list&day=${day}`}>
            ทั้งหมด
          </a>
        </nav>

        <a className="btn" href="/alerts" aria-label="แจ้งเตือนทั้งหมด">
          <Icon.warning />
          {Number(notifications[0]?.total ?? 0) > 0 && (
            <span className="badge-count">{notifications[0].total}</span>
          )}
        </a>
        {awaiting > 0 && (
          <a className="btn" href="/approvals">
            <Icon.check />รอตรวจ
            <span className="badge-count">{awaiting}</span>
          </a>
        )}
        <a className="btn nav-wide" href="/poster">
          <Icon.sparkle />ทำโปสเตอร์
        </a>
        <a className="btn nav-wide" href="/image">
          <Icon.sparkle />สร้างภาพ AI
        </a>
        <a className="btn nav-wide" href="/insights" aria-label="ผลตอบรับ">
          <Icon.chart />
        </a>
        <a className="btn nav-wide" href="/library" aria-label="คลังรูป">
          <Icon.photo />
        </a>
        <a className="btn nav-wide" href="/grid" aria-label="ดูฟีด Instagram">
          <Icon.grid />
        </a>
        <a className="btn nav-wide" href="/settings" aria-label="การเชื่อมต่อและโทนเสียง">
          <Icon.settings /><span className="only-wide">ตั้งค่า</span>
        </a>
        <a className="btn btn-primary" href="/new"><Icon.plus />เพิ่มโพสต์</a>
        <form action={logoutAction}>
          <button className="btn">ออก</button>
        </form>
      </header>

      {typeof sp.flash === 'string' && (
        <Flash code={sp.flash} detail={typeof sp.detail === 'string' ? sp.detail : undefined} />
      )}

      {/* เตือนล่วงหน้าเรื่องที่ทำให้ระบบหยุดทำงาน — ต้องเห็นก่อนที่โพสต์จะเริ่มไม่ขึ้น */}
      {!health.alive && (
        <AlertBanner level="critical">
          <Icon.warning />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <b>ตัวส่งโพสต์ไม่ตอบสนอง</b> — โพสต์ที่ถึงเวลาจะยังไม่ถูกส่งจนกว่าจะกลับมา
            {health.lastRun && ` (ทำงานล่าสุด ${fmtDateTime(health.lastRun)})`}
          </span>
          <a className="btn btn-sm" href="/api/health">ดูรายละเอียด</a>
        </AlertBanner>
      )}

      {Number(warn[0]?.bad_creds ?? 0) > 0 && (
        <AlertBanner level="critical">
          <Icon.warning />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <b>การเชื่อมต่อกับ Meta ใช้งานไม่ได้</b> — โพสต์ของเพจนั้นจะไม่ถูกส่งจนกว่าจะออก token ใหม่
          </span>
          <a className="btn btn-sm" href="/settings">ไปหน้าเชื่อมต่อ</a>
        </AlertBanner>
      )}

      {igQuota.exhausted && (
        <AlertBanner level="warning">
          <Icon.warning />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <b>โควตา Instagram 24 ชั่วโมงเต็มแล้ว</b> ({igQuota.used}/{igQuota.limit} โพสต์)
            — โพสต์ที่ถึงเวลาจะรอคิวไว้ก่อนและส่งเองเมื่อมีช่องว่าง
            {igQuota.freesAt && ` ประมาณ ${fmtDateTime(igQuota.freesAt)}`}
            · Facebook ยังโพสต์ได้ตามปกติ
          </span>
        </AlertBanner>
      )}

      {isQuotaLow(igQuota) && (
        <AlertBanner level="info">
          <Icon.info />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            โควตา Instagram เหลือ {igQuota.remaining} โพสต์ใน 24 ชั่วโมงนี้
          </span>
        </AlertBanner>
      )}

      {Number(warn[0]?.ai_used ?? 0) >= Number(warn[0]?.ai_cap ?? 300) * 0.8 && (
        <AlertBanner level="warning">
          <Icon.info />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            โควตาผู้ช่วยแคปชั่นเดือนนี้ใช้ไป {warn[0].ai_used}/{warn[0].ai_cap} ครั้งแล้ว
            — เมื่อเต็มจะร่างไม่ได้ แต่โพสต์ที่ตั้งเวลาไว้ยังส่งตามปกติ
          </span>
        </AlertBanner>
      )}

      {/* แจ้งเตือนรายโพสต์ ปิดได้ทีละใบ */}
      {notifications.map((n) => (
        <AlertBanner key={n.id} level={n.level as 'info' | 'warning' | 'critical'}>
          <Icon.warning />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <b>{n.title}</b>{n.body ? ` — ${n.body}` : ''}
            <span style={{ display: 'block', fontSize: 12, opacity: 0.8 }}>
              {fmtDateTime(n.created_at)}
            </span>
          </span>
          {n.post_id && <a className="btn btn-sm" href={href({ post: n.post_id })}>ดูโพสต์</a>}
          <form action={dismissNotificationAction}>
            <input type="hidden" name="id" value={n.id} />
            <input type="hidden" name="back" value="/" />
            <button className="btn btn-sm">รับทราบ</button>
          </form>
        </AlertBanner>
      ))}

      {Number(notifications[0]?.total ?? 0) > notifications.length && (
        <div className="banner banner-info">
          <span style={{ flexGrow: 1 }}>
            ยังมีแจ้งเตือนที่ยังไม่ได้อ่านอีก {Number(notifications[0].total) - notifications.length} รายการ
          </span>
          <a className="btn btn-sm" href="/alerts">ดูทั้งหมด</a>
        </div>
      )}

      {view === 'month' ? (
        <main className="month">
          <div className="month-head">
            <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              {new Date(day + 'T00:00:00+07:00').toLocaleDateString('th-TH', {
                timeZone: 'Asia/Bangkok', month: 'long', year: 'numeric' })}
            </h1>
            <span className="grow" />
            <a className="btn btn-sm" href={`?view=month&day=${prevMonth(day)}`}>เดือนก่อน</a>
            <a className="btn btn-sm" href={`?view=month&day=${nextMonth(day)}`}>เดือนถัดไป</a>
          </div>

          <MonthGrid
            dows={['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']}
            days={monthGrid.map((iso) => ({
              iso,
              inMonth: iso.slice(0, 7) === day.slice(0, 7),
              isToday: iso === today,
              freeSlots: slotsPerWeekday[
                new Date(iso + 'T00:00:00+07:00').getUTCDay()] ?? 0,
              posts: monthPosts.filter((p) => p.day === iso).map((p) => ({
                id: p.id,
                time: p.time,
                caption: p.caption,
                status: p.status,
                image_url: p.image_url,
                // ของที่ขึ้นเพจแล้วเลื่อนไม่ได้อยู่แล้วในความจริง
                movable: ['draft', 'pending_approval', 'pending', 'missed'].includes(p.status),
              })),
            }))}
          />
        </main>
      ) : (
      <div className="shell">
        {view === 'calendar' && (
          <nav className="rail" aria-label="เลือกวัน">
            <div className="rail-head" style={{
              padding: '14px 16px 8px', fontSize: 12, fontWeight: 600, color: 'var(--muted)',
            }}>
              {fmtDayTitle(day).split(' ').slice(-2).join(' ')}
            </div>

            {week.map((iso) => {
              const c = countOf(iso);
              const dow = new Date(iso + 'T00:00:00+07:00')
                .toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short' });
              return (
                <a
                  key={iso}
                  className="day"
                  data-active={iso === day}
                  href={`?view=calendar&day=${iso}`}
                  aria-current={iso === day ? 'date' : undefined}
                >
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="d-dow">{dow}</span>
                    <span className="d-num num">{Number(iso.slice(8))}</span>
                  </span>
                  <span className="hint-sm">
                    {c ? `${c.total} โพสต์` : '—'}
                  </span>
                </a>
              );
            })}

            <span className="grow" />
            <div className="rail-foot" style={{
              padding: '14px 16px', borderTop: '1px solid var(--line)',
              display: 'flex', flexDirection: 'column', gap: 7,
            }}>
              <span className="hint-sm">โควตา Instagram 24 ชม.</span>
              <span className="progress">
                <span style={{
                  width: `${Math.min(100, (igUsed / igQuota.limit) * 100)}%`,
                  background: igQuota.exhausted ? 'var(--bad)'
                    : isQuotaLow(igQuota) ? 'var(--warn)' : 'var(--accent)',
                }} />
              </span>
              <span className="num hint-sm">
                {igUsed} / {igQuota.limit} โพสต์
              </span>
            </div>
          </nav>
        )}

        <main className="center">
          <h1 style={{
            fontSize: 16, fontWeight: 600, margin: '0 0 12px',
            display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
          }}>
            {view === 'list' ? 'โพสต์ทั้งหมด' : fmtDayTitle(day)}
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
              {posts.length ? `${posts.length} โพสต์` : ''}
            </span>
          </h1>

          {posts.length === 0 ? (
            <div className="empty">
              <Icon.calendar size={32} />
              <span style={{ fontSize: 13.5 }}>
                {view === 'list' ? 'ยังไม่มีโพสต์ในระบบ' : 'วันนี้ยังไม่มีโพสต์'}
              </span>
              <a className="btn" href="/new">เพิ่มโพสต์</a>
            </div>
          ) : (
            <div className="queue">
              {posts.map((p) => (
                <a
                  key={p.id}
                  className="card"
                  data-active={p.id === selected?.id}
                  href={href({ post: p.id })}
                >
                  <span className="time num" style={{
                    width: 46, flex: 'none', fontWeight: 500, color: 'var(--muted)',
                  }}>
                    {fmtTime(p.scheduled_at)}
                  </span>
                  <span className="accent" style={{ background: accentOf(p.status) }} />
                  {p.image_url && (
                    <span className="thumb-wrap">
                      <img className="thumb" src={p.image_url} alt="" />
                      {p.media_count > 1 && <span className="thumb-count">{p.media_count}</span>}
                    </span>
                  )}
                  <span style={{
                    flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5,
                  }}>
                    <span className="cap">{p.caption || '(ยังไม่มีแคปชั่น)'}</span>
                    <span className="chips">
                      {p.targets.map((t, i) => (
                        <span key={i} className={`pill ${t.status}`}>
                          <span className="dot" aria-hidden="true" />
                          <span className="chip-page">{t.page_name}</span>
                          {' '}{TARGET_WORD[t.status] ?? t.status}
                        </span>
                      ))}
                    </span>
                  </span>
                  <Pill status={p.status} />
                </a>
              ))}
            </div>
          )}
        </main>

        {selected && (
          <Detail
            post={selected}
            canApproveHere={canApprove(session.role)}
            /* บนมือถือแผงนี้เป็นแผงเลื่อนขึ้น จะเปิดต่อเมื่อผู้ใช้แตะโพสต์เอง
               ไม่ใช่เปิดค้างเพราะระบบเลือกโพสต์แรกให้
               และต้องเป็นโพสต์ "ตัวที่ลิงก์ชี้มาจริงๆ" ด้วย — ลิงก์เก่าที่โพสต์ถูกลบไปแล้ว
               จะ fallback ไปโพสต์แรกของวัน ถ้ายังเปิดแผงค้างไว้ คนจะกดยกเลิกผิดตัว */
            picked={sp.post === selected.id}
            closeHref={href({})}
          />
        )}
      </div>
      )}
    </>
  );
}

function prevMonth(iso: string) {
  const d = new Date(iso.slice(0, 8) + '01T00:00:00+07:00');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function nextMonth(iso: string) {
  const d = new Date(iso.slice(0, 8) + '01T00:00:00+07:00');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function Detail({ post, canApproveHere, picked, closeHref }: {
  post: QueueRow; canApproveHere: boolean; picked: boolean; closeHref: string;
}) {
  const editable = ['pending', 'draft', 'pending_approval', 'missed'].includes(post.status);
  const retryable = post.status === 'partial' || post.status === 'failed';

  return (
    <aside className="aside" aria-label="รายละเอียดโพสต์" data-picked={picked}>
      {/* หัวแผงโผล่เฉพาะจอแคบ — บนเดสก์ท็อปแผงนี้อยู่ประจำที่ ไม่ต้องมีปุ่มปิด */}
      <div className="sheet-head">
        <span className="sheet-grip" aria-hidden="true" />
        <a className="btn sheet-close" href={closeHref} aria-label="ปิดรายละเอียดโพสต์">
          <Icon.close />
        </a>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Pill status={post.status} />
          <span className="num" style={{ fontSize: 13, color: 'var(--muted)' }}>
            {fmtDateTime(post.scheduled_at)}
          </span>
        </div>

        {post.image_url && (
          <img
            src={post.image_url}
            alt=""
            style={{
              width: '100%', height: 180, objectFit: 'cover',
              borderRadius: 'var(--r)', border: '1px solid var(--line)',
            }}
          />
        )}

        <p style={{ margin: 0, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
          {post.caption || '(ยังไม่มีแคปชั่น)'}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="section-label">ปลายทาง</span>
          {post.targets.map((t, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flex: 'none',
                background: accentOf(t.status),
              }} aria-hidden="true" />
              <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{t.page_name}</span>
                <span style={{
                  fontSize: 12,
                  color: t.status === 'failed' ? 'var(--bad)' : 'var(--muted)',
                }}>
                  {t.error_message
                    ?? `${STATUS_LABEL[t.status] ?? t.status}${t.attempt_count > 1 ? ` · ลองแล้ว ${t.attempt_count} ครั้ง` : ''}`}
                </span>
              </span>
              {t.status === 'publishing' && (
                <span className="progress" style={{ width: 54, flex: 'none' }}>
                  <span style={{ width: '45%' }} />
                </span>
              )}
              {t.remote_permalink && (
                <a className="btn btn-sm" href={t.remote_permalink} target="_blank" rel="noreferrer">
                  ดู
                </a>
              )}
            </div>
          ))}
        </div>

        {post.rejected_reason && (
          <p className="msg warn" style={{ margin: 0 }}>
            <b>ถูกตีกลับให้แก้:</b> {post.rejected_reason}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {post.status === 'draft' && (
            <form action={submitForApprovalAction}>
              <input type="hidden" name="postId" value={post.id} />
              <button className="btn">ส่งให้ตรวจ</button>
            </form>
          )}
          {post.status === 'pending_approval' && canApproveHere && (
            <a className="btn btn-primary" href="/approvals">ไปหน้าอนุมัติ</a>
          )}
          {post.status === 'missed' && (
            <form action={postNowAction}>
              <input type="hidden" name="postId" value={post.id} />
              <ConfirmButton className="btn btn-primary"
                             question="จะส่งขึ้นเพจจริงภายใน 1 นาที"
                             confirmLabel="ยืนยัน ส่งเลย">
                โพสต์เดี๋ยวนี้
              </ConfirmButton>
            </form>
          )}
          {retryable && (
            <form action={retryPostAction}>
              <input type="hidden" name="postId" value={post.id} />
              <ConfirmButton className="btn" question="จะส่งขึ้นเพจจริงอีกครั้ง"
                             confirmLabel="ยืนยัน ส่งใหม่">
                ส่งเฉพาะช่องทางที่ล้ม
              </ConfirmButton>
            </form>
          )}
          {editable && (
            <a className="btn" href={`/post/${post.id}`}>แก้ไขโพสต์</a>
          )}
          <form action={duplicatePostAction}>
            <input type="hidden" name="postId" value={post.id} />
            <button className="btn">ทำซ้ำ</button>
          </form>
          {editable && (
            <form action={cancelPostAction}>
              <input type="hidden" name="postId" value={post.id} />
              <ConfirmButton className="btn btn-danger" question="ยกเลิกแล้วกู้คืนไม่ได้"
                             confirmLabel="ยืนยันยกเลิก">
                ยกเลิกโพสต์
              </ConfirmButton>
            </form>
          )}
        </div>
      </div>
    </aside>
  );
}

function accentOf(status: string) {
  const map: Record<string, string> = {
    posted: 'var(--ok)', publishing: 'var(--accent)', partial: 'var(--partial)',
    failed: 'var(--bad)', missed: 'var(--warn)', cancelled: 'var(--warn)',
    skipped: 'var(--warn)',
  };
  return map[status] ?? 'var(--line-strong)';
}
