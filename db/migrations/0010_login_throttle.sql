-- หน่วงการเดารหัสผ่าน
--
-- ระบบนี้ถือ token ที่โพสต์ลงเพจลูกค้าได้ — ใครเดารหัส owner ได้ = โพสต์อะไรลงเพจก็ได้
-- เดิมกรอกผิดกี่รอบก็ได้ ไม่มีอะไรหน่วงเลย
--
-- เก็บใน DB ไม่ใช่ในหน่วยความจำของ process เพราะ:
--   - เว็บกับ worker เป็นคนละ container และเว็บอาจถูกสเกลเป็นหลายตัว
--   - รีสตาร์ตแล้วตัวนับต้องไม่รีเซ็ต ไม่งั้นแค่รอ deploy ก็ปลดล็อกได้
--
-- นับที่ "อีเมล" ไม่ใช่ IP: IP ปลอมง่ายและลูกค้าหลายคนใช้ IP เดียวกันได้ (เน็ตร้าน)
-- ผลข้างเคียงที่ยอมรับ: คนอื่นยิงอีเมลเราให้ล็อกได้ — จึงล็อกแค่ 15 นาที ไม่ใช่ถาวร

CREATE TABLE IF NOT EXISTS login_attempts (
  email        text PRIMARY KEY,
  fails        int NOT NULL DEFAULT 0,
  last_fail_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);

CREATE INDEX IF NOT EXISTS login_attempts_locked ON login_attempts (locked_until);
