import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { query } from '../../lib/db.js';
import { Icon, STATUS_LABEL, fmtDateTime } from '../ui.js';

export const dynamic = 'force-dynamic';

/**
 * ฟีดจำลองของ Instagram — เอาแนวคิด grid preview ของ Later มาต่อยอด
 *
 * เหตุผลที่ต้องมี: IG เป็นแพลตฟอร์มที่คนดู "ทั้งหน้าโปรไฟล์" ไม่ใช่ทีละโพสต์
 * รูปที่สวยเดี่ยวๆ อาจทำให้ฟีดรวมดูมั่วได้ และเจ้าของร้านจะรู้ก็ต่อเมื่อโพสต์ไปแล้ว
 *
 * ต่อยอดจากของ Later ตรงที่เราผสม "ของที่ขึ้นแล้ว" กับ "ของที่ยังไม่ถึงเวลา" ไว้ในกริดเดียว
 * และทำเครื่องหมายไว้ว่าอันไหนยังไม่ขึ้น — จะได้เห็นว่าอีกสามวันข้างหน้าฟีดจะกลายเป็นแบบไหน
 */
export default async function GridPage() {
  const session = await currentSession();
  if (!session) redirect('/login');

  const rows = await query<{
    id: string; caption: string; scheduled_at: Date; status: string;
    image_url: string | null; target_status: string;
  }>(
    `SELECT p.id, p.caption, p.scheduled_at, p.status::text,
            COALESCE(mv.public_url, ma.public_url) AS image_url,
            t.status::text AS target_status
       FROM scheduled_posts p
       JOIN post_targets t  ON t.post_id = p.id AND t.platform = 'instagram'
       LEFT JOIN media_assets ma   ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '4:5'
      WHERE p.tenant_id = $1
        AND p.status NOT IN ('cancelled', 'missed')
      ORDER BY p.scheduled_at DESC
      LIMIT 18`,
    [session.tenantId],
  );

  const upcoming = rows.filter((r) => r.target_status === 'pending').length;

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>ฟีด Instagram</span>
        <span className="grow" />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {upcoming > 0 ? `รวมของที่ยังไม่ขึ้นอีก ${upcoming} โพสต์` : 'ขึ้นครบแล้วทุกโพสต์'}
        </span>
      </header>

      <div className="grid-page">
        <p className="note" style={{ maxWidth: 560 }}>
          <Icon.info size={14} /> ดูว่าหน้าโปรไฟล์จะเป็นแบบไหนเมื่อโพสต์ที่ตั้งเวลาไว้ขึ้นครบ
          — ช่องที่มีเส้นประคือของที่ยังไม่ขึ้น
        </p>

        {rows.length === 0 ? (
          <div className="empty">
            <Icon.grid size={32} />
            <span style={{ fontSize: 13.5 }}>ยังไม่มีโพสต์ที่ลง Instagram</span>
            <a className="btn" href="/new">เพิ่มโพสต์</a>
          </div>
        ) : (
          <div className="ig-grid">
            {rows.map((r) => (
              <a key={r.id} className="ig-cell" data-pending={r.target_status === 'pending'}
                 href={`/?post=${r.id}`}
                 title={`${fmtDateTime(r.scheduled_at)} · ${STATUS_LABEL[r.status] ?? r.status}`}>
                {r.image_url
                  ? <img src={r.image_url} alt="" loading="lazy" />
                  : <span className="ig-noimg">ไม่มีรูป</span>}

                {r.target_status === 'pending' && (
                  <span className="ig-badge">
                    <Icon.clock size={11} />
                    {new Date(r.scheduled_at).toLocaleDateString('th-TH', {
                      timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' })}
                  </span>
                )}
                {r.target_status === 'failed' && (
                  <span className="ig-badge ig-badge-bad">ล้มเหลว</span>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
