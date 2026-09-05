# สถาปัตยกรรม

## หลักการเดียวที่ทุกอย่างวางอยู่บนนั้น

**ชั้นที่คิดคอนเทนต์ ไม่รู้จักชั้นที่โพสต์ และชั้นที่โพสต์ไม่รู้ว่าคอนเทนต์มาจากไหน**

ทั้งสองชั้นเจอกันที่ตารางเดียว คือ `scheduled_posts` + `post_targets` เท่านั้น
วันหน้ามี AI agent วิเคราะห์เพจแล้วเสนอคอนเทนต์เอง มันก็แค่ `INSERT` แถวที่มี
`source='ai_agent'` และ `status='pending_approval'` — โค้ดฝั่งโพสต์ไม่ต้องแก้แม้แต่บรรทัดเดียว

```
      คนพิมพ์เอง ─┐
   ผู้ช่วยแคปชั่น ─┼─→ src/core/scheduler.ts ─→ [ scheduled_posts ]
  (อนาคต) agent ─┘                              [ post_targets   ]
                                                       │
                                          src/core/publisher.ts
                                                       │
                                          src/providers/* (สลับได้)
                                                       │
                                            Facebook / Instagram
```

## โครงไฟล์

```
db/migrations/          SQL ตรงๆ อ่านออกโดยไม่ต้องรัน ORM
src/
  lib/                  ของกลาง: env, db, crypto, auth — ไม่มี business logic
  providers/            ทุกอย่างที่รู้จักโลกภายนอก
    types.ts              สัญญาที่ provider ทุกเจ้าต้องทำตาม
    errors.ts             แมป error → retry / หยุด / flag credential
    meta/                 Facebook + Instagram ตัวจริง
    mock.ts               ปลายทางจำลอง ใช้ทดสอบทั้งเส้นโดยไม่ต้องมี Meta App
    index.ts              ทะเบียน + ถอดรหัส token
  core/                 ชั้นคนโพสต์ — ไม่ import อะไรจาก content/ เลย
    queue.ts              หยิบงาน · กัน lock · คำนวณสถานะรวม · heartbeat
    publisher.ts          พยายามส่งให้สำเร็จ + จัดการความล้มเหลว
    scheduler.ts          สร้าง/แก้/ยกเลิก/ส่งซ้ำเฉพาะขาที่ล้ม
  content/              ชั้นคิดคอนเทนต์ — ไม่ import อะไรจาก core/ เลย
    caption.ts            brand voice + ร่างแคปชั่น + เสนอแฮชแท็ก
    image.ts              สร้างภาพด้วย AI — ฉาก · ภาพประกอบ · เปลี่ยนพื้นหลังรูปสินค้าจริง
    poster.ts             ประกอบโปสเตอร์ + วาดข้อความไทยด้วยฟอนต์จริง
    ai-usage.ts           โควตา/ค่าใช้จ่าย AI ที่แคปชั่นกับภาพใช้ร่วมกัน
    library.ts            คลังรูป
    media.ts              ครอปตามสัดส่วน + overlay + ตรวจเกณฑ์ของ IG
  worker/main.ts        process แยกจากเว็บ
  app/                  UI + server actions
```

กฎที่ทำให้การแยกชั้นเป็นเรื่องจริง ไม่ใช่แค่ชื่อโฟลเดอร์:

- `core/` ห้าม import จาก `content/`
- `content/` ห้าม import จาก `core/`
- ที่เดียวที่รู้จัก `graph.facebook.com` คือ `providers/meta/client.ts`

ถ้าวันหนึ่งต้องแก้ `core/` เพื่อเพิ่มปลายทางใหม่ แปลว่าการแยกชั้นพังแล้ว
`mock.ts` มีไว้ทดสอบข้อนี้ด้วย — มันทำงานได้โดย `core/` ไม่รู้จักมันเลย

## เพิ่มปลายทางใหม่ (TikTok, LINE OA, หรือย้ายไป aggregator)

1. เขียนคลาสที่ `implements PublishProvider` (5 เมธอด)
2. ลงทะเบียนใน `src/providers/index.ts`
3. เพิ่มค่าใน enum `platform` ของ migration ใหม่

จบ — ไม่ต้องแตะ `core/` ไม่ต้องแตะ UI

ถ้าวันหนึ่งกลับไปทำ Business Verification เต็มรูปแบบ ก็เขียน `providers/meta-advanced/`
แล้วสลับที่ระดับเพจ (`social_pages.provider`) ทีละราย ไม่ต้อง big bang

## จาก 1 ลูกค้า ไป หลายสิบลูกค้า

ตอนนี้ deploy แยก 1 instance ต่อ 1 ลูกค้า แต่ **schema เป็น multi-tenant ตั้งแต่วันแรก**
ทุกตารางมี `tenant_id` และทุก query กรองด้วยมันเสมอ

วันที่รวมเป็น pool เดียวต้องทำแค่ 3 อย่าง และไม่ต้อง migrate ข้อมูล

1. เปิด Row Level Security ต่อ tenant
2. ให้ session ตั้ง `SET LOCAL app.tenant_id`
3. ย้าย worker เป็น pool เดียวที่วนทุก tenant (`claimDueTargets` รองรับอยู่แล้ว เพราะไม่ผูก tenant)

ราคาที่จ่ายไปตอนนี้เพื่อได้ข้อนี้: 1 column ต่อตาราง กับ helper `tenantQuery` ตัวเดียว

## จุดต่อขยายที่เตรียมไว้ (ยังไม่ได้สร้าง)

| จะทำอะไรในอนาคต | ต่อยังไง |
|---|---|
| AI เสนอหัวข้อคอนเทนต์เอง | `INSERT scheduled_posts (source='ai_agent', status='pending_approval')` แล้วมีคนกดอนุมัติ — `approved_by`/`approved_at` มีแล้ว |
| ดึงสถิติ engagement มาปรับกลยุทธ์ | `post_metrics` เป็น time series ต่อ target อยู่แล้ว เขียน collector ตัวใหม่ |
| ตอบคอมเมนต์อัตโนมัติ | โมดูลแยก ใช้ credential ชุดเดิม (ต้องขอ permission เพิ่มตอนใช้จริง) |
| แจ้งเตือนความผิดปกติของเพจ | `api_call_log` + `job_runs` + `post_metrics` เป็นฐานข้อมูลตั้งต้นอยู่แล้ว |
