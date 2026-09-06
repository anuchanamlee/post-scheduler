'use client';

import { useState } from 'react';
import { Icon } from '../ui.js';

type Mode = { id: string; name: string; hint: string; needsRef: boolean };
type Ref = { id: string; url: string; original_name: string | null };
type Made = {
  id: string; assetId: string; url: string; mode: string; prompt: string; aspect_ratio: string;
};

const ASPECTS = [
  { id: '1:1', label: 'จัตุรัส · ฟีด' },
  { id: '4:5', label: 'แนวตั้ง · ฟีด' },
  { id: '9:16', label: 'สตอรี่' },
];

const EXAMPLES: Record<string, string> = {
  illustration: 'บรรยากาศร้านกาแฟตอนเช้า แสงส่องผ่านหน้าต่าง โทนอบอุ่น',
  scene: 'พื้นผิวไม้เรียบๆ โทนครีม เว้นที่ว่างครึ่งบน',
  'replace-bg': 'วางบนโต๊ะหินอ่อนสีขาว มีใบไม้เขียวเบลอด้านหลัง แสงนุ่ม',
  poster: 'โปสเตอร์โปรโมชั่นร้านอาหาร โทนแดงทอง องค์ประกอบเทศกาล',
};

/**
 * ห้องสร้างภาพด้วย AI
 *
 * สิ่งที่หน้านี้ต้องบอกให้ชัดตลอดเวลา มีสองอย่าง เพราะเป็นสองข้อที่ทำให้ร้านเสียหายจริง
 *   1. ภาพที่ออกมา "ไม่มีตัวหนังสือ" โดยตั้งใจ — ข้อความไทยต้องไปใส่ที่หน้าโปสเตอร์
 *      เพราะโมเดลสร้างภาพยังเขียนไทยไม่ถูก
 *   2. ภาพสินค้าที่ AI วาดเองไม่ใช่สินค้าของร้าน — โหมดเปลี่ยนพื้นหลังมีไว้แทน
 */
