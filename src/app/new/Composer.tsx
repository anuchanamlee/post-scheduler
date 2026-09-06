'use client';

import { useActionState, useMemo, useState } from 'react';
import { createPostAction, draftCaptionAction, updatePostAction } from '../actions.js';
import { Icon } from '../ui.js';

/** Instagram รับ carousel ได้สูงสุด 10 ใบ ใช้เพดานเดียวกันทุกปลายทาง */
const MAX_MEDIA = 10;

type Page = { id: string; display_name: string; platform: string; tone: string | null };

export type Initial = {
  id: string;
  caption: string;
  scheduledAt: string;   // ค่า datetime-local ตามเวลาไทย
  assetId: string | null;
  imageUrl: string | null;
  media: Array<{ asset_id: string; url: string }>;
  pageIds: string[];
  status: string;
};

/**
 * หน้าเขียนโพสต์ — ใช้ทั้งตอนสร้างใหม่และตอนแก้ของเดิม
 *
 * ลำดับบนหน้าตรงกับลำดับที่คนคิดจริง: จะลงที่ไหน → เขียนอะไร → รูปไหน → เมื่อไหร่
 * ปลายทางมาก่อนเพราะมันเปลี่ยนกติกาของทุกอย่างข้างล่าง (ความยาวแคปชั่น เกณฑ์รูป)
 * ฝั่งขวาแสดงของจริงที่จะขึ้นบนเพจ เพื่อไม่ต้องเดา
 */
