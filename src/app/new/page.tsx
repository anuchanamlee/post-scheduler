import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { query } from '../../lib/db.js';
import { nextFreeSlots } from '../../core/slots.js';
import { listSets } from '../../content/hashtags.js';
import Composer from './Composer.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

export default async function NewPostPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

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

  // มาจากห้องทำโปสเตอร์: ใช้ภาพที่เพิ่งสร้างเป็นรูปของโพสต์เลย
  const fromAsset = typeof sp.asset === 'string'
    ? (await query<{ id: string; public_url: string }>(
        `SELECT id, public_url FROM media_assets WHERE id = $1 AND tenant_id = $2`,
        [sp.asset, session.tenantId]))[0]
    : undefined;

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
      justSaved={typeof sp.saved === 'string'}
      preloaded={fromAsset
        ? { asset_id: fromAsset.id, url: fromAsset.public_url }
        : undefined}
    />
  );
}
