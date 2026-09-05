import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { BUCKETS, bestTimes, listInsights } from '../../core/metrics.js';
import { Icon, fmtDateTime } from '../ui.js';

export const dynamic = 'force-dynamic';

function num(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * สถิติผลตอบรับ
 *
 * ตอบคำถามที่เจ้าของร้านถามจริง: "โพสต์ไหนคนดูเยอะ" กับ "ควรโพสต์ตอนไหน"
 * ไม่ใช่แดชบอร์ดตัวเลขสวยๆ ที่ไม่มีใครเอาไปทำอะไรต่อ
 */
export default async function InsightsPage() {
  const session = await currentSession();
  if (!session) redirect('/login');

  const [posts, hours] = await Promise.all([
    listInsights(session.tenantId, 30),
    bestTimes(session.tenantId),
  ]);

  const withData = posts.filter((p) => Object.keys(p.buckets).length > 0);
  const maxReach = Math.max(
    1,
    ...hours.map((h) => Number(h.avg_reach)),
  );

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>ผลตอบรับ</span>
        <span className="grow" />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {withData.length ? `มีข้อมูล ${withData.length} โพสต์` : 'ยังไม่มีข้อมูล'}
        </span>
      </header>

      <div className="library">
        {posts.length === 0 ? (
          <div className="empty">
            <Icon.grid size={32} />
            <span style={{ fontSize: 13.5 }}>ยังไม่มีโพสต์ที่ขึ้นเพจแล้ว</span>
            <a className="btn" href="/new">เขียนโพสต์</a>
          </div>
        ) : (
          <>
            {hours.length > 0 && (
              <section className="panel">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: 14.5 }}>ช่วงเวลาที่ได้ผลดีที่สุด</h2>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    วัดจากยอดเข้าถึงเฉลี่ยใน 24 ชั่วโมงแรก
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {hours.map((h) => (
                    <div key={h.hour} style={{
                      display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
                    }}>
                      <span className="num" style={{ width: 48, fontWeight: 600 }}>
                        {String(h.hour).padStart(2, '0')}:00
                      </span>
                      <span style={{
                        height: 22, borderRadius: 4, background: 'var(--accent)',
                        width: `${Math.max(6, (Number(h.avg_reach) / maxReach) * 100)}%`,
                        minWidth: 6,
                      }} />
                      <span className="num" style={{ fontSize: 12.5 }}>
                        {num(Number(h.avg_reach))} คนเห็น
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        จาก {h.posts} โพสต์
                      </span>
                    </div>
                  ))}
                </div>

                <p className="note">
                  ตัวเลขนี้เชื่อได้เมื่อมีโพสต์พอสมควรในแต่ละช่วง — ระบบแสดงเฉพาะช่วงที่มี
                  อย่างน้อย 2 โพสต์ และบอกจำนวนที่ใช้คำนวณไว้ทุกแถว
                </p>
              </section>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {posts.map((p) => (
                <article key={`${p.post_id}-${p.platform}`} className="insight-row">
                  {p.image_url && <img className="approval-thumb" src={p.image_url} alt="" />}

                  <div style={{
                    flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8,
                  }}>
                    <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="pill">{p.page_name}</span>
                      <span className="num" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                        {fmtDateTime(p.scheduled_at)}
                      </span>
                      {p.permalink && (
                        <a className="btn btn-sm" href={p.permalink}
                           target="_blank" rel="noreferrer">ดูโพสต์</a>
                      )}
                    </div>

                    <p style={{ margin: 0, fontSize: 13.5 }}>{p.caption}</p>

                    <div className="metric-grid">
                      {BUCKETS.map((b) => {
                        const m = p.buckets[b.id];
                        return (
                          <div key={b.id} className="metric-cell" data-empty={!m}>
                            <span className="metric-label">{b.label}</span>
                            {m ? (
                              <span className="metric-nums">
                                <span title="คนเห็น">
                                  <b className="num">{num(m.reach ?? m.impressions)}</b> เห็น
                                </span>
                                <span title="ถูกใจ">
                                  <b className="num">{num(m.likes)}</b> ถูกใจ
                                </span>
                                <span title="คอมเมนต์">
                                  <b className="num">{num(m.comments)}</b> คอมเมนต์
                                </span>
                                {m.saves != null && (
                                  <span title="บันทึกไว้">
                                    <b className="num">{num(m.saves)}</b> บันทึก
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                ยังไม่ถึงเวลาเก็บ
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
