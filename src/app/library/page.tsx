import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { humanBytes, libraryCounts, listLibrary } from '../../content/library.js';
import { Icon, fmtDateTime } from '../ui.js';
import { deleteAssetAction } from '../actions.js';
import ConfirmButton from '../ConfirmButton.js';
import Flash from '../Flash.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

const FILTERS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'poster', label: 'โปสเตอร์ที่ทำ' },
  { id: 'ai', label: 'ภาพจาก AI' },
  { id: 'upload', label: 'รูปที่อัปโหลด' },
] as const;

/**
 * คลังรูป — ประวัติภาพย้อนหลัง + ดาวน์โหลดไฟล์ความละเอียดสูง
 * สองข้อที่เขียนไว้ในข้อเสนอแพ็กเกจ 1
 */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

  const filter = (typeof sp.f === 'string' && ['all', 'poster', 'ai', 'upload'].includes(sp.f)
    ? sp.f : 'all') as 'all' | 'poster' | 'ai' | 'upload';

  const [items, counts] = await Promise.all([
    listLibrary(session.tenantId, filter),
    libraryCounts(session.tenantId),
  ]);

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>คลังรูป</span>
        <span className="grow" />
        <span className="num" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {counts.total} ไฟล์ · {humanBytes(counts.bytes)}
        </span>
      </header>

      {typeof sp.flash === 'string' && (
        <Flash code={sp.flash} detail={typeof sp.detail === 'string' ? sp.detail : undefined} />
      )}

      <div className="library">
        <nav className="tabs" style={{ alignSelf: 'flex-start' }}>
          {FILTERS.map((f) => (
            <a key={f.id} className="tab" data-active={filter === f.id} href={`?f=${f.id}`}>
              {f.label}
              {f.id === 'poster' && counts.posters > 0 && ` (${counts.posters})`}
              {f.id === 'ai' && counts.aiImages > 0 && ` (${counts.aiImages})`}
              {f.id === 'upload' && counts.uploads > 0 && ` (${counts.uploads})`}
            </a>
          ))}
        </nav>

        {items.length === 0 ? (
          <div className="empty">
            <Icon.grid size={32} />
            <span style={{ fontSize: 13.5 }}>ยังไม่มีรูปในคลัง</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <a className="btn" href="/poster">ทำโปสเตอร์</a>
              <a className="btn" href="/new">เขียนโพสต์</a>
            </div>
          </div>
        ) : (
          <div className="lib-grid">
            {items.map((it) => (
              <article key={it.id} className="lib-card">
                <a href={it.url} target="_blank" rel="noreferrer" className="lib-img"
                   title="เปิดดูขนาดเต็ม">
                  <img src={it.url} alt={it.original_name ?? ''} loading="lazy" />
                  {it.kind === 'poster' && <span className="lib-tag">โปสเตอร์</span>}
                  {it.kind === 'ai' && <span className="lib-tag">ภาพ AI</span>}
                </a>

                <div className="lib-meta">
                  <span className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {it.width} × {it.height}
                    {it.bytes ? ` · ${humanBytes(Number(it.bytes))}` : ''}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {fmtDateTime(it.created_at)}
                  </span>

                  {it.used_in > 0 && (
                    <span className={`pill ${it.in_use_pending ? 'publishing' : 'posted'}`}>
                      <span className="dot" aria-hidden="true" />
                      ใช้ใน {it.used_in} โพสต์
                    </span>
                  )}

                  {it.variants.length > 0 && (
                    <span className="chips">
                      {it.variants.map((v) => (
                        <a key={v.aspect_ratio} className="pill" href={v.url}
                           target="_blank" rel="noreferrer">{v.aspect_ratio}</a>
                      ))}
                    </span>
                  )}

                  <div className="lib-actions">
                    <a className="btn btn-sm" href={`${it.url}?download=1`}>ดาวน์โหลด</a>
                    <a className="btn btn-sm" href={`/new?asset=${it.id}`}>เอาไปโพสต์</a>

                    <a className="btn btn-sm" href={`/crop/${it.id}`}>เลือกกรอบครอป</a>

                    {!it.in_use_pending && (
                      <form action={deleteAssetAction}>
                        <input type="hidden" name="assetId" value={it.id} />
                        <ConfirmButton className="btn btn-sm btn-danger"
                                       question="ลบไฟล์นี้ถาวร"
                                       confirmLabel="ยืนยันลบ">
                          ลบ
                        </ConfirmButton>
                      </form>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
