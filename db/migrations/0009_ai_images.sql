-- ภาพที่สร้างด้วย AI
--
-- ทำไมต้องมีตารางแยก ไม่ใช่แค่ media_assets:
--   1. ต้องรู้ว่ารูปใบไหน "ไม่ใช่ของจริง" — โปสเตอร์ขายของที่ใช้ภาพ AI แทนสินค้าจริง
--      คือความเสี่ยงต่อร้าน ต้องตามหลังได้ว่ารูปนี้มาจาก prompt อะไร
--   2. โควตาภาพต้องนับแยกจากโควตาแคปชั่น เพราะแพงกว่ากันหลายสิบเท่า
--      (ข้อความ ~$0.001/ครั้ง · ภาพ ~$0.04/ใบ) ปล่อยรวมกัน = กดสร้างภาพ 100 ใบ
--      แล้วผู้ช่วยแคปชั่นตายทั้งเดือนโดยไม่มีใครเข้าใจว่าทำไม

ALTER TABLE tenant_limits
  ADD COLUMN IF NOT EXISTS ai_images_per_month int NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS ai_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id      uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  -- scene       = ฉาก/พื้นหลังไว้วางข้อความทับ
  -- illustration= ภาพประกอบโพสต์ทั่วไป
  -- replace-bg  = รูปสินค้าจริงของร้าน เปลี่ยนแค่ฉากหลัง (สินค้ายังเป็นของจริง)
  -- poster      = โปสเตอร์ทั้งใบจาก AI (ข้อความไทยยังวาดทับด้วยฟอนต์จริงเสมอ)
  mode          text NOT NULL CHECK (mode IN ('scene', 'illustration', 'replace-bg', 'poster')),
  prompt        text NOT NULL,
  -- รูปต้นทางของ replace-bg — ต้นฉบับไม่เคยถูกเขียนทับ ผลลัพธ์เป็นไฟล์ใหม่เสมอ
  ref_asset_id  uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  aspect_ratio  text NOT NULL,
  model         text NOT NULL,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_images_tenant_time ON ai_images (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_images_asset ON ai_images (asset_id);
