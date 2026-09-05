# Runbook: รับลูกค้าใหม่ 1 ราย

เวลาที่ใช้จริง ~30–40 นาที รวมเวลาที่ต้องรอลูกค้ากดยืนยันเอง

---

## ⚠️ อ่านก่อน — สิ่งที่ยังไม่ได้พิสูจน์

แผนเดิมตั้งอยู่บนสมมติฐานว่า **System User ของ Business Manager ลูกค้า นับเป็น "role user"
ของแอปใน Development Mode** ซึ่ง**ไม่มีในเอกสาร Meta**

เอกสาร Meta พูดถึงสองอย่างนี้แยกกันโดยไม่เคยเชื่อมกัน
- App Role (Admin / Developer / Tester) = construct ของ App Dashboard ผูกกับ**บัญชี Facebook ของคน**
- System User = construct ของ Business Manager

Runbook นี้จึงใช้**ท่าที่เอกสารรองรับ**: มีคนจริงถือ role บนแอป (ลูกค้าเอง) แล้วค่อยใช้
System User token ยิง API — ได้ข้อดีเดิมครบ ต่างแค่มีคนถือ role ค้าง 1 คน

## ตอบคำถามนี้ก่อนขายลูกค้ารายแรก — มีสคริปต์ให้แล้ว

```bash
docker compose exec web npm run verify-meta -- \
  --token "EAAG..." --page <page-id> --secret <app-secret> --appid <app-id>
```

สคริปต์อ่านอย่างเดียว ไม่โพสต์อะไร และไม่พิมพ์ token ลง log
บอกให้ครบว่า token ชนิดไหน · มีวันหมดอายุไหม · **มี scope อะไรบ้างจริงๆ**
(ตอบข้อ A5 เรื่องชื่อ scope ของ Instagram ไปในตัว) ·
มองเห็นเพจไหม · เพจผูก IG แล้วหรือยัง · โควตา IG เหลือเท่าไหร่

อยากพิสูจน์ให้จบว่าโพสต์ได้จริง เพิ่ม `--post --image <url สาธารณะ>`
— มันจะโพสต์ขึ้นเพจจริงแล้วลบทิ้งทันที

**อ่านผลยังไง**
- มองเห็นเพจ + อ่านข้อมูลเพจได้ → ท่า System User อย่างเดียวใช้ได้ **ตัดขั้นที่ 3 ทิ้งได้**
- มองไม่เห็นเพจ (มักได้ error 190 หรือ 200) → ต้องมีคนถือ role ตาม Runbook นี้

---

## Phase 1 — เตรียมแอป (ทำเองล่วงหน้า ไม่ต้องรอลูกค้า)

1. Meta for Developers → สร้างแอปใหม่ ประเภท **Business**
2. เพิ่ม Product: **Instagram (API with Facebook Login)** และ **Facebook Login for Business**
3. ตั้ง OAuth Redirect URI ให้ตรงกับ `PUBLIC_BASE_URL` ของ instance ลูกค้ารายนั้น
4. เก็บ **App ID** และ **App Secret** ไว้ (App Secret ไปลง `META_APP_SECRET`)
5. **แอปอยู่ Development Mode ตลอด — ห้ามกด "Go Live"** นี่คือสิ่งที่ทำให้ไม่ต้อง App Review
   และไม่ต้อง Business Verification ตามที่เอกสาร Business Verification ระบุไว้ตรงๆ ว่า
   *"If your app will only be used by app users who have a role on the app itself
   you do not need to complete verification"*

## Phase 2 — Onboard ลูกค้า

### 1. ลูกค้าต้องมีของครบ 3 อย่าง
- Facebook Page ที่ลูกค้าเป็น Admin
- บัญชี Instagram แบบ **Professional** (Business หรือ Creator) ที่เชื่อมกับเพจนั้นแล้ว
- **Meta Business Manager** ของตัวเอง (สร้างฟรีที่ business.facebook.com ไม่ต้อง verify ในระดับนี้)
  แล้วเชื่อม Page + IG เข้าไปใน Business Manager

### 2. โอนแอปให้ Business Manager ของลูกค้า
- ฝั่งเรา: Business Settings → Accounts → Apps → เลือกแอป → **Remove**
- ฝั่งลูกค้า: Business Settings → Accounts → Apps → **Add** → ใส่ App ID → claim

หลังขั้นนี้แอปเป็นของลูกค้าเต็มตัว ไม่กินเพดาน 15 แอปของเรา

### 3. ให้ลูกค้ามี role บนแอป ← ขั้นที่เพิ่มเข้ามาจากแผนเดิม
ใน App Dashboard → **App Roles** → เพิ่มบัญชี Facebook ของลูกค้าเป็น **Administrator**
(หรืออย่างน้อย Tester) แล้วให้ลูกค้ากดยอมรับคำเชิญ

**นี่คือขั้นที่ทำให้ permission ทำงานใน Development Mode ตามที่เอกสารเขียนไว้จริง**
ถ้าข้ามขั้นนี้ ระบบอาจโพสต์ไม่ได้ด้วยเหตุผลที่ debug ยากมาก

### 4. สร้าง System User ใน Business Manager ของลูกค้า
Business Settings ของลูกค้า → Users → **System Users** → Add
- ชื่อ: `ระบบตั้งเวลาโพสต์`
- role: **Employee** (ไม่ต้อง Admin เต็ม)

### 5. ให้สิทธิ์เฉพาะที่ต้องใช้
เปิด System User → **Assign Assets** → เลือก Page + Instagram account
→ ให้เฉพาะสิทธิ์ที่ต้องใช้โพสต์ ไม่ต้องให้เกินจำเป็น