export default function Composer({
  pages, quotaUsed, quotaCap, initial, justSaved, freeSlots = [], preloaded, tagSets = [],
}: {
  pages: Page[];
  quotaUsed: number;
  quotaCap: number;
  initial?: Initial;
  justSaved?: boolean;
  /** รูปที่ส่งมาจากห้องทำโปสเตอร์ ใช้เป็นรูปตั้งต้นของโพสต์ */
  preloaded?: { asset_id: string; url: string };
  /** ชุดแท็กประจำที่ตั้งไว้ในหน้าตั้งค่า */
  tagSets?: Array<{ id: string; name: string; tags: string[]; is_default: boolean }>;
  /** ช่องเวลาว่างถัดไปจากตารางประจำ — ส่งมาจากเซิร์ฟเวอร์เพราะต้องรู้ว่าช่องไหนถูกจองแล้ว */
  freeSlots?: { iso: string; label: string }[];
}) {
  const editing = Boolean(initial);

  const [selected, setSelected] = useState<string[]>(
    initial ? initial.pageIds : pages.map((p) => p.id));
  const [caption, setCaption] = useState(initial?.caption ?? '');
  const [preview, setPreview] = useState<string>(pages[0]?.platform ?? 'facebook');
  // รูปเดิมของโพสต์ที่ยังไม่ถูกแทนที่ กับรูปใหม่ที่เพิ่งเลือกจากเครื่อง
  const [keptMedia] = useState(
    initial?.media ?? (preloaded ? [preloaded] : []));
  const [picked, setPicked] = useState<Array<{ url: string; w: number; h: number; kb: number }>>([]);
  const [replacingImage, setReplacingImage] = useState(!editing && !preloaded);
  const [slide, setSlide] = useState(0);
  const [slot, setSlot] = useState(initial ? 3 : 0);
  const [customAt, setCustomAt] = useState(initial?.scheduledAt ?? '');
  const [aiOpen, setAiOpen] = useState(false);
  const [voicePage, setVoicePage] = useState(pages[0]?.id ?? '');

  const [state, submit, busy] = useActionState(
    editing ? updatePostAction : createPostAction, null as { error?: string } | null);
  const [draftState, draft, drafting] = useActionState(
    draftCaptionAction,
    null as {
      options?: string[]; suggestedTags?: string[]; model?: string; error?: string;
    } | null);

  const slots = useMemo(() => {
    // มีตารางประจำแล้วก็ไม่ต้องให้คนคิดเรื่องเวลาเอง — ต่อคิวลงช่องว่างถัดไปเลย
    if (freeSlots.length) {
      return freeSlots.slice(0, 3).map((s, i) => ({
        label: i === 0 ? `ช่องถัดไป · ${s.label}` : s.label,
        date: new Date(s.iso),
      }));
    }
    const now = new Date();
    const at = (addDays: number, h: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + addDays);
      d.setHours(h, 0, 0, 0);
      return d;
    };
    return [
      { label: 'อีก 1 ชั่วโมง', date: new Date(now.getTime() + 3600_000) },
      { label: 'พรุ่งนี้ 09:00', date: at(1, 9) },
      { label: 'พรุ่งนี้ 18:00', date: at(1, 18) },
    ];
  }, [freeSlots]);

  const custom = slot >= slots.length;
  const chosenDate = custom ? (customAt ? new Date(customAt) : null) : slots[slot].date;
  const scheduledValue = chosenDate ? toLocalInput(chosenDate) : '';

  const igSelected = pages.some((p) => selected.includes(p.id) && p.platform === 'instagram');
  const limit = igSelected ? 2200 : 5000;
  const overLimit = caption.length > limit;

  // ชุดรูปที่จะใช้จริง — เลือกใหม่ = แทนที่ทั้งชุด ไม่เลือก = ใช้ของเดิม
  const shots = picked.length ? picked.map((p) => p.url) : keptMedia.map((m) => m.url);
  const hasImage = shots.length > 0;
  const isCarousel = shots.length > 1;
  const cur = shots[Math.min(slide, Math.max(0, shots.length - 1))];

  const igWillCrop = picked.some((p) => p.w > 0 && (p.w / p.h < 0.8 || p.w / p.h > 1.91));
  const heavy = picked.find((p) => p.kb > 3000);

  const previewPage = pages.find((p) => p.platform === preview) ?? pages[0];
  const voice = pages.find((p) => p.id === voicePage);

  const tagCount = (caption.match(/#[^\s#]+/g) ?? []).length;
  const tooManyTags = igSelected && tagCount > 30;

  const blocked = selected.length === 0 || overLimit || !scheduledValue
    || !hasImage || tooManyTags;

  /** ต่อแท็กท้ายแคปชั่น ข้ามอันที่มีอยู่แล้ว */
  function addTags(text: string, tags: string[]): string {
    const existing = new Set((text.match(/#[^\s#]+/g) ?? []).map((t) => t.toLowerCase()));
    const add = tags.filter((t) => !existing.has(t.toLowerCase()));
    if (add.length === 0) return text;
    return `${text.trimEnd()}\n\n${add.join(' ')}`;
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, MAX_MEDIA);
    if (!files.length) return;
    setSlide(0);
    Promise.all(files.map((file) =>
      new Promise<{ url: string; w: number; h: number; kb: number }>((res) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        const kb = Math.round(file.size / 1024);
        img.onload = () => res({ url, w: img.naturalWidth, h: img.naturalHeight, kb });
        img.onerror = () => res({ url, w: 0, h: 0, kb });
        img.src = url;
      }),
    )).then(setPicked);
  }

  return (
    <form className="composer" action={submit}>
      {selected.map((id) => <input key={id} type="hidden" name="pages" value={id} />)}
      <input type="hidden" name="scheduledAt" value={scheduledValue} />
      {initial && <input type="hidden" name="postId" value={initial.id} />}
      {/* รูปเดิมที่ยังใช้อยู่ ส่งกลับไปบอกเซิร์ฟเวอร์ว่าไม่ได้ตั้งใจลบทิ้ง */}
      {picked.length === 0 && keptMedia.map((m) => (
        <input key={m.asset_id} type="hidden" name="assetId" value={m.asset_id} />
      ))}

      <section className="composer-form">
        <header className="topbar" style={{ margin: '-20px -20px 0' }}>
          <a className="btn" href="/" aria-label="กลับไปหน้าคิว"><Icon.back /></a>
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {editing ? 'แก้ไขโพสต์' : 'โพสต์ใหม่'}
          </span>
          <span className="grow" />
          <span className="num" style={{
            fontSize: 12, color: selected.length ? 'var(--muted)' : 'var(--bad)',
          }}>
            {selected.length} ปลายทาง
          </span>
        </header>

        {justSaved && (
          <p className="msg ok">
            บันทึกโพสต์ก่อนหน้าเข้าคิวแล้ว — กรอกโพสต์ถัดไปต่อได้เลย
          </p>
        )}
        {state?.error && <p className="msg bad">{state.error}</p>}

        {/* 1 · ปลายทาง */}
        <div className="field">
          <span className="label">โพสต์ลงที่ไหน</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pages.map((p) => {
              const on = selected.includes(p.id);
              return (
                <button
                  type="button"
                  key={p.id}
                  className="target"
                  data-active={on}
                  aria-pressed={on}
                  onClick={() =>
                    setSelected(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])}
                >
                  <span className="target-icon" data-platform={p.platform}>
                    {p.platform === 'instagram' ? 'IG' : 'FB'}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{p.display_name}</span>
                    <span className="hint-sm">
                      {p.platform === 'instagram' ? 'Instagram' : 'Facebook'}
                    </span>
                  </span>
                  <span className="target-check" aria-hidden="true">
                    {on && <Icon.check size={12} />}
                  </span>
                </button>
              );
            })}
          </div>
          {selected.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--bad)' }}>เลือกอย่างน้อย 1 ช่องทาง</span>
          )}
        </div>

        {/* 2 · แคปชั่น + ผู้ช่วย อยู่ในสายตาเดียวกัน */}
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="label">แคปชั่น</span>
            <span className="grow" />
            <button
              type="button"
              className="btn btn-sm"
              style={{ color: 'var(--accent)', borderColor: 'var(--accent-line)' }}
              onClick={() => setAiOpen(!aiOpen)}
              aria-expanded={aiOpen}
            >
              <Icon.sparkle size={13} />ให้ AI ช่วยร่าง
            </button>
          </div>

          <textarea
            name="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="พิมพ์เอง หรือกดใช้ร่างจากผู้ช่วย"
            aria-describedby="cap-count"
          />
          <div id="cap-count" style={{
            display: 'flex', gap: 10, fontSize: 12, flexWrap: 'wrap',
            color: overLimit ? 'var(--bad)' : 'var(--muted)',
          }}>
            <span className="num">{caption.length} / {limit} ตัวอักษร</span>
            {overLimit && <span>ยาวเกินที่ {igSelected ? 'Instagram' : 'Facebook'} รับได้</span>}
            {tooManyTags && <span style={{ color: 'var(--bad)' }}>แท็กเกิน 30 อัน</span>}
            <span className="grow" />
            {tagCount > 0 && (
              <span className="num" style={{ color: tagCount > 30 ? 'var(--bad)' : undefined }}>
                {tagCount} แท็ก{tagCount > 30 ? ' — Instagram รับได้ 30' : ''}
              </span>
            )}
            {voice?.tone && <span>โทน: {voice.tone.slice(0, 28)}</span>}
          </div>

          {(tagSets.length > 0 || draftState?.suggestedTags?.length) && (
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
              {tagSets.map((set) => (
                <button type="button" key={set.id} className="btn btn-sm"
                        title={set.tags.join(' ')}
                        onClick={() => setCaption(addTags(caption, set.tags))}>
                  + {set.name}
                  <span className="num" style={{ opacity: 0.6 }}>{set.tags.length}</span>
                </button>
              ))}
              {draftState?.suggestedTags && draftState.suggestedTags.length > 0 && (
                <button type="button" className="btn btn-sm"
                        style={{ color: 'var(--accent)', borderColor: 'var(--accent-line)' }}
                        title={draftState.suggestedTags.join(' ')}
                        onClick={() => setCaption(addTags(caption, draftState.suggestedTags!))}>
                  + แท็กที่ AI เสนอ
                  <span className="num" style={{ opacity: 0.6 }}>
                    {draftState.suggestedTags.length}
                  </span>
                </button>
              )}
              <a href="/settings#tags" style={{ fontSize: 12 }}>แก้ชุดแท็ก</a>
            </div>
          )}

          {aiOpen && (
            <div className="ai-box">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label className="field" style={{ flexGrow: 1, minWidth: 180 }}>
                  <span className="label">ร่างตามโทนของเพจ</span>
                  <select name="pageId" value={voicePage}
                          onChange={(e) => setVoicePage(e.target.value)}>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>{p.display_name}</option>
                    ))}
                  </select>
                </label>
                <span className="num hint-sm">
                  ใช้ไป {quotaUsed}/{quotaCap} ครั้งเดือนนี้
                </span>
              </div>

              <label className="field">
                <span className="label">หัวข้อ/ประเด็น</span>
                <input name="topic" placeholder="เช่น โปรโมชั่นลด 20% สินค้า A" />
              </label>

              <button className="btn btn-sm" formAction={draft} disabled={drafting}>
                {drafting ? 'กำลังร่าง…' : 'ร่างให้ 3 แบบ'}
              </button>

              {draftState?.error && <p className="msg bad">{draftState.error}</p>}
              {draftState?.options?.map((o, i) => (
                <button type="button" key={i} className="draft"
                        onClick={() => setCaption(o.split('\n[ร่างจากโทน')[0])}>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{o}</span>
                  <span className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>ใช้แบบนี้</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 3 · รูป — หลายใบได้ ใบแรกเป็นรูปหลักที่ใช้เป็นรูปย่อ */}
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="label">รูป</span>
            {hasImage && (
              <span className="hint-sm">
                {shots.length} ใบ{isCarousel ? ' · ผู้ชมเลื่อนดูได้บนโพสต์จริง' : ''}
              </span>
            )}
            <span className="grow" />
            <span className="hint-sm">สูงสุด {MAX_MEDIA} ใบ</span>
          </div>

          {hasImage && (
            <div className="media-strip">
              {shots.map((url, i) => (
                <button type="button" key={url + i} className="media-thumb"
                        data-active={i === slide} onClick={() => setSlide(i)}
                        aria-label={'ดูรูปที่ ' + (i + 1)}>
                  <img src={url} alt="" />
                  <span className="media-num">{i + 1}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!replacingImage ? (
              <>
                <span className="hint">
                  {preloaded && !editing ? 'ใช้โปสเตอร์ที่เพิ่งสร้าง' : 'ใช้รูปเดิมของโพสต์นี้'}
                </span>
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }}
                        onClick={() => setReplacingImage(true)}>
                  เปลี่ยนรูปทั้งชุด
                </button>
              </>
            ) : (
              <input name="image" type="file" accept="image/jpeg,image/png" multiple
                     onChange={onFiles} required={!editing && !hasImage} />
            )}

            {picked.length > 0 && igSelected && (
              <span style={{ fontSize: 12.5, color: igWillCrop ? 'var(--warn)' : 'var(--ok)' }}>
                {igWillCrop
                  ? 'บางใบสัดส่วนไม่ผ่านเกณฑ์ Instagram จะถูกครอปเป็น 4:5 ให้ — ต้นฉบับยังอยู่ครบ'
                  : 'Instagram รับได้ตามต้นฉบับทุกใบ'}
              </span>
            )}
            {heavy && (
              <span className="hint">
                มีไฟล์ใหญ่กว่า 3 MB ตอนกดบันทึกอาจใช้เวลาสักครู่บนเน็ตมือถือ
              </span>
            )}
          </div>
        </div>

        {/* 4 · เวลา — ทางลัดก่อน ปฏิทินไว้ทีหลัง */}
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="label">เวลาที่จะโพสต์</span>
            <span className="grow" />
            {freeSlots.length > 0 && (
              <a href="/settings#schedule" style={{ fontSize: 12 }}>แก้ตารางเวลาประจำ</a>
            )}
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {slots.map((s, i) => (
              <button type="button" key={s.label} className="btn btn-sm"
                      aria-pressed={slot === i} data-chosen={slot === i}
                      onClick={() => setSlot(i)}>
                {s.label}
              </button>
            ))}
            <button type="button" className="btn btn-sm"
                    aria-pressed={custom} data-chosen={custom}
                    onClick={() => setSlot(slots.length)}>
              เลือกเอง
            </button>
          </div>

          {custom ? (
            <input type="datetime-local" value={customAt}
                   onChange={(e) => setCustomAt(e.target.value)}
                   aria-label="วันเวลาที่จะโพสต์" />
          ) : (
            <div className="when">
              <Icon.clock />
              <span className="num" style={{ fontWeight: 500 }}>
                {chosenDate?.toLocaleString('th-TH', {
                  weekday: 'short', day: 'numeric', month: 'short',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>
            </div>
          )}
        </div>

        {/* ปุ่มลงมือ ค้างอยู่ล่างจอ กดได้โดยไม่ต้องเลื่อนกลับ */}
        <div className="actions-bar">
          {busy && (
            <span className="hint">
              {picked.length
                ? 'กำลังอัปโหลดรูป ' + picked.length + ' ใบและบันทึก…'
                : 'กำลังบันทึก…'}
            </span>
          )}
          <span className="grow" />

          {!editing && (
            <>
              <button className="btn" name="intent" value="draft" disabled={busy || blocked}>
                เก็บเป็นร่าง
              </button>
              <button className="btn" name="intent" value="save_and_new" disabled={busy || blocked}>
                บันทึกแล้วเพิ่มอีก
              </button>
            </>
          )}
          {editing && initial?.status === 'draft' && (
            <button className="btn" name="intent" value="queue" disabled={busy || blocked}>
              บันทึกแล้วเข้าคิว
            </button>
          )}

          <button className="btn btn-primary" style={{ height: 40, padding: '0 22px' }}
                  name="intent" value="save" disabled={busy || blocked}>
            {busy ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'เพิ่มเข้าคิว'}
          </button>
        </div>
      </section>

      {/* ฝั่งขวา: ของจริงที่จะขึ้นบนเพจ */}
      <aside className="composer-preview" aria-label="ตัวอย่างโพสต์">
        <div className="tabs" style={{ alignSelf: 'center' }}>
          {pages.map((p) => (
            <button type="button" key={p.id} className="tab"
                    data-active={preview === p.platform}
                    onClick={() => setPreview(p.platform)}>
              ดูแบบบน {p.platform === 'instagram' ? 'Instagram' : 'Facebook'}
            </button>
          ))}
        </div>

        {preview === 'instagram' ? (
          <div className="mock mock-ig">
            <div className="mock-head">
              <span className="avatar" data-platform="instagram">IG</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{previewPage?.display_name}</span>
            </div>
            <div className="mock-square">
              {hasImage ? <img src={cur} alt="" />
                        : <span className="mock-noimg">ยังไม่ได้เลือกรูป</span>}
              {isCarousel && <span className="mock-count">{slide + 1}/{shots.length}</span>}
            </div>
            {isCarousel && (
              <div className="mock-dots" aria-hidden="true">
                {shots.map((_, i) => <span key={i} data-on={i === slide} />)}
              </div>
            )}
            <p className="mock-cap">
              <b>{previewPage?.display_name}</b> {caption || 'แคปชั่นจะขึ้นตรงนี้'}
            </p>
          </div>
        ) : (
          <div className="mock">
            <div className="mock-head">
              <span className="avatar" data-platform="facebook">FB</span>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{previewPage?.display_name}</span>
                <span className="num hint-sm">
                  {chosenDate?.toLocaleString('th-TH', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  }) ?? 'ยังไม่ได้เลือกเวลา'} · สาธารณะ
                </span>
              </span>
            </div>
            <p className="mock-cap">{caption || 'แคปชั่นจะขึ้นตรงนี้'}</p>
            <div className="mock-wide">
              {hasImage ? <img src={cur} alt="" />
                        : <span className="mock-noimg">ยังไม่ได้เลือกรูป</span>}
              {isCarousel && <span className="mock-count">{slide + 1}/{shots.length}</span>}
            </div>
          </div>
        )}

        {preview === 'instagram' && igWillCrop && (
          <p className="msg warn" style={{ maxWidth: 400 }}>
            รูปต้นฉบับสัดส่วนอยู่นอกช่วงที่ Instagram รับ (0.80–1.91) ระบบจะครอปเป็น 4:5 ให้อัตโนมัติ
            — กรอบด้านบนคือส่วนที่จะถูกใช้
          </p>
        )}
      </aside>
    </form>
  );
}

/** ค่า datetime-local ต้องเป็นเวลาท้องถิ่นของเบราว์เซอร์ ไม่ใช่ ISO แบบ UTC */
function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
