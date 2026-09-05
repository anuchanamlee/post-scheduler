'use client';

import { useEffect, useState } from 'react';

/**
 * ข้อความยืนยันผลหลังกดปุ่ม
 *
 * ทุก action ที่เปลี่ยนของจริงจะ redirect กลับมาพร้อม ?flash=<code>
 * ทำแบบนี้เพราะ server action ที่ redirect ไม่มีทางส่ง state กลับมาที่หน้าได้
 * และคนกดปุ่มต้องรู้ว่าเกิดอะไรขึ้น ไม่ใช่เห็นหน้ารีโหลดเฉยๆ
 *
 * ตัวที่แจ้งความสำเร็จหายเองใน 6 วินาที ตัวที่แจ้งความล้มเหลวอยู่จนกว่าจะกดปิด
 * เพราะข้อความผิดพลาดที่หายไปเองคือข้อความที่ไม่มีใครได้อ่าน
 */

const MESSAGES: Record<string, { text: string; tone: 'ok' | 'bad' | 'warn' }> = {
  queued: { text: 'เพิ่มเข้าคิวแล้ว', tone: 'ok' },
  saved: { text: 'บันทึกการแก้ไขแล้ว', tone: 'ok' },
  drafted: { text: 'เก็บเป็นร่างแล้ว ยังไม่ถูกส่งจนกว่าจะกดเข้าคิว', tone: 'ok' },
  cancelled: { text: 'ยกเลิกโพสต์แล้ว', tone: 'ok' },
  retried: { text: 'สั่งส่งช่องทางที่ล้มใหม่แล้ว รอสักครู่แล้วรีเฟรช', tone: 'ok' },
  posting: { text: 'สั่งส่งเดี๋ยวนี้แล้ว ตัวส่งจะหยิบงานภายใน 1 นาที', tone: 'ok' },
  duplicated: { text: 'ทำซ้ำแล้ว — นี่คือสำเนา แก้ให้เรียบร้อยแล้วค่อยกดเข้าคิว', tone: 'ok' },
  voice_saved: { text: 'บันทึกโทนเสียงแล้ว ร่างครั้งต่อไปจะใช้โทนนี้', tone: 'ok' },
  read: { text: 'ทำเครื่องหมายอ่านแล้ว', tone: 'ok' },
  slot_added: { text: 'เพิ่มช่วงเวลาแล้ว โพสต์ใหม่จะไหลลงช่องว่างถัดไปเอง', tone: 'ok' },
  slot_removed: { text: 'ลบช่วงเวลาแล้ว', tone: 'ok' },
  page_connected: { text: 'เชื่อมต่อเพจแล้ว — กดตรวจเพื่อยืนยันว่า token ใช้ได้จริง', tone: 'ok' },
  token_replaced: { text: 'เปลี่ยน token แล้ว — กดตรวจเพื่อยืนยัน', tone: 'ok' },
  connection_ok: { text: 'token ใช้งานได้ ระบบโพสต์ให้ได้ตามปกติ', tone: 'ok' },
  page_disconnected: { text: 'ปิดการใช้งานเพจแล้ว ประวัติโพสต์เก่ายังอยู่ครบ', tone: 'ok' },
  password_changed: {
    text: 'เปลี่ยนรหัสผ่านแล้ว — อุปกรณ์อื่นที่ล็อกอินค้างไว้ถูกเตะออกทั้งหมด', tone: 'ok',
  },
  channel_added: { text: 'เพิ่มช่องทางแจ้งเตือนแล้ว — กดทดสอบเพื่อยืนยันว่าส่งถึงจริง', tone: 'ok' },
  channel_removed: { text: 'ลบช่องทางแจ้งเตือนแล้ว', tone: 'ok' },
  channel_tested: { text: 'ส่งข้อความทดสอบแล้ว ไปเช็คที่ LINE ได้เลย', tone: 'ok' },
  submitted: { text: 'ส่งให้ผู้อนุมัติตรวจแล้ว จะขึ้นคิวเมื่อได้รับอนุมัติ', tone: 'ok' },
  approved: { text: 'อนุมัติแล้ว เข้าคิวรอโพสต์เรียบร้อย', tone: 'ok' },
  approved_late: { text: 'อนุมัติแล้ว แต่เลยเวลาที่ตั้งไว้ — เปิดดูแล้วเลือกว่าจะโพสต์เลยหรือเลื่อน', tone: 'warn' },
  rejected: { text: 'ตีกลับให้แก้แล้ว คนเขียนจะเห็นเหตุผลในหน้าแจ้งเตือน', tone: 'ok' },
  approval_on: { text: 'เปิดขั้นตอนอนุมัติแล้ว งานของผู้เขียนจะต้องผ่านการตรวจก่อน', tone: 'ok' },
  approval_off: { text: 'ปิดขั้นตอนอนุมัติแล้ว โพสต์เข้าคิวได้ทันที', tone: 'ok' },
  role_changed: { text: 'เปลี่ยนสิทธิ์แล้ว', tone: 'ok' },
  user_added: { text: 'เพิ่มผู้ใช้แล้ว', tone: 'ok' },
  user_removed: { text: 'ลบผู้ใช้แล้ว', tone: 'ok' },
  cropped: { text: 'ครอปตามจุดที่เลือกแล้ว ต้นฉบับยังอยู่ครบ', tone: 'ok' },
  variant_made: { text: 'ครอปสัดส่วนใหม่แล้ว ต้นฉบับยังอยู่ครบ', tone: 'ok' },
  asset_deleted: { text: 'ลบไฟล์ออกจากคลังแล้ว', tone: 'ok' },
  tags_saved: { text: 'บันทึกชุดแท็กแล้ว ใช้ได้ทันทีในหน้าเขียนโพสต์', tone: 'ok' },
  tags_removed: { text: 'ลบชุดแท็กแล้ว', tone: 'ok' },
  poster_made: { text: 'สร้างโปสเตอร์แล้ว เก็บเข้าคลังรูปเรียบร้อย', tone: 'ok' },
  nothing: { text: 'ไม่มีอะไรให้ส่งใหม่ — ทุกช่องทางขึ้นเรียบร้อยแล้ว', tone: 'warn' },
  failed: { text: 'ทำรายการไม่สำเร็จ', tone: 'bad' },
};

export default function Flash({ code, detail }: { code: string; detail?: string }) {
  const known = MESSAGES[code];
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!known || known.tone !== 'ok') return;
    const t = setTimeout(() => setOpen(false), 6000);
    return () => clearTimeout(t);
  }, [known]);

  // ลบพารามิเตอร์ออกจาก URL ทันที กันข้อความเด้งซ้ำตอนรีเฟรชหรือกดย้อนกลับ
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('flash')) {
      url.searchParams.delete('flash');
      url.searchParams.delete('detail');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  if (!known || !open) return null;

  return (
    <div className={`flash flash-${known.tone}`} role="status" aria-live="polite">
      <span style={{ flexGrow: 1 }}>
        {known.text}
        {detail && <span style={{ display: 'block', opacity: 0.85 }}>{detail}</span>}
      </span>
      <button type="button" className="flash-close" onClick={() => setOpen(false)}
              aria-label="ปิดข้อความ">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      </button>
    </div>
  );
}