### 6. สร้าง token
กด **Generate token** → เลือกแอปที่โอนมา → expiration **Never** → เลือก permission:
`pages_manage_posts` · `pages_read_engagement` · `instagram_basic` ·
`instagram_content_publish` · `business_management`

> **ยืนยันแล้ว 6 ก.ย. 2026** จากหน้า Content Publishing ของ Meta —
> Instagram มีสองเส้นทางและ**ใช้ชื่อ permission คนละชุด** ซึ่งเป็นที่มาของความสับสนเดิม:
>
> | เส้นทาง | permission |
> |---|---|
> | **Instagram API with Facebook Login** ← runbook นี้ใช้เส้นนี้ | `instagram_basic` · `instagram_content_publish` · `pages_read_engagement` |
> | Instagram API with Instagram Login | `instagram_business_basic` · `instagram_business_content_publish` |
>
> `instagram_business_content_publish` **ไม่ใช่ชื่อใหม่ของ** `instagram_content_publish`
> — คนละเส้นทางกัน ถ้าเลือก product ผิดเส้น จะหา permission ที่ต้องใช้ไม่เจอทั้งชุด
> ตอนเพิ่ม product ต้องเลือก **Instagram API with Facebook Login** เพราะเรายิงผ่าน
> System User token ของ Business Manager ที่ถือทั้งเพจและ IG ที่ผูกกับเพจ
> https://developers.facebook.com/documentation/instagram-platform/content-publishing

**คัดลอก token ทันที — Facebook แสดงให้เห็นครั้งเดียว**

### 7. เก็บ token เข้าระบบ
```bash
docker compose exec web npx tsx -e "
  import { seal } from './src/lib/crypto.js';
  console.log(JSON.stringify(seal(process.argv[1])));
" 'TOKEN_ที่คัดลอกมา'
```
แล้วบันทึกลง `meta_credentials` พร้อมผูกกับเพจใน `page_credentials`
(token ถูกเข้ารหัส AES-256-GCM คีย์อยู่ใน env ไม่เคยอยู่ในฐานข้อมูล)

### 8. ทดสอบก่อนส่งมอบ
```bash
docker compose exec web npm run verify-meta -- --token "<token>" --page <page-id>
curl -s http://<instance>/api/health          # ต้องได้ ok:true
docker compose exec web npm run smoke          # ต้องผ่านทั้งหมด
```
แล้วตั้งโพสต์จริง 1 ชิ้นเวลาอีก 5 นาที ดูว่าขึ้นบนเพจจริง

**อย่าลืมก่อนส่งมอบ**
- `STORAGE_DRIVER=s3` — ค่าเริ่มต้นเก็บรูปในเครื่อง VPS ตายทีเดียวรูปลูกค้าหายหมด
- `PUBLIC_BASE_URL` ต้องเป็น URL ที่ Meta เข้าถึงได้จริง ไม่ใช่ localhost
- ตั้งช่องทาง LINE ที่ `/settings` แล้วกดส่งทดสอบ
- `WORKER_HEARTBEAT_URL` — worker ที่ตายแล้วบอกว่าตัวเองตายไม่ได้
- รัน `npm run reset-demo` ล้างข้อมูลตัวอย่างออกก่อนส่ง

---

## เมื่อ token ใช้ไม่ได้ขึ้นมา

System User token ตั้ง "Never expire" ได้จริงตามเอกสาร แต่ **เงื่อนไขที่ทำให้มันพัง
Meta ไม่ได้เขียนไว้ที่ไหน** (เปลี่ยนรหัสผ่าน · ปิด 2FA · BM ถูกระงับ · เพิกถอนสิทธิ์)
จึงต้องถือว่ามันพังได้เสมอ และรู้ให้เร็ว

ระบบจะจับ error code 190 (และรหัสตระกูลเดียวกัน) แล้ว
1. set `meta_credentials.status = 'invalid'`
2. หยุดส่งโพสต์ของเพจนั้น (ไม่ retry จนพัง)
3. ขึ้นแจ้งเตือนระดับ critical ในหน้าคิว และ `/api/health` ตอบ 503

**วิธีแก้**: ทำ Phase 2 ขั้นที่ 4–7 ใหม่ (สร้าง token ใหม่) แล้วอัปเดต `meta_credentials`
คิวที่ค้างอยู่จะถูกส่งต่อเองเมื่อกด "ส่งเฉพาะช่องทางที่ล้ม"

---

## สิ่งที่ต้องบอกลูกค้าตรงๆ ก่อนเซ็นงาน

- **โปสเตอร์สร้างจากเทมเพลต + รูปสินค้าจริง ไม่ใช่ AI วาดภาพ** — ลูกค้าถ่ายสินค้าเอง
  ระบบจัดวางกับข้อความให้ (6 แบบ × 3 สัดส่วน) ตัวหนังสือไทยใช้ฟอนต์จริง คมชัด 100%
  **ถ้าเคยส่งเอกสารข้อเสนอที่เขียนว่า "AI สร้างภาพโปสเตอร์" ต้องเคลียร์ตรงนี้ก่อน**
- Instagram รับเฉพาะสัดส่วน 0.80–1.91 รูปนอกช่วงนี้จะถูกครอปอัตโนมัติ
- โพสต์ที่ระบบล่มจนเลยเวลาเกิน 2 ชั่วโมง จะ**ไม่ถูกโพสต์ย้อนหลังเอง** — ขึ้นให้คนตัดสินใจ
- ถ้าลูกค้าเพิกถอนสิทธิ์ System User เมื่อไหร่ ระบบหยุดโพสต์ทันที (ตั้งใจให้เป็นแบบนั้น)
