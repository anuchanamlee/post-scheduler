-- 0008_hashtags.sql
--
-- ชุดแฮชแท็กประจำของแต่ละเพจ
--
-- แพ็กเกจ 2 เขียนไว้ว่า "AI ช่วยร่างแคปชั่นและแฮชแท็กภาษาไทย" — ส่วนแฮชแท็กยังไม่มี
--
-- ทำไมต้องเก็บเป็นชุด ไม่ใช่ให้ AI คิดใหม่ทุกครั้ง:
-- ร้านค้าใช้แฮชแท็กเดิมซ้ำๆ เพราะมันคือแท็กประจำร้าน (#ชื่อร้าน #ย่านที่ตั้ง)
-- ถ้า AI คิดใหม่ทุกครั้งจะได้แท็กที่ไม่มีใครติดตาม และสะกดชื่อร้านไม่เหมือนเดิม

CREATE TABLE IF NOT EXISTS hashtag_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_id    uuid REFERENCES social_pages(id) ON DELETE CASCADE,
  name       text NOT NULL,
  tags       text[] NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS hashtag_sets_tenant_idx ON hashtag_sets (tenant_id, page_id);

-- ชุดตั้งต้นให้ลูกค้าที่มีอยู่แล้ว จะได้เห็นว่าใช้ยังไง
INSERT INTO hashtag_sets (tenant_id, name, tags, is_default)
SELECT t.id, 'แท็กประจำร้าน',
       ARRAY['#ร้านตัวอย่าง', '#ของอร่อย', '#รีวิวร้าน'],
       true
  FROM tenants t
ON CONFLICT DO NOTHING;
