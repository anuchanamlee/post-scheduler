import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../lib/env.js';
import type { MockPost } from '../../providers/mock.js';

export const dynamic = 'force-dynamic';

/**
 * "เพจจำลอง" — ที่ที่โพสต์ไปโผล่เวลาใช้ provider แบบ mock
 * มีไว้ให้เห็นด้วยตาว่า pipeline ทำงานครบเส้น โดยไม่ต้องมี Meta App
 */
export default async function MockFeed() {
  let feed: MockPost[] = [];
  try {
    feed = JSON.parse(
      await fs.readFile(path.join(env.storageDir, 'mock-feed.json'), 'utf8'),
    ) as MockPost[];
  } catch {
    feed = [];
  }

  return (
    <div className="wrap">
      <header className="app">
        <div>
          <h1>ฟีดจำลอง</h1>
          <span className="who">ปลายทางที่ provider แบบ mock ส่งโพสต์ไปลง</span>
        </div>
        <a href="/">กลับไปหน้าคิว</a>
      </header>

      {feed.length === 0 && (
        <p className="hint">ยังไม่มีโพสต์ — รอ worker หยิบงานที่ถึงเวลา แล้วรีเฟรชหน้านี้</p>
      )}

      <div className="queue">
        {feed.map((p) => (
          <article key={p.remoteId} id={p.remoteId} className="post posted">
            <img src={p.imageUrl} alt="" />
            <div className="body">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="pill posted">{p.platform}</span>
                <span className="when">
                  {new Date(p.publishedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}
                </span>
                <span className="who">{p.pageName}</span>
              </div>
              <p className="caption">{p.caption}</p>
              <code>{p.remoteId}</code>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
