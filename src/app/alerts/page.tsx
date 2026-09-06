import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { query } from '../../lib/db.js';
import { Icon, fmtDateTime } from '../ui.js';
import { dismissNotificationAction, markNotificationsRead } from '../actions.js';
import Flash from '../Flash.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

/**
 * ศูนย์รวมแจ้งเตือน
 *
 * แถบบนหน้าคิวแสดงได้แค่ 3 ใบและเป็นของที่ยังไม่ได้อ่าน — ที่เหลือต้องมีที่ไป
 * เรื่องที่เคยเกิดขึ้นแล้วต้องย้อนดูได้ ไม่ใช่หายไปตอนกดรับทราบ
 */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

  const rows = await query<{
    id: string; level: string; title: string; body: string | null;
    post_id: string | null; created_at: Date; read_at: Date | null;
  }>(
    `SELECT id, level, title, body, post_id, created_at, read_at
       FROM notifications
      WHERE tenant_id = $1
      ORDER BY read_at IS NOT NULL,
               CASE level WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT 100`,
    [session.tenantId],
  );

  const unread = rows.filter((r) => !r.read_at);
  const read = rows.filter((r) => r.read_at);

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>แจ้งเตือน</span>
        <span className="grow" />
        {unread.length > 0 && (
          <form action={markNotificationsRead}>
            <button className="btn">รับทราบทั้งหมด ({unread.length})</button>
          </form>
        )}
      </header>

      {typeof sp.flash === 'string' && <Flash code={sp.flash} />}

      <div className="alerts">
        {rows.length === 0 && (
          <div className="empty">
            <Icon.check size={32} />
            <span style={{ fontSize: 13.5 }}>ยังไม่มีแจ้งเตือน — ระบบทำงานปกติ</span>
          </div>
        )}

        {unread.length > 0 && (
          <>
            <h2 className="alerts-head">ยังไม่ได้อ่าน</h2>
            {unread.map((n) => <Row key={n.id} n={n} />)}
          </>
        )}

        {read.length > 0 && (
          <>
            <h2 className="alerts-head">อ่านแล้ว</h2>
            {read.map((n) => <Row key={n.id} n={n} />)}
          </>
        )}
      </div>
    </>
  );
}

function Row({ n }: {
  n: {
    id: string; level: string; title: string; body: string | null;
    post_id: string | null; created_at: Date; read_at: Date | null;
  };
}) {
  return (
    <article className={`alert-row alert-${n.level}`} data-read={Boolean(n.read_at)}>
      <span className="alert-icon" aria-hidden="true">
        {n.level === 'critical' ? <Icon.warning /> : <Icon.info />}
      </span>

      <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{n.title}</span>
        {n.body && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{n.body}</span>}
        <span className="num hint-sm">
          {fmtDateTime(n.created_at)}
          {n.read_at && ' · อ่านแล้ว'}
        </span>
      </span>

      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {n.post_id && <a className="btn btn-sm" href={`/?post=${n.post_id}`}>ดูโพสต์</a>}
        {!n.read_at && (
          <form action={dismissNotificationAction}>
            <input type="hidden" name="id" value={n.id} />
            <input type="hidden" name="back" value="/alerts" />
            <button className="btn btn-sm">รับทราบ</button>
          </form>
        )}
      </span>
    </article>
  );
}
