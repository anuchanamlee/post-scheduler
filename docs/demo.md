# เดโมสาธารณะ (ฟรี)

ให้คนกดลองระบบจริงได้โดยไม่ต้องมี Meta App, OpenRouter key หรือ S3
ทุกอย่างวิ่งด้วย provider แบบ `mock` — โพสต์ที่ "ส่งแล้ว" ไปขึ้นที่ `/mock-feed`

## ขึ้นบน Render

1. สมัคร/เข้าสู่ระบบ [Render](https://render.com) ด้วย GitHub
2. **New → Blueprint** → เลือก repo นี้ → Render อ่าน `render.yaml` แล้วสร้างให้สองอย่าง
   - `post-scheduler-demo` — เว็บ + worker ใน container เดียว (`scripts/demo-boot.sh`)
   - `post-scheduler-demo-db` — PostgreSQL
3. รอ build เสร็จ แล้วเปิด URL ที่ Render ให้มา
   เข้าสู่ระบบด้วย `owner@example.com` / `demo1234`

ครั้งแรกใช้เวลาหลายนาที (build image) แผนฟรีจะหลับเมื่อไม่มีคนเข้าสักพัก
คนแรกที่เข้ามาหลังจากนั้นต้องรอเครื่องตื่นราวหนึ่งนาที

ตรวจสอบเงื่อนไขแผนฟรีของ Render ล่าสุดก่อนใช้ (เช่น อายุของฐานข้อมูลฟรี)
ถ้าฐานข้อมูลฟรีหมดอายุ ใช้ PostgreSQL ฟรีเจ้าอื่นแทนได้ เช่น Neon
แค่ตั้ง `DATABASE_URL` ของ service เป็น connection string ใหม่ แล้วลบส่วน `databases:` ออก

## ต่างจากโปรดักชันอย่างไร

| | เดโม (`render.yaml`) | โปรดักชัน (`docs/deploy.md`) |
|---|---|---|
| ข้อมูล | ล้างแล้ว seed ใหม่ทุกครั้งที่บูต (`DEMO_RESET_ON_BOOT=1`) | ไม่เคยถูกล้าง |
| worker | process เดียวกับเว็บ หยุดเมื่อเครื่องหลับ | container แยก |
| ปลายทาง | `mock` | Meta Graph API |
| รูป | ดิสก์ของ container | S3-compatible |
| คีย์เข้ารหัส | สุ่มใหม่ทุกบูต | คงที่ มีเวอร์ชันสำหรับหมุนคีย์ |

ทำไมต้องล้างทุกครั้งที่บูต: ดิสก์ของแผนฟรีหายเมื่อเครื่องหลับแต่ฐานข้อมูลยังอยู่
ถ้าไม่ล้าง แถวรูปในฐานข้อมูลจะชี้ไปหาไฟล์ที่ไม่มีแล้ว และใครเปลี่ยนรหัสผ่านเดโม
คนถัดไปจะเข้าไม่ได้ — `scripts/demo-wipe.ts` ไม่ทำอะไรเลยถ้าไม่ได้ตั้ง `DEMO_RESET_ON_BOOT=1`

## ลองบนเครื่องตัวเองแบบเดียวกับเดโม

```bash
DATABASE_URL=postgres://app:app@localhost:55432/scheduler \
STORAGE_DIR=/tmp/demo-storage DEMO_RESET_ON_BOOT=1 CRON_SECRET=local NODE_ENV=production \
sh -c "npm run build && sh scripts/demo-boot.sh"
```
