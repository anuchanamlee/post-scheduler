import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { query } from '../../lib/db.js';
import { canApprove } from '../../core/approval.js';
import { Icon, fmtDateTime } from '../ui.js';
import { approveAction, rejectAction } from '../actions.js';
import Flash from '../Flash.js';
import RejectForm from './RejectForm.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

/**
 * งานที่รอตรวจ
 *
 * แยกเป็นหน้าของตัวเองแทนที่จะปนในคิว เพราะเป็นงานคนละอย่าง:
 * คิวคือ "อะไรจะขึ้นเมื่อไหร่" หน้านี้คือ "อะไรรอฉันตัดสินใจ"
 */
export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

  const rows = await query<{
    id: string; caption: string; scheduled_at: Date; image_url: string | null;
    media_count: number; author: string | null; created_at: Date;
    targets: Array<{ page_name: string; platform: string }>;
  }>(
    `SELECT p.id, p.caption, p.scheduled_at, p.created_at,
            COALESCE(mv.public_url, ma.public_url) AS image_url,
            (SELECT count(*) FROM post_media pm WHERE pm.post_id = p.id)::int AS media_count,
            u.email AS author,
            COALESCE((
              SELECT json_agg(json_build_object('page_name', sp2.display_name,
                                                'platform', t.platform))
                FROM post_targets t JOIN social_pages sp2 ON sp2.id = t.page_id
               WHERE t.post_id = p.id
            ), '[]') AS targets
       FROM scheduled_posts p
       LEFT JOIN media_assets ma   ON ma.id = p.asset_id
       LEFT JOIN media_variants mv ON mv.asset_id = p.asset_id AND mv.aspect_ratio = '1:1'
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.tenant_id = $1 AND p.status = 'pending_approval'
      ORDER BY p.scheduled_at`,
    [session.tenantId],
  );

  const mayApprove = canApprove(session.role);

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>รอตรวจ</span>
        <span className="grow" />
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
          {rows.length ? `${rows.length} โพสต์รออยู่` : 'ไม่มีงานค้าง'}
        </span>
      </header>

      {typeof sp.flash === 'string' && (
        <Flash code={sp.flash} detail={typeof sp.detail === 'string' ? sp.detail : undefined} />
      )}

      <div className="alerts">
        {!mayApprove && (
          <p className="note">
            บัญชีของคุณเป็นผู้เขียน — ดูได้ว่ามีอะไรรอตรวจอยู่ แต่กดอนุมัติไม่ได้
          </p>
        )}

        {rows.length === 0 ? (
          <div className="empty">
            <Icon.check size={32} />
            <span style={{ fontSize: 13.5 }}>ไม่มีโพสต์รอตรวจ</span>
            <a className="btn" href="/">กลับไปหน้าคิว</a>
          </div>
        ) : rows.map((p) => {
          const late = new Date(p.scheduled_at).getTime() < Date.now();
          return (
            <article key={p.id} className="approval-row">
              {p.image_url && (
                <span className="thumb-wrap">
                  <img className="approval-thumb" src={p.image_url} alt="" />
                  {p.media_count > 1 && <span className="thumb-count">{p.media_count}</span>}
                </span>
              )}

              <div style={{
                flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`pill ${late ? 'missed' : 'pending'}`}>
                    <span className="dot" aria-hidden="true" />
                    {late ? 'เลยเวลาที่ตั้งไว้แล้ว' : fmtDateTime(p.scheduled_at)}
                  </span>
                  <span className="chips">
                    {p.targets.map((t, i) => (
                      <span key={i} className="pill">{t.page_name}</span>
                    ))}
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{p.caption}</p>

                <span className="hint-sm">
                  เขียนโดย {p.author ?? 'ไม่ทราบ'} · ส่งตรวจ {fmtDateTime(p.created_at)}
                </span>

                {mayApprove && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <form action={approveAction}>
                      <input type="hidden" name="postId" value={p.id} />
                      <button className="btn btn-primary">อนุมัติ</button>
                    </form>
                    <a className="btn" href={`/post/${p.id}`}>ดู/แก้ก่อน</a>
                    <RejectForm postId={p.id} action={rejectAction} />
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
