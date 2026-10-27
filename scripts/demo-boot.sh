#!/bin/sh
# บูตเดโมสาธารณะบนโฮสต์ฟรีที่มี container เดียว (เช่น Render free)
#
# ต่างจาก docker-compose.prod.yml ตรงที่ worker กับเว็บอยู่ใน container เดียวกัน
# เพราะโฮสต์ฟรีไม่มี background worker ให้ — เครื่องหลับ คิวก็หยุด ตื่นมาก็เดินต่อ
# ซึ่งรับได้สำหรับเดโมที่ provider เป็น mock ส่วนของจริงให้ใช้ compose ตาม docs/deploy.md
#
# ทุกครั้งที่บูตจะล้างข้อมูลแล้ว seed ใหม่ (scripts/demo-wipe.ts อธิบายเหตุผล)
set -e

# Render ใส่ URL สาธารณะของ service ไว้ใน RENDER_EXTERNAL_URL
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL:-http://localhost:3000}}"

# ข้อมูลถูกล้างทุกครั้งที่บูตอยู่แล้ว คีย์เข้ารหัสจึงสุ่มใหม่ได้ทุกครั้ง
# export ก่อนแยก process เพื่อให้เว็บกับ worker ใช้คีย์เดียวกัน
if [ -z "$ENCRYPTION_KEY_HEX" ]; then
  ENCRYPTION_KEY_HEX="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  export ENCRYPTION_KEY_HEX
fi

mkdir -p "${STORAGE_DIR:-/data/storage}"

npm run migrate
npm run demo-wipe
npm run seed

npm run worker &
exec npm run start
