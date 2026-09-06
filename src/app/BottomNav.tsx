'use client';

import { usePathname } from 'next/navigation';
import { Icon } from './ui.js';

/**
 * แถบทางเข้าหลักด้านล่าง — มีเฉพาะจอแคบ
 *
 * ทำไมต้องมี: แถบบนของหน้าคิวมีปุ่ม 8 อันเรียงกัน พอจอแคบมันตัดบรรทัดลงมาเป็นกำแพงปุ่ม
 * ที่ไม่มีลำดับความสำคัญ — เจ้าของร้านหาทางไปหน้าที่ต้องการไม่เจอ
 * ปลายทางที่ใช้บ่อยจริง 5 ทางจึงย้ายลงล่างในระยะนิ้วโป้ง แบบเดียวกับแอปที่คนใช้อยู่แล้ว
 *
 * ไม่โผล่ที่หน้าเข้าสู่ระบบ (ยังไม่มีสิทธิ์ไปไหน) และหน้าที่เป็น "งานเต็มจอ"
 * อย่างเขียนโพสต์/ครอป — หน้าพวกนั้นมีปุ่มลงมือติดขอบล่างของตัวเองอยู่แล้ว จะชนกัน
 */

const ITEMS = [
  { href: '/', label: 'คิว', icon: Icon.calendar, match: (p: string) => p === '/' },
  { href: '/image', label: 'ทำภาพ', icon: Icon.sparkle, match: (p: string) => p.startsWith('/image') || p.startsWith('/poster') },
  { href: '/library', label: 'คลังรูป', icon: Icon.photo, match: (p: string) => p.startsWith('/library') },
  { href: '/insights', label: 'ผลตอบรับ', icon: Icon.chart, match: (p: string) => p.startsWith('/insights') },
  { href: '/settings', label: 'ตั้งค่า', icon: Icon.settings, match: (p: string) => p.startsWith('/settings') },
];

/** หน้าที่มีแถบปุ่มของตัวเองติดขอบล่าง หรือยังไม่ได้ล็อกอิน */
const HIDE_ON = ['/login', '/new', '/post/', '/crop/'];

export default function BottomNav() {
  const pathname = usePathname() ?? '/';
  if (HIDE_ON.some((p) => pathname === p || pathname.startsWith(p))) return null;

  return (
    <nav className="bottom-nav" aria-label="ทางเข้าหลัก">
      {ITEMS.map((it) => {
        const on = it.match(pathname);
        return (
          <a key={it.href} href={it.href} data-active={on}
             aria-current={on ? 'page' : undefined}>
            <it.icon size={20} />
            <span>{it.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