export default function ImageStudio({
  modes, refs, recent,
}: { modes: Mode[]; refs: Ref[]; recent: Made[] }) {
  const [mode, setMode] = useState(modes[0].id);
  const [aspect, setAspect] = useState('4:5');
  const [topic, setTopic] = useState('');
  const [refId, setRefId] = useState<string | null>(refs[0]?.id ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ assetId: string; url: string; placeholder: boolean } | null>(null);

  const current = modes.find((m) => m.id === mode)!;
  const refReady = !current.needsRef || Boolean(file || refId);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('mode', mode);
      body.set('topic', topic);
      body.set('aspect', aspect);
      if (file) body.set('refFile', file);
      else if (current.needsRef && refId) body.set('refAssetId', refId);

      const res = await fetch('/api/ai/image', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'สร้างภาพไม่สำเร็จ');
      setMade({ assetId: json.assetId, url: json.url, placeholder: json.placeholder });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>สร้างภาพด้วย AI</span>
        <span className="grow" />
        <a className="btn btn-sm" href="/poster">ไปหน้าทำโปสเตอร์</a>
      </header>

      <div className="studio">
        <section className="studio-form">
          <p className="note" style={{ marginTop: 0 }}>
            ภาพที่ได้จะ<strong>ไม่มีตัวหนังสือ</strong>โดยตั้งใจ — โมเดลสร้างภาพยังเขียนไทยไม่ถูก
            สระลอย วรรณยุกต์ผิดที่ ข้อความทั้งหมดไปใส่ที่หน้าทำโปสเตอร์
            ซึ่งวาดด้วยฟอนต์ไทยจริงและแก้ทีหลังได้โดยไม่ต้องสร้างภาพใหม่
          </p>

          {/* 1 · โหมด */}
          <div className="field">
            <span className="label">อยากได้ภาพแบบไหน</span>
            <div className="tpl-grid">
              {modes.map((m) => (
                <button type="button" key={m.id} className="tpl" data-active={m.id === mode}
                        aria-pressed={m.id === mode}
                        onClick={() => { setMode(m.id); setMade(null); setError(null); }}>
                  <span className="tpl-name">{m.name}</span>
                  <span className="tpl-hint">{m.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2 · รูปต้นฉบับ — เฉพาะโหมดที่ต้องใช้ของจริง */}
          {current.needsRef && (
            <div className="field">
              <span className="label">รูปสินค้าจริง</span>
              <span className="hint">
                ตัวสินค้าในรูปนี้จะถูกเก็บไว้ เปลี่ยนแค่ฉากหลังรอบตัวมัน — ต้นฉบับไม่ถูกแก้
              </span>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {filePreview
                  ? <img src={filePreview} alt="" className="pick-thumb" />
                  : refId
                    ? <img src={refs.find((r) => r.id === refId)?.url} alt="" className="pick-thumb" />
                    : <div className="pick-thumb pick-empty"><Icon.plus size={20} /></div>}
                <div style={{ flexGrow: 1, minWidth: 220, display: 'grid', gap: 8 }}>
                  <input type="file" accept="image/jpeg,image/png"
                         onChange={(e) => {
                           const f = e.target.files?.[0] ?? null;
                           setFile(f);
                           setFilePreview(f ? URL.createObjectURL(f) : null);
                         }} />
                  {refs.length > 0 && (
                    <label style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
                      หรือเลือกจากรูปที่เคยอัปโหลด
                      <select value={refId ?? ''}
                              onChange={(e) => { setRefId(e.target.value || null); setFile(null); setFilePreview(null); }}>
                        <option value="">— ไม่เลือก —</option>
                        {refs.map((r) => (
                          <option key={r.id} value={r.id}>{r.original_name ?? r.id.slice(0, 8)}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3 · คำอธิบายภาพ */}
          <label className="field">
            <span className="label">อธิบายภาพที่อยากได้</span>
            <textarea rows={3} value={topic} onChange={(e) => setTopic(e.target.value)}
                      placeholder={EXAMPLES[mode] ?? ''} maxLength={600} />
            <span className="hint-sm">
              บอกของ · แสง · โทนสี · มุมมอง ให้ครบจะได้ผลตรงที่สุด
              ไม่ต้องสั่งเรื่องตัวหนังสือ ระบบสั่งห้ามไว้ให้แล้ว
            </span>
          </label>

          {/* 4 · สัดส่วน */}
          <div className="field">
            <span className="label">สัดส่วน</span>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {ASPECTS.map((a) => (
                <button type="button" key={a.id} className="btn btn-sm"
                        data-chosen={aspect === a.id} aria-pressed={aspect === a.id}
                        onClick={() => setAspect(a.id)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="msg bad">{error}</p>}

          <div className="actions-bar">
            {busy && (
              <span className="hint">
                กำลังสร้างภาพ… ใช้เวลาราว 10–30 วินาที
              </span>
            )}
            <span className="grow" />
            <button className="btn btn-primary" style={{ height: 40, padding: '0 22px' }}
                    disabled={busy || !topic.trim() || !refReady} onClick={generate}>
              {busy ? 'กำลังสร้าง…' : 'สร้างภาพ'}
            </button>
          </div>
        </section>

        <aside className="studio-preview">
          {made ? (
            <>
              <img src={made.url} alt="ภาพที่ AI สร้าง" className="poster-out" />
              {made.placeholder && (
                <p className="msg bad" style={{ maxWidth: 380 }}>
                  นี่คือภาพตัวอย่างในเครื่อง ไม่ใช่ผลจากโมเดลจริง —
                  ยังไม่ได้ตั้ง <code>OPENROUTER_API_KEY</code> อย่าเพิ่งส่งให้ลูกค้า
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a className="btn btn-primary" href={`/poster?photo=${made.assetId}`}>
                  ใส่ข้อความไทยที่หน้าโปสเตอร์
                </a>
                <a className="btn" href={`/new?asset=${made.assetId}`}>เอาไปตั้งเวลาโพสต์</a>
                <a className="btn" href={made.url} download="ภาพจาก-AI.jpg">ดาวน์โหลด</a>
              </div>
              <p className="note" style={{ maxWidth: 380 }}>
                เก็บเข้าคลังรูปแล้ว ใช้ซ้ำได้โดยไม่ต้องจ่ายเงินสร้างใหม่
              </p>
            </>
          ) : (
            <div className="poster-placeholder">
              <Icon.grid size={30} />
              <span style={{ fontSize: 13.5 }}>อธิบายภาพแล้วกด “สร้างภาพ”</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 300,
                             textAlign: 'center' }}>
                ทุกใบถูกนับในโควตาภาพรายเดือน ดูยอดคงเหลือได้ที่หน้าตั้งค่า
              </span>
            </div>
          )}

          {recent.length > 0 && (
            <div style={{ width: '100%' }}>
              <span className="label" style={{ display: 'block', marginBottom: 8 }}>
                ภาพที่เคยสร้าง
              </span>
              <div className="poster-recent">
                {recent.map((r) => (
                  <a key={r.id} className="poster-chip" href={`/poster?photo=${r.assetId}`}
                     title={r.prompt}>
                    <img src={r.url} alt="" loading="lazy" />
                  </a>
                ))}
              </div>
              <span className="hint-sm">
                กดที่รูปเพื่อเอาไปใส่ข้อความที่หน้าโปสเตอร์
              </span>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
