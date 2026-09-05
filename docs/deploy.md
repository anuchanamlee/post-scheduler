# ขึ้นเซิร์ฟเวอร์จริง

ทดสอบแล้วว่าเส้นทางนี้เดินได้จริง: จากเครื่องเปล่า → เว็บใช้งานได้ **64 วินาที**
และโพสต์ตัวอย่างขึ้นครบ (4 target มี remote id + permalink)

---

## ต้องมีอะไรก่อน

| ของ | รายละเอียด | ทำไม |
|---|---|---|
| VPS | 2 vCPU · RAM 2 GB · ดิสก์ 20 GB · Ubuntu 22.04+ | `next build` กิน RAM ~1 GB ตอน build · 1 GB ไม่พอ |
| โดเมน | ชี้ A record มาที่ IP ของ VPS | Instagram ต้องโหลดรูปจาก URL สาธารณะ localhost ใช้ไม่ได้ |
| Docker | `curl -fsSL https://get.docker.com \| sh` | |

---

## ขั้นตอน

```bash
git clone <repo> post-scheduler && cd post-scheduler

# 1. สร้าง .env + ความลับ (ครั้งเดียว ไม่ทับของเดิม)
node scripts/setup.mjs

# 2. แก้ค่าที่ต้องเป็นของจริง
nano .env
```

ค่าที่ **ต้อง** แก้ก่อนใช้จริง:

```ini
PUBLIC_BASE_URL=https://โดเมนจริงของคุณ    # localhost = IG โหลดรูปไม่ได้
DEFAULT_PROVIDER=meta                       # mock = ไม่ได้โพสต์ขึ้นเพจจริง
META_APP_SECRET=...                         # ใช้ทำ appsecret_proof
STORAGE_DRIVER=s3                           # ดิสก์ container = เครื่องตายรูปหายหมด
S3_ENDPOINT=...  S3_BUCKET=...  S3_ACCESS_KEY=...  S3_SECRET_KEY=...
NOTIFY_TRANSPORT=line                       # mock = แจ้งเตือนเขียนลงไฟล์ ไม่ได้ส่งจริง
```

```bash
# 3. รันโหมดโปรดักชัน (ไม่ใช่ docker compose up เฉยๆ — นั่นคือโหมดพัฒนา ช้ากว่า 20 เท่า)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 4. ตรวจว่าขึ้นครบ
curl -s localhost:3000/api/health
```

`"ok": true` และ `"config": "ok"` = ผ่าน
ถ้า `config` มีรายการขึ้นมา แต่ละข้อบอกวิธีแก้มาในตัวแล้ว

```bash
# 5. ตรวจว่าทุกหน้าเปิดได้จริง ไม่ใช่แค่ health เขียว
docker compose exec web npm run check-pages
```

---

## reverse proxy (Caddy — ได้ HTTPS อัตโนมัติ)

```
โดเมนของคุณ {
    reverse_proxy localhost:3000
}
```

ต้องมี HTTPS จริง ไม่ใช่แค่ให้ดูดี — Meta ไม่โหลดรูปจาก http

---

## หลังขึ้นแล้วต้องทำ

**1. ต่อ uptime monitor เข้ากับ `/api/health`**
worker ตายแล้วมันบอกเองไม่ได้ ต้องมีคนนอกคอยดู
`/api/health` จะตอบ `ok:false` ทั้งตอน worker ตาย ตอนมีโพสต์ค้างเกิน 15 นาที และตอนคอนฟิกผิด
(หรือตั้ง `WORKER_HEARTBEAT_URL` ให้ worker ยิงหา healthchecks.io ทุกรอบ)

**2. สำรอง `.env` ไว้ที่อื่น**
`ENCRYPTION_KEY_HEX` หาย = token ของทุกเพจถอดไม่ออกอีกเลย ต้องไปออกใหม่จาก Business Manager หมด

**3. สำรองฐานข้อมูล**
```bash
docker compose exec -T db pg_dump -U app scheduler | gzip > backup-$(date +%F).sql.gz
```
ใส่ cron รายวัน แล้ว**ลองกู้กลับสักครั้ง** — backup ที่ไม่เคยกู้คือ backup ที่ยังไม่รู้ว่าใช้ได้ไหม

---

## อัปเดตโค้ดทีหลัง

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

migration รันเองอัตโนมัติก่อนเว็บขึ้น (service `migrate`) และรันซ้ำได้ไม่พัง

---

## กับดักที่เคยทำพังมาแล้ว

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| ทุกหน้า 500 · `Cannot find module './994.js'` | รัน `npm run build` ทับ `.next` ที่ `next dev` ใช้อยู่ | `rm -rf .next` แล้ว restart · โหมดโปรดักชันไม่เจอเพราะ build อยู่ใน image |
| โพสต์ล้มหมดว่า "รูปยังไม่พร้อมใช้งาน" | โพสต์ไม่มีแถวใน `post_media` | `npm run check-pages` จับให้แล้ว |
| IG ล้มเรื่องโหลดรูปไม่ได้ | `PUBLIC_BASE_URL` เป็น localhost หรือไม่มี HTTPS | ตั้งโดเมนจริง · `/api/health` เตือนให้ถ้าใช้ provider meta |
| แก้ prod overlay แล้วไม่มีผล | compose **ต่อ** รายการ volumes/ports ไม่ได้ทับ | ต้องใส่ `!override` |
