-- 0006_notify_channels.sql
--
-- ช่องทางแจ้งเตือนออกนอกแอป
--
-- ปัญหาที่แก้: แจ้งเตือนในแอปมีค่าก็ต่อเมื่อมีคนเปิดแอปดู
-- โพสต์ล้มตอนตี 2 เจ้าของร้านจะรู้ก็ตอนเปิดคอมตอนเช้า — สายเกินไปสำหรับโปรที่ลงเวลาเฉพาะ
--
-- ใช้ LINE Messaging API ไม่ใช่ LINE Notify — Notify ปิดบริการไปแล้ว 31 มี.ค. 2025
-- (https://notify-bot.line.me/closing-announce)

CREATE TABLE IF NOT EXISTS notify_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'line',   -- line | webhook
  label       text NOT NULL DEFAULT '',

  -- token เข้ารหัสแบบเดียวกับ token ของ Meta: AES-256-GCM คีย์อยู่ใน env ไม่ใช่ในตารางนี้
  secret_ciphertext text,
  secret_iv         text,
  secret_auth_tag   text,
  key_version       int NOT NULL DEFAULT 1,

  -- LINE: userId หรือ groupId ปลายทาง · webhook: URL
  destination text NOT NULL,

  -- ส่งเฉพาะระดับนี้ขึ้นไป กันเรื่องจุกจิกไปกวนตอนดึก
  min_level   text NOT NULL DEFAULT 'critical',
  is_active   boolean NOT NULL DEFAULT true,

  last_sent_at   timestamptz,
  last_error     text,
  failure_count  int NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notify_channels_tenant_idx
  ON notify_channels (tenant_id) WHERE is_active;

-- กันส่งซ้ำ: แจ้งเตือนใบเดียวส่งออกได้ครั้งเดียวต่อช่องทาง
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

CREATE INDEX IF NOT EXISTS notifications_unpushed_idx
  ON notifications (tenant_id, created_at) WHERE pushed_at IS NULL;
