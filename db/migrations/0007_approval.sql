-- 0007_approval.sql
--
-- ขั้นตอนอนุมัติก่อนเผยแพร่ + สิทธิ์ผู้ใช้หลายระดับ
--
-- enum 'pending_approval' กับคอลัมน์ approved_by/approved_at มีมาตั้งแต่ migration แรก
-- แต่ไม่เคยมีใครใช้ — รอบนี้ทำให้มันทำงานจริง
--
-- ทำไมร้านค้าต้องใช้: เจ้าของจ้างเด็กมาช่วยทำคอนเทนต์ แต่ยังอยากตรวจก่อนขึ้นเพจ
-- เพราะโพสต์ผิดบนเพจธุรกิจลบทีหลังก็มีคนเห็นไปแล้ว

-- เปิด/ปิดได้ต่อลูกค้า — ร้านที่เจ้าของทำเองคนเดียวไม่ต้องมีขั้นตอนนี้ให้เสียเวลา
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

-- เหตุผลตอนตีกลับ — ถ้าไม่บอกว่าทำไม คนเขียนก็แก้ไม่ถูก
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS rejected_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

-- บังคับให้ role เป็นค่าที่ระบบรู้จักเท่านั้น เดิมเป็น text อะไรก็ใส่ได้
-- owner    = ทำได้ทุกอย่าง รวมจัดการผู้ใช้และการเชื่อมต่อ
-- approver = เขียนได้ + อนุมัติของคนอื่นได้
-- editor   = เขียนได้อย่างเดียว งานต้องผ่านการอนุมัติก่อนถ้าเปิดใช้ขั้นตอนนี้
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('owner', 'approver', 'editor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS scheduled_posts_awaiting_idx
  ON scheduled_posts (tenant_id, created_at DESC) WHERE status = 'pending_approval';
