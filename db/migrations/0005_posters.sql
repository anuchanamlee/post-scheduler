-- 0005_posters.sql
--
-- โปสเตอร์สินค้าที่สร้างจากเทมเพลต
--
-- เก็บ "ข้อมูลที่กรอก" ไว้ด้วย ไม่ใช่แค่ไฟล์ภาพ เพราะร้านค้าต้องแก้ราคาแล้วสร้างใหม่บ่อย
-- (โปรเดือนหน้าใช้โครงเดิม เปลี่ยนแค่ตัวเลข) ถ้าเก็บแต่ภาพก็ต้องกรอกใหม่ทุกครั้ง

CREATE TABLE IF NOT EXISTS poster_designs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ภาพผลลัพธ์เก็บเป็น media_asset ปกติ จึงเอาไปเข้าคิวโพสต์ได้ทันทีโดยไม่ต้องแปลงอะไร
  asset_id     uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  -- รูปสินค้าต้นทางที่ใช้ประกอบ (ถ้ามี) — ไว้ให้ย้อนกลับไปเปลี่ยนเทมเพลตด้วยรูปเดิม
  photo_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  template_id  text NOT NULL,
  aspect_ratio text NOT NULL,
  fields       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS poster_designs_tenant_idx
  ON poster_designs (tenant_id, created_at DESC);
