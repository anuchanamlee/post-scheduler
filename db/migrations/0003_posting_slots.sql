-- 0003_posting_slots.sql
--
-- ตารางเวลาประจำ — แนวคิดเดียวกับ "posting schedule" ของ Buffer
--
-- ปัญหาที่แก้: ทุกวันนี้เจ้าของร้านต้องตัดสินใจเรื่องเวลาใหม่ทุกครั้งที่เขียนโพสต์
-- ทั้งที่คำตอบมักเหมือนเดิมทุกสัปดาห์ (เช้าก่อนเปิดร้าน กับเย็นหลังเลิกงาน)
-- ตั้งไว้ครั้งเดียวแล้วโพสต์ใหม่ไหลลงช่องว่างถัดไปเอง

CREATE TABLE IF NOT EXISTS posting_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ผูกกับเพจได้ถ้าวันหนึ่งอยากให้ FB กับ IG ลงคนละเวลา ตอนนี้ NULL = ใช้กับทุกเพจ
  page_id     uuid REFERENCES social_pages(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = อาทิตย์
  time_of_day time NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, page_id, weekday, time_of_day)
);

CREATE INDEX IF NOT EXISTS posting_slots_tenant_idx
  ON posting_slots (tenant_id, weekday, time_of_day) WHERE is_active;

-- ค่าตั้งต้นสำหรับลูกค้าที่มีอยู่แล้ว: จันทร์–ศุกร์ 09:00 กับ 18:00
-- เลือกสองช่วงนี้เพราะเป็นเวลาที่คนไทยเปิดฟีดมากที่สุด (ก่อนเริ่มงาน / หลังเลิกงาน)
-- เจ้าของร้านแก้เองได้ทั้งหมดในหน้าตั้งค่า
INSERT INTO posting_slots (tenant_id, weekday, time_of_day)
SELECT t.id, d.wd, s.t
  FROM tenants t
  CROSS JOIN (VALUES (1),(2),(3),(4),(5)) AS d(wd)
  CROSS JOIN (VALUES ('09:00'::time), ('18:00'::time)) AS s(t)
ON CONFLICT DO NOTHING;
