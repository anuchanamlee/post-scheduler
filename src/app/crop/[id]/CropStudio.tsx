'use client';

import { useActionState, useRef, useState } from 'react';
import { cropAction } from '../../actions.js';
import { Icon } from '../../ui.js';

type Spec = { id: string; w: number; h: number; label: string };

/**
 * เลือกกรอบครอปเอง
 *
 * ของเดิมให้ sharp เดาจุดสำคัญเอง (`position: attention`) ซึ่งเดาถูกบ้างผิดบ้าง
 * — ตัดหัวคนในรูปหมู่ ตัดสินค้าออกเหลือแต่พื้นหลัง แล้วเจ้าของร้านมารู้ตอนโพสต์ขึ้นแล้ว
 *
 * พรีวิวใช้ CSS `object-position` เป็นเปอร์เซ็นต์ ซึ่งให้ผลตรงกับที่เซิร์ฟเวอร์จะครอปจริง
 * เพราะฝั่งเซิร์ฟเวอร์คำนวณกรอบจากจุดเดียวกัน — ที่เห็นคือที่ได้ ไม่ต้องกดแล้วลุ้น
 */
export default function CropStudio({
  assetId, url, width, height, specs, existing,
}: {
  assetId: string;
  url: string;
  width: number;
  height: number;
  specs: Spec[];
  existing: Array<{ aspect_ratio: string; url: string; focus: { x: number; y: number } | null }>;
}) {
  const [aspect, setAspect] = useState(specs[0].id);
  const [focus, setFocus] = useState<{ x: number; y: number }>(() => {
    const prev = existing.find((e) => e.aspect_ratio === specs[0].id)?.focus;
    return prev ?? { x: 0.5, y: 0.5 };
  });
  const imgRef = useRef<HTMLImageElement>(null);

  const [state, submit, busy] = useActionState(
    cropAction, null as { error?: string } | null);

  const spec = specs.find((s) => s.id === aspect)!;

  function pick(e: React.MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    setFocus({
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    });
  }

  // กรอบที่จะถูกใช้จริง คำนวณแบบเดียวกับฝั่งเซิร์ฟเวอร์
  const scale = Math.max(spec.w / width, spec.h / height);
  const cropW = Math.min(width, spec.w / scale);
  const cropH = Math.min(height, spec.h / scale);
  const left = Math.max(0, Math.min(width - cropW, focus.x * width - cropW / 2));
  const top = Math.max(0, Math.min(height - cropH, focus.y * height - cropH / 2));

  return (
    <form className="crop" action={submit}>
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="aspect" value={aspect} />
      <input type="hidden" name="focusX" value={focus.x.toFixed(4)} />
      <input type="hidden" name="focusY" value={focus.y.toFixed(4)} />

      <section className="crop-left">
        {state?.error && <p className="msg bad">{state.error}</p>}

        <div className="field">
          <span className="label">สัดส่วนที่ต้องการ</span>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {specs.map((s) => (
              <button type="button" key={s.id} className="btn btn-sm"
                      data-chosen={aspect === s.id} aria-pressed={aspect === s.id}
                      onClick={() => {
                        setAspect(s.id);
                        const prev = existing.find((e) => e.aspect_ratio === s.id)?.focus;
                        if (prev) setFocus(prev);
                      }}>
                {s.id} · {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="label">คลิกตรงจุดที่ต้องให้อยู่ในกรอบ</span>
          <span className="hint">
            เช่น หน้าคน หรือตัวสินค้า — กรอบสีจะเลื่อนตาม
          </span>

          <div className="crop-canvas" onClick={pick}>
            <img ref={imgRef} src={url} alt="" draggable={false} />
            <span
              className="crop-frame"
              style={{
                left: `${(left / width) * 100}%`,
                top: `${(top / height) * 100}%`,
                width: `${(cropW / width) * 100}%`,
                height: `${(cropH / height) * 100}%`,
              }}
            />
            <span
              className="crop-dot"
              style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }}
            />
          </div>

          <span className="num hint-sm">
            ต้นฉบับ {width} × {height} · จะได้ {spec.w} × {spec.h}
          </span>
        </div>

        <div className="actions-bar">
          {busy && <span className="hint">กำลังครอป…</span>}
          <span className="grow" />
          <button type="button" className="btn" onClick={() => setFocus({ x: 0.5, y: 0.5 })}>
            กลับไปกึ่งกลาง
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'กำลังครอป…' : 'ครอปตามนี้'}
          </button>
        </div>
      </section>

      <aside className="crop-right">
        <span className="label">ผลที่จะได้</span>
        <div className="crop-preview" style={{ aspectRatio: `${spec.w} / ${spec.h}` }}>
          <img
            src={url}
            alt="ตัวอย่างหลังครอป"
            style={{ objectPosition: `${focus.x * 100}% ${focus.y * 100}%` }}
          />
        </div>

        {existing.length > 0 && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="label">สัดส่วนที่ครอปไว้แล้ว</span>
            <div className="chips">
              {existing.map((e) => (
                <a key={e.aspect_ratio} className="pill" href={e.url}
                   target="_blank" rel="noreferrer">
                  {e.aspect_ratio}
                  {e.focus ? ' · เลือกจุดเอง' : ' · ระบบเดา'}
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="note" style={{ maxWidth: 340 }}>
          <Icon.info size={14} /> ครอปกี่สัดส่วนก็ได้ ต้นฉบับไม่ถูกแตะ —
          กลับมาเปลี่ยนจุดใหม่ได้ตลอด
        </p>

        <a className="btn" href="/library">กลับไปคลังรูป</a>
      </aside>
    </form>
  );
}
