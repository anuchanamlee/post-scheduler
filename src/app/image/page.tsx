import { redirect } from 'next/navigation';
import { currentSession } from '../../lib/auth.js';
import { MODES, listAiImages, listRefCandidates } from '../../content/image.js';
import ImageStudio from './ImageStudio.js';

export const dynamic = 'force-dynamic';

export default async function ImagePage() {
  const session = await currentSession();
  if (!session) redirect('/login');

  const [refs, recent] = await Promise.all([
    listRefCandidates(session.tenantId, 24),
    listAiImages(session.tenantId, 12),
  ]);

  return (
    <ImageStudio
      modes={MODES.map((m) => ({ id: m.id, name: m.name, hint: m.hint, needsRef: m.needsRef }))}
      refs={refs}
      recent={recent.map((r) => ({
        id: r.id, assetId: r.asset_id, url: r.url, mode: r.mode,
        prompt: r.prompt, aspect_ratio: r.aspect_ratio,
      }))}
    />
  );
}
