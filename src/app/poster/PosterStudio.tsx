'use client';

import { useActionState, useState } from 'react';
import { makePosterAction } from '../actions.js';
import { Icon } from '../ui.js';

type Tpl = {
  id: string; name: string; hint: string; fields: string[];
  bg: string; accent: string; sample: Record<string, string | undefined>;
};

type Recent = {
  id: string; url: string; templateId: string; aspect: string;
  fields: Record<string, string | undefined>;
};

const FIELD_LABEL: Record<string, string> = {
  headline: 'ข้อความหลัก',
  subline: 'ข้อความรอง',
  price: 'ราคา',
  oldPrice: 'ราคาเดิม (จะถูกขีดฆ่า)',
  note: 'เงื่อนไข / วันที่',
  brand: 'ชื่อร้าน',
};

const FIELD_HINT: Record<string, string> = {
  headline: 'สั้นที่สุดเท่าที่ได้ — คนอ่านโปสเตอร์ผ่านๆ ไม่เกิน 2 วินาที',
  price: 'ใส่สัญลักษณ์เงินเองได้ เช่น ฿240',
};

const ASPECTS = [
  { id: '1:1', label: 'จัตุรัส · ฟีด' },
  { id: '4:5', label: 'แนวตั้ง · ฟีด' },
  { id: '9:16', label: 'สตอรี่' },
];

/**
 * ห้องทำโปสเตอร์
 *
 * ลำดับตรงกับที่คนคิดจริง: เลือกแบบ → ใส่รูปสินค้า → กรอกข้อความ → ดูผล
 * ไม่มีพรีวิวสดขณะพิมพ์โดยตั้งใจ — การประกอบภาพ 1080px ทำที่เซิร์ฟเวอร์
 * ยิงทุกตัวอักษรที่พิมพ์คือการเผาทั้งเวลาและ CPU โดยไม่ได้อะไรกลับมา
 */
