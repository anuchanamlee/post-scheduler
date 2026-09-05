import { notFound, redirect } from 'next/navigation';
import { currentSession } from '../../../lib/auth.js';
import { one, query } from '../../../lib/db.js';
import { ASPECTS } from '../../../content/media.js';
import { Icon } from '../../ui.js';
import CropStudio from './CropStudio.js';
import Flash from '../../Flash.js';

export const dynamic = 'force-dynamic';

type Search = { [k: string]: string | string[] | undefined };

export default async function CropPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const session = await currentSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;

  const asset = await one<{
    id: string; public_url: string; width: number | null; height: number | null;
    original_name: string | null;
  }>(
    `SELECT id, public_url, width, height, original_name
       FROM media_assets WHERE tenant_id = $1 AND id = $2 AND status = 'ready'`,
    [session.tenantId, id],
  );
  if (!asset || !asset.width || !asset.height) notFound();

  const variants = await query<{
    aspect_ratio: string; public_url: string; overlay: { focus?: { x: number; y: number } } | null;
  }>(
    `SELECT aspect_ratio, public_url, overlay FROM media_variants
      WHERE tenant_id = $1 AND asset_id = $2 ORDER BY aspect_ratio`,
    [session.tenantId, id],
  );

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/library" aria-label="กลับไปคลังรูป"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>เลือกกรอบครอป</span>
        <span className="grow" />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          {asset.original_name ?? 'รูปในคลัง'}
        </span>
      </header>

      {typeof sp.flash === 'string' && (
        <Flash code={sp.flash} detail={typeof sp.detail === 'string' ? sp.detail : undefined} />
      )}

      <CropStudio
        assetId={asset.id}
        url={asset.public_url}
        width={asset.width}
        height={asset.height}
        specs={Object.entries(ASPECTS).map(([k, v]) => ({
          id: k, w: v.w, h: v.h, label: v.label,
        }))}
        existing={variants.map((v) => ({
          aspect_ratio: v.aspect_ratio,
          url: v.public_url,
          focus: v.overlay?.focus ?? null,
        }))}
      />
    </>
  );
}
