import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { one, query } from '../../lib/db.js';
import { TEMPLATES, listPosters } from '../../content/poster.js';
import PosterStudio from './PosterStudio.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

export default async function PosterPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');
  const sp = await searchParams;

  // ภาพที่ส่งต่อมาจาก /image — ต้องเป็นของ tenant นี้เท่านั้น id ในลิงก์เดาได้
  const presetPhoto = typeof sp.photo === 'string'
    ? await one<{ id: string; url: string }>(
        `SELECT id, public_url AS url FROM media_assets
          WHERE id = $1 AND tenant_id = $2 AND status = 'ready'`,
        [sp.photo, session.tenantId],
      )
    : null;

  const [recent, tenant] = await Promise.all([
    listPosters(session.tenantId, 12),
    query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [session.tenantId]),
  ]);

  return (
    <PosterStudio
      templates={TEMPLATES.map((t) => ({
        id: t.id, name: t.name, hint: t.hint,
        fields: t.fields as string[],
        bg: t.palette.bg, accent: t.palette.accent,
        sample: t.sample,
      }))}
      recent={recent.map((r) => ({
        id: r.id, url: r.url, templateId: r.template_id,
        aspect: r.aspect_ratio, fields: r.fields,
      }))}
      brand={tenant[0]?.name ?? ''}
      madeUrl={typeof sp.made === 'string' ? sp.made : undefined}
      madeAsset={typeof sp.asset === 'string' ? sp.asset : undefined}
      presetPhoto={presetPhoto}
    />
  );
}
