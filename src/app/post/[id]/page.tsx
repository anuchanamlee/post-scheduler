import { notFound, redirect } from 'next/navigation';
import { currentSession } from '../../../lib/auth.js';
import { query } from '../../../lib/db.js';
import { getPost } from '../../../core/scheduler.js';
import { nextFreeSlots } from '../../../core/slots.js';
import { listSets } from '../../../content/hashtags.js';
import Composer from '../../new/Composer.js';

export const dynamic = 'force-dynamic';

/** แก้โพสต์ที่ยังไม่ออกไป — ใช้หน้าเดียวกับตอนสร้าง จะได้ไม่ต้องเรียนรู้ใหม่ */
export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const post = await getPost(session.tenantId, id);
  if (!post) notFound();

  if (!['draft', 'pending_approval', 'pending', 'missed'].includes(post.status)) {
    redirect('/?post=' + id);
  }

  const [pages, quota, freeSlots, tagSets] = await Promise.all([
    query<{ id: string; display_name: string; platform: string; tone: string | null }>(
      `SELECT sp.id, sp.display_name, sp.platform::text, b.tone_description AS tone
         FROM social_pages sp
         LEFT JOIN brand_voice_profiles b ON b.page_id = sp.id
        WHERE sp.tenant_id = $1 AND sp.is_active
        ORDER BY sp.platform`,
      [session.tenantId],
    ),
    query<{ used: string; cap: string }>(
      `SELECT COALESCE(u.calls, 0)::text AS used,
              COALESCE(l.ai_calls_per_month, 300)::text AS cap
         FROM tenants t
         LEFT JOIN tenant_limits l ON l.tenant_id = t.id
         LEFT JOIN ai_usage u ON u.tenant_id = t.id
                             AND u.period_month = date_trunc('month', now())::date
        WHERE t.id = $1`,
      [session.tenantId],
    ),
    nextFreeSlots(session.tenantId, 3),
    listSets(session.tenantId),
  ]);

  return (
    <Composer
      pages={pages}
      quotaUsed={Number(quota[0]?.used ?? 0)}
      quotaCap={Number(quota[0]?.cap ?? 300)}
      tagSets={tagSets}
      freeSlots={freeSlots.map((d) => ({
        iso: d.toISOString(),
        label: d.toLocaleString('th-TH', {
          timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric',
          month: 'short', hour: '2-digit', minute: '2-digit',
        }),
      }))}
      initial={{
        id: post.id,
        caption: post.caption,
        // datetime-local ต้องเป็นเวลาไทย ไม่ใช่ UTC ของเซิร์ฟเวอร์
        scheduledAt: toBangkokInput(post.scheduled_at),
        assetId: post.asset_id,
        imageUrl: post.image_url,
        media: post.media,
        pageIds: post.page_ids,
        status: post.status,
      }}
    />
  );
}

function toBangkokInput(d: Date) {
  const s = new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
  return s.slice(0, 16).replace(' ', 'T');
}
