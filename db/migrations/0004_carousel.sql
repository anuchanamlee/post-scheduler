-- 0004_carousel.sql
--
-- หลายรูปต่อโพสต์ (carousel)
--
-- ร้านค้าจริงมีหลายรูปเกือบทุกโพสต์ — สินค้าหลายมุม เมนูหลายหน้า ก่อน/หลัง
-- ของเดิมผูกรูปใบเดียวไว้ที่ scheduled_posts.asset_id ตรงๆ
--
-- ตารางใหม่นี้ไม่ลบ asset_id ทิ้ง: เก็บไว้เป็น "รูปแรก" เพื่อให้ query เดิม
-- (รูปย่อในคิว, พรีวิว) ทำงานต่อได้โดยไม่ต้องแก้ทุกที่พร้อมกัน
-- ตัวที่ตัดสินว่าโพสต์มีรูปอะไรบ้างคือ post_media เสมอ

CREATE TABLE IF NOT EXISTS post_media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  asset_id   uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  position   smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, position)
);

CREATE INDEX IF NOT EXISTS post_media_post_idx ON post_media (post_id, position);

-- ย้ายรูปเดี่ยวของโพสต์เดิมเข้าตารางใหม่ ให้ทุกโพสต์มีที่มาของรูปที่เดียวกัน
INSERT INTO post_media (tenant_id, post_id, asset_id, position)
SELECT p.tenant_id, p.id, p.asset_id, 0
  FROM scheduled_posts p
 WHERE p.asset_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM post_media m WHERE m.post_id = p.id)
ON CONFLICT DO NOTHING;

-- Instagram ทำ carousel เป็น 2 ชั้น: container ลูกใบละรูป แล้วรวมเป็น container แม่
-- ต้องเก็บ id ของลูกไว้ เพราะถ้า process ตายกลางคันจะได้ไม่สร้างซ้ำ (เหมือน container_id เดิม)
ALTER TABLE post_targets
  ADD COLUMN IF NOT EXISTS child_container_ids text[] NOT NULL DEFAULT '{}';

-- Instagram รับ carousel ได้ 10 รูป Facebook รับได้มากกว่านั้นแต่จำกัดที่เท่ากันเพื่อความง่าย
COMMENT ON TABLE post_media IS 'รูปของโพสต์ เรียงตาม position — สูงสุด 10 ใบตามข้อจำกัดของ Instagram';
