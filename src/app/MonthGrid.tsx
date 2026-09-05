'use client';

import { useState, type ReactElement } from 'react';
import { movePostAction } from './actions.js';
import { Icon } from './ui.js';

export type MonthPost = {
  id: string;
  time: string;        // HH:MM ตามเวลาไทย
  caption: string;
  status: string;
  image_url: string | null;
  movable: boolean;
};

export type MonthDay = {
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  freeSlots: number;
  posts: MonthPost[];
};

const STATUS_TONE: Record<string, string> = {
  posted: 'posted', partial: 'partial', failed: 'failed',
  missed: 'missed', publishing: 'publishing',
};

/** สถานะต้องอ่านออกโดยไม่พึ่งสี — ในเซลล์เดือนมีที่แค่ไอคอนเล็กหนึ่งตัว */
const STATUS_ICON: Record<string, (p: { size?: number }) => ReactElement> = {
  posted: Icon.check,
  publishing: Icon.clock,
  partial: Icon.half,
  failed: Icon.warning,
  missed: Icon.warning,
};

const STATUS_WORD: Record<string, string> = {
  posted: 'ขึ้นแล้ว', publishing: 'กำลังส่ง', partial: 'ขึ้นไม่ครบ',
  failed: 'ล้มเหลว', missed: 'เลยเวลา', pending: 'รอโพสต์', draft: 'ร่าง',
};