export default function PosterStudio({
  templates, recent, brand, madeUrl, madeAsset, presetPhoto,
}: {
  templates: Tpl[]; recent: Recent[]; brand: string;
  madeUrl?: string; madeAsset?: string;
  /** รูปที่ถูกส่งมาจากหน้าอื่น เช่น ภาพที่เพิ่งให้ AI สร้างที่ /image */
  presetPhoto?: { id: string; url: string } | null;
}) {
  const [tplId, setTplId] = useState(templates[0].id);
  const [aspect, setAspect] = useState('4:5');
  const [values, setValues] = useState<Record<string, string>>({ brand });
  const [photo, setPhoto] = useState<string | null>(presetPhoto?.url ?? null);

  // รูปที่เลือกไว้แล้วโดยไม่ได้อัปโหลดในหน้านี้ — ภาพ AI หรือรูปที่ส่งต่อมาจากหน้าอื่น
  const [pickedId, setPickedId] = useState<string | null>(presetPhoto?.id ?? null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);

  /**
   * เรียก API route ไม่ใช่ server action — หน้านี้เป็นฟอร์มเดียวทั้งหน้า
   * ฟอร์มซ้อนฟอร์มทำไม่ได้ และการ submit จะล้างข้อความที่พิมพ์ค้างไว้ทิ้งทั้งหมด
   */
  async function makeScene() {
    setAiBusy(true);
    setAiError(null);
    setAiNote(null);
    try {
      const body = new FormData();
      body.set('mode', 'scene');
      body.set('topic', aiPrompt);
      body.set('aspect', aspect);
      const res = await fetch('/api/ai/image', { method: 'POST', body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'สร้างภาพไม่สำเร็จ');
      setPhoto(json.url);
      setPickedId(json.assetId);
      setAiNote(json.placeholder
        ? 'นี่คือภาพตัวอย่างในเครื่อง ยังไม่ได้ตั้ง OPENROUTER_API_KEY — อย่าเพิ่งส่งให้ลูกค้า'
        : 'ภาพนี้ไม่มีตัวหนังสือโดยตั้งใจ ข้อความไทยจะถูกวาดทับด้วยฟอนต์จริงตอนสร้างโปสเตอร์');
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  const [state, submit, busy] = useActionState(
    makePosterAction, null as { error?: string } | null);

  const tpl = templates.find((t) => t.id === tplId)!;

  function useRecent(r: Recent) {
    setTplId(r.templateId);
    setAspect(r.aspect);
    setValues(Object.fromEntries(
      Object.entries(r.fields).filter(([, v]) => v != null) as Array<[string, string]>,
    ));
  }

  return (
    <>
      <header className="topbar">
        <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
        <span style={{ fontWeight: 700, fontSize: 15 }}>ทำโปสเตอร์สินค้า</span>
        <span className="grow" />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          ตัวหนังสือไทยใช้ฟอนต์จริง คมชัดทุกตัว
        </span>
      </header>

      <form className="studio" action={submit}>
        <input type="hidden" name="templateId" value={tplId} />
        <input type="hidden" name="aspect" value={aspect} />
        <input type="hidden" name="photoAssetId" value={pickedId ?? ''} />

        <section className="studio-form">
          {state?.error && <p className="msg bad">{state.error}</p>}

          {/* 1 · แบบโปสเตอร์ */}
          <div className="field">
            <span className="label">เลือกแบบ</span>
            <div className="tpl-grid">
              {templates.map((t) => (
                <button type="button" key={t.id} className="tpl" data-active={t.id === tplId}
                        onClick={() => setTplId(t.id)} aria-pressed={t.id === tplId}>
                  <span className="tpl-swatch" style={{ background: t.bg }}>
                    <span style={{ background: t.accent }} />
                  </span>
                  <span className="tpl-name">{t.name}</span>
                  <span className="tpl-hint">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 2 · รูปสินค้าจริง */}
          <div className="field">
            <span className="label">รูปสินค้า</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              ถ่ายสินค้าจริงของร้านมาได้เลย ระบบจัดวางให้เอง — ไม่ใส่ก็ได้ จะเป็นโปสเตอร์ข้อความล้วน
            </span>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {photo
                ? <img src={photo} alt="" className="pick-thumb" />
                : <div className="pick-thumb pick-empty"><Icon.plus size={20} /></div>}
              <input name="photo" type="file" accept="image/jpeg,image/png"
                     style={{ flexGrow: 1, minWidth: 200 }}
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       setPhoto(f ? URL.createObjectURL(f) : null);
                       // อัปโหลดเองแล้ว = ทิ้งภาพ AI ที่เลือกไว้ก่อนหน้า ไม่งั้นไม่รู้ว่าใบไหนจะถูกใช้
                       if (f) { setPickedId(null); setAiNote(null); }
                     }} />
            </div>

            {/* ให้ AI สร้างฉากพื้นหลัง — ใช้แทนรูปสินค้าได้เมื่อโพสต์นั้นไม่มีสินค้าให้ถ่าย */}
            <div className="ai-scene">
              <span style={{ fontSize: 13, fontWeight: 600 }}>ไม่มีรูป? ให้ AI สร้างฉากให้</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                เหมาะกับประกาศ วันหยุด หรือโปรที่ไม่มีตัวสินค้า —
                ถ้าเป็นโพสต์ขายของ ใช้รูปสินค้าจริงยังได้ผลกว่าเสมอ
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                       placeholder="เช่น โต๊ะไม้ในร้านกาแฟ แสงเช้า โทนอุ่น"
                       style={{ flexGrow: 1, minWidth: 220 }} />
                <button type="button" className="btn" disabled={aiBusy || !aiPrompt.trim()}
                        onClick={makeScene}>
                  {aiBusy ? 'กำลังสร้างภาพ…' : 'สร้างฉาก'}
                </button>
              </div>
              {aiError && <p className="msg bad" style={{ margin: 0 }}>{aiError}</p>}
              {aiNote && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{aiNote}</span>}
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                อยากเปลี่ยนแค่พื้นหลังของรูปสินค้าจริง หรือทำภาพประกอบโพสต์ →{' '}
                <a href="/image">หน้าสร้างภาพด้วย AI</a>
              </span>
            </div>
          </div>

          {/* 3 · ข้อความ — ช่องเปลี่ยนตามแบบที่เลือก */}
          <div className="field">
            <span className="label">ข้อความบนโปสเตอร์</span>
            {tpl.fields.map((f) => (
              <label key={f} className="field" style={{ gap: 4 }}>
                <span style={{ fontSize: 13 }}>{FIELD_LABEL[f] ?? f}</span>
                <input
                  name={f}
                  value={values[f] ?? ''}
                  placeholder={tpl.sample[f] ?? ''}
                  onChange={(e) => setValues({ ...values, [f]: e.target.value })}
                  required={f === 'headline'}
                />
                {FIELD_HINT[f] && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{FIELD_HINT[f]}</span>
                )}
              </label>
            ))}
          </div>

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

          <div className="actions-bar">
            {busy && (
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>กำลังประกอบโปสเตอร์…</span>
            )}
            <span className="grow" />
            <button className="btn btn-primary" style={{ height: 40, padding: '0 22px' }}
                    disabled={busy || !(values.headline ?? '').trim()}>
              {busy ? 'กำลังสร้าง…' : 'สร้างโปสเตอร์'}
            </button>
          </div>
        </section>

        <aside className="studio-preview">
          {madeUrl ? (
            <>
              <img src={madeUrl} alt="โปสเตอร์ที่สร้างเสร็จ" className="poster-out" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <a className="btn btn-primary" href={`/new?asset=${madeAsset}`}>
                  เอาไปตั้งเวลาโพสต์
                </a>
                <a className="btn" href={madeUrl} download="โปสเตอร์.jpg">ดาวน์โหลด</a>
              </div>
              <p className="note" style={{ maxWidth: 380 }}>
                โปสเตอร์ถูกเก็บเข้าคลังรูปแล้ว เลือกใช้ซ้ำได้ทุกเมื่อ
                — แก้ข้อความแล้วกดสร้างใหม่ได้ ไฟล์เดิมไม่หาย
              </p>
            </>
          ) : (
            <div className="poster-placeholder">
              <Icon.grid size={30} />
              <span style={{ fontSize: 13.5 }}>กรอกข้อความแล้วกด “สร้างโปสเตอร์”</span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 300,
                             textAlign: 'center' }}>
                ระบบจัดวางรูปสินค้ากับข้อความให้ตามแบบที่เลือก ผลลัพธ์เหมือนเดิมทุกครั้ง
              </span>
            </div>
          )}

          {recent.length > 0 && (
            <div style={{ width: '100%' }}>
              <span className="label" style={{ display: 'block', marginBottom: 8 }}>
                โปสเตอร์ที่เคยทำ
              </span>
              <div className="poster-recent">
                {recent.map((r) => (
                  <button type="button" key={r.id} className="poster-chip"
                          onClick={() => useRecent(r)}
                          title="ใช้ข้อความและแบบเดิมนี้ต่อ">
                    <img src={r.url} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                กดที่รูปเพื่อดึงแบบและข้อความเดิมกลับมาแก้
              </span>
            </div>
          )}
        </aside>
      </form>
    </>
  );
}
