-- 0002_query_indexes.sql
--
-- ดัชนีที่มาจากการวัดแผน query จริงด้วย EXPLAIN (ANALYZE, BUFFERS)
-- ที่ขนาด 100k โพสต์ / 300k targets / 40 tenant — ไม่ใช่การเดา
--
-- ทุกตัวมีเจ้าของ query ระบุไว้ ถ้าวันหนึ่ง query นั้นหายไป ให้ลบดัชนีตามไปด้วย
-- (ดัชนีที่ไม่มีคนใช้ = ค่าเขียนฟรีๆ ทุก INSERT/UPDATE)

-- ── scheduled_posts ─────────────────────────────────────────

-- listQueueForDay + dayCounts
-- ทั้งคู่กรองด้วย (scheduled_at AT TIME ZONE 'Asia/Bangkok')::date ซึ่งดัชนีธรรมดาใช้ไม่ได้
-- ผลวัด: อ่านประวัติทั้งหมดของลูกค้า (2535 buffers) เพื่อคืน 4 แถว → 67 buffers
-- ใช้ได้เพราะ timezone(text, timestamptz) เป็น IMMUTABLE ใน PG16
CREATE INDEX IF NOT EXISTS scheduled_posts_bkk_day_idx
  ON scheduled_posts (tenant_id, ((scheduled_at AT TIME ZONE 'Asia/Bangkok')::date));

-- listQueue — ORDER BY scheduled_at DESC LIMIT n
-- ผลวัด: 72.4 ms → 2.8 ms (คู่กับการย้าย LIMIT เข้าไปใน subquery)
CREATE INDEX IF NOT EXISTS scheduled_posts_tenant_time_idx
  ON scheduled_posts (tenant_id, scheduled_at DESC);

-- claimDueTargets — ฝั่ง scheduled_posts ไม่เคยมีดัชนีให้ใช้เลย
-- เพราะดัชนีเดิมขึ้นต้นด้วย tenant_id แต่ worker ไม่มีเงื่อนไข tenant
-- ผลวัด: 4.1 ms / 3393 buffers → 1.6 ms / 686 buffers
CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx
  ON scheduled_posts (scheduled_at)
  WHERE status IN ('pending', 'publishing', 'partial');

-- markMissed — รันทุก tick ของ worker
-- ผลวัด: 9.5 ms / 3483 buffers → 0.10 ms / 1 buffer
CREATE INDEX IF NOT EXISTS scheduled_posts_missed_idx
  ON scheduled_posts (scheduled_at) WHERE status = 'pending';

-- ── post_targets ────────────────────────────────────────────

-- โควตา Instagram 24 ชม. บนหน้าคิว
-- ผลวัด: 32.5 ms / 8880 buffers → 0.41 ms / 5 buffers
CREATE INDEX IF NOT EXISTS post_targets_ig_quota_idx
  ON post_targets (tenant_id, updated_at DESC)
  WHERE platform = 'instagram' AND status = 'posted';

-- หมายเหตุจากการวัด: เคยลอง (next_attempt_at, post_id) WHERE status='pending'
-- แล้ว planner ไม่ยอมใช้ ยังคงเลือก post_targets_claim_idx เหมือนเดิม — จึงไม่สร้าง
--
-- ราคาที่จ่าย: post_targets มี HOT update แค่ 9% อยู่แล้ว (เพราะ status ถูก index
-- และเปลี่ยนทุก state transition) ดัชนีข้างบนเป็น partial ที่ตัดแถวจบงานออก
-- จึงเล็กและเพิ่มค่าเขียนไม่มาก แต่ไม่ใช่ของฟรี
