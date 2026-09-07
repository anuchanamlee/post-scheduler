-- ตั้งรหัสผ่านใหม่เมื่อลืม
--
-- เดิมลืมรหัส = ต้องรบกวนเจ้าของให้ตั้งใหม่ให้ ซึ่งแปลว่าเจ้าของต้องรู้รหัสของคนอื่น
-- สักพักหนึ่ง และรหัสนั้นก็ค้างอยู่ในแชทตลอดไป — ปัญหาเดียวกับที่ changePassword มีไว้แก้
--
-- เก็บ "ลายนิ้วมือ" ของ token ไม่ใช่ตัว token
-- ใครอ่าน DB ได้ (สำเนา backup, dump ตอน debug) จะได้เอาไปตั้งรหัสใหม่ไม่ได้
-- ท่าเดียวกับที่ sessions ทำอยู่แล้ว
--
-- ไม่มี ON DELETE SET NULL: ลบผู้ใช้แล้วคำขอที่ค้างต้องหายไปด้วย
-- ไม่งั้นลิงก์ที่ส่งไปแล้วยังตั้งรหัสให้บัญชีที่ควรตายไปแล้วได้

CREATE TABLE IF NOT EXISTS password_resets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_fp     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);

-- ค้นด้วยลายนิ้วมือคือทางเดียวที่ใช้ตอนกดลิงก์ (UNIQUE ข้างบนทำ index ให้แล้ว)
-- อันนี้สำหรับนับคำขอที่เพิ่งเกิดของผู้ใช้คนหนึ่ง = ท่าที่ตัวหน่วงใช้
CREATE INDEX IF NOT EXISTS password_resets_user_recent
  ON password_resets (user_id, created_at DESC);