function thaiDay(iso: string) {
  return new Date(iso + 'T00:00:00+07:00').toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * ปฏิทินเดือน
 *
 * เลื่อนโพสต์ได้สองทาง เพราะทางเดียวไม่ครอบคนใช้จริง:
 *   - ลากไปวางบนเดสก์ท็อป (เร็วสุดถ้ามีเมาส์)
 *   - **แตะปุ่มลูกศรแล้วเลือกวัน** — HTML5 drag ไม่ทำงานบนจอสัมผัสเลย
 *     ก่อนหน้านี้ปฏิทินบนมือถือจึงเป็นแค่ของดู เลื่อนโพสต์ไม่ได้สักทาง
 *
 * เวลาในวันคงเดิม เพราะคนที่เลื่อนมักตั้งใจจะ "เลื่อนวัน" ไม่ใช่เปลี่ยนเวลาที่คิดมาแล้ว
 * ลากหรือเลื่อนได้เฉพาะโพสต์ที่ยังไม่ออก
 */
export default function MonthGrid({ days, dows }: { days: MonthDay[]; dows: string[] }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [sheet, setSheet] = useState<{ post: MonthPost; from: string } | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  async function move(id: string, dayIso: string) {
    // ย้ายในหน้าจอทันที ไม่รอเซิร์ฟเวอร์ — การเลื่อนที่ไม่ขยับตามมือรู้สึกเหมือนพัง
    setPending((p) => ({ ...p, [id]: dayIso }));
    setNote(null);
    try {
      const r = await movePostAction(newForm(id, dayIso));
      // ผลลัพธ์ต้องบอก ไม่ใช่ทิ้งค่าที่ action คืนมาแล้วปล่อยให้กลายเป็น missed เงียบๆ
      setNote(r?.past
        ? { kind: 'warn', text: `เลื่อนไป ${thaiDay(dayIso)} แล้ว — วันนี้ผ่านมาแล้ว โพสต์จะถูกนับว่าเลยเวลา` }
        : { kind: 'ok', text: `เลื่อนไป ${thaiDay(dayIso)} แล้ว เวลาเดิมคงไว้` });
    } catch (err) {
      // ย้ายไม่สำเร็จ = ต้องคืนการ์ดกลับที่เดิม ไม่ใช่ค้างผิดที่ทั้งที่ฐานข้อมูลไม่เปลี่ยน
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      setNote({ kind: 'bad', text: (err as Error).message || 'เลื่อนไม่สำเร็จ' });
    }
  }

  function newForm(id: string, dayIso: string) {
    const form = new FormData();
    form.set('postId', id);
    form.set('day', dayIso);
    return form;
  }

  async function drop(dayIso: string) {
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (!id) return;
    await move(id, dayIso);
  }

  /** วันที่เลือกได้ในแผงเลื่อน — เริ่มจากวันถัดจากวันเดิม ให้พอกดจบในจอเดียว */
  const targets = (from: string) => {
    const start = days.findIndex((d) => d.iso === from);
    return days.slice(start + 1).filter((d) => d.inMonth).slice(0, 9);
  };

  return (
    <>
      {note && (
        <p className={`msg ${note.kind}`} role="status" style={{ marginTop: 0 }}>
          {note.text}
        </p>
      )}

      <div className="month-grid" role="grid">
        {dows.map((d) => <span key={d} className="month-dow">{d}</span>)}

        {days.map((day) => {
          const posts = day.posts.filter((p) => pending[p.id] !== undefined
            ? pending[p.id] === day.iso
            : true);
          const moved = days.flatMap((d) => d.posts)
            .filter((p) => pending[p.id] === day.iso
              && !day.posts.some((x) => x.id === p.id));
          const shown = [...posts, ...moved];

          return (
            <div
              key={day.iso}
              className="month-cell"
              data-today={day.isToday}
              data-dim={!day.inMonth}
              data-over={over === day.iso}
              onDragOver={(e) => { e.preventDefault(); setOver(day.iso); }}
              onDragLeave={() => setOver((o) => (o === day.iso ? null : o))}
              onDrop={(e) => { e.preventDefault(); void drop(day.iso); }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <a className="num month-date" href={`?view=calendar&day=${day.iso}`}>
                  {Number(day.iso.slice(8))}
                </a>
                <span className="grow" />
                {shown.length === 0 && day.freeSlots > 0 && (
                  <span className="month-free">{day.freeSlots} ช่องว่าง</span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: 4 }}>
                {shown.slice(0, 4).map((p) => {
                  const StatusIcon = STATUS_ICON[p.status];
                  const word = STATUS_WORD[p.status] ?? p.status;
                  return (
                    <div
                      key={p.id}
                      className="month-post"
                      data-tone={STATUS_TONE[p.status] ?? 'pending'}
                      data-dragging={dragging === p.id}
                      draggable={p.movable}
                      onDragStart={() => setDragging(p.id)}
                      onDragEnd={() => { setDragging(null); setOver(null); }}
                      title={`${p.time} · ${word} · ${p.caption}`}
                    >
                      {StatusIcon && (
                        <span className="month-post-icon" aria-hidden="true">
                          <StatusIcon size={11} />
                        </span>
                      )}
                      <span className="num month-post-time">{p.time}</span>
                      <span className="month-post-cap">{p.caption}</span>
                      {p.movable && (
                        <button
                          type="button"
                          className="month-move"
                          aria-label={`เลื่อนวันของโพสต์ ${p.time}`}
                          onClick={() => setSheet({ post: p, from: day.iso })}
                        >
                          <Icon.move size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {shown.length > 4 && (
                  <a className="month-free" href={`?view=calendar&day=${day.iso}`}>
                    อีก {shown.length - 4} โพสต์
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sheet && (
        <div className="month-sheet-back" role="dialog" aria-modal="true"
             aria-label="เลื่อนวันของโพสต์"
             onClick={(e) => { if (e.target === e.currentTarget) setSheet(null); }}>
          <div className="month-sheet">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14.5, flexGrow: 1 }}>เลื่อนไปวันไหน</span>
              <button type="button" className="btn sheet-close" onClick={() => setSheet(null)}
                      aria-label="ปิด">
                <Icon.close />
              </button>
            </div>

            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {sheet.post.time} · {sheet.post.caption} — เวลาในวันคงเดิม
            </span>

            <div className="month-sheet-days">
              {targets(sheet.from).map((d) => (
                <button
                  key={d.iso}
                  type="button"
                  className="btn"
                  onClick={() => {
                    const p = sheet.post;
                    setSheet(null);
                    void move(p.id, d.iso);
                  }}
                >
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {d.isToday ? 'วันนี้' : thaiDay(d.iso).split(' ')[0]}
                  </span>
                  <span className="num" style={{ fontSize: 14, fontWeight: 700 }}>
                    {Number(d.iso.slice(8))}
                  </span>
                </button>
              ))}
            </div>

            {targets(sheet.from).length === 0 && (
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                เดือนนี้ไม่มีวันถัดไปแล้ว — เปิดเดือนถัดไปแล้วลากวางแทน
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
