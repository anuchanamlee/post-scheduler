# bookworm ไม่ใช่ alpine — sharp มี prebuilt binary ที่นี่ ติดตั้งไม่ต้อง build เอง
FROM node:22-bookworm-slim AS base

WORKDIR /app

# fonts-thai-tlwg + fontconfig จำเป็นสำหรับการวางข้อความภาษาไทยทับรูปด้วย sharp
# ไม่มีสองตัวนี้ overlay จะได้กล่องเปล่าแทนตัวอักษร
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl fonts-thai-tlwg fontconfig \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

RUN mkdir -p /data/storage

EXPOSE 3000

# ── โหมดพัฒนา: source ถูก mount ทับจาก compose แก้โค้ดแล้วเห็นผลทันที
CMD ["npm", "run", "dev"]

# ── โหมดโปรดักชัน: build ตั้งแต่ตอนสร้าง image ไม่ใช่ตอนบูต
#
# ทำไมต้อง build ที่นี่: ถ้า build ตอน container ขึ้น เว็บจะใช้ไม่ได้ 1-2 นาทีแรก
# ทุกครั้งที่รีสตาร์ท และ .next จะไปเขียนทับโฟลเดอร์บนเครื่องโฮสต์
# (เคยทำให้เว็บโหมดพัฒนา 500 ทุกหน้ามาแล้ว)
#
# build ไม่ต้องต่อฐานข้อมูล — ทุกหน้าเป็น force-dynamic อยู่แล้ว
FROM base AS prod
RUN npm run build
CMD ["npm", "run", "start"]
