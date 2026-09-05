-- 0001_init.sql — โครงฐานข้อมูลตั้งต้น
--
-- ทุกตารางมี tenant_id ตั้งแต่วันแรก (รายงานข้อ B1)
-- แม้ตอนนี้จะ deploy แยก 1 instance ต่อ 1 ลูกค้า และมี tenant เดียวต่อ DB
-- วันที่รวมเป็น pool เดียว = เปิด RLS ไม่ต้อง migrate ข้อมูล

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- enum
-- ─────────────────────────────────────────────────────────────

-- สถานะของ "เจตนาจะโพสต์" ระดับโพสต์ — คำนวณจาก post_targets ทั้งหมด
DO $$ BEGIN
  CREATE TYPE post_status AS ENUM (
    'draft',             -- ยังไม่สมบูรณ์ (คน หรือ AI ในอนาคตสร้างไว้)
    'pending_approval',  -- รอคนอนุมัติก่อนเข้าคิว
    'pending',           -- อยู่ในคิว รอถึงเวลา
    'publishing',        -- worker กำลังทำงานอยู่
    'posted',            -- ทุกปลายทางสำเร็จ
    'partial',           -- บางปลายทางสำเร็จ บางปลายทางล้ม (รายงานข้อ C1/D3)
    'failed',            -- ทุกปลายทางล้ม
    'cancelled',
    'missed'             -- เลยเวลา grace window ตอนระบบกลับมา (รายงานข้อ D10)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- สถานะรายปลายทาง — นี่คือที่เก็บความจริงจริงๆ
DO $$ BEGIN
  CREATE TYPE target_status AS ENUM (
    'pending', 'publishing', 'posted', 'failed', 'cancelled', 'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE platform AS ENUM ('facebook', 'instagram');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE credential_status AS ENUM ('healthy', 'invalid', 'revoked', 'unchecked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_status AS ENUM ('uploading', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────
-- ลูกค้า / ผู้ใช้
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Bangkok',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- auth ต้องมีตั้งแต่ commit แรก (รายงานข้อ E1)
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'owner',   -- owner | editor | approver
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- ─────────────────────────────────────────────────────────────
-- ปลายทางที่โพสต์ได้ + credential
-- ─────────────────────────────────────────────────────────────

-- 1 แถว = 1 เพจ/บัญชีที่โพสต์ได้ (FB Page 1 แถว, IG account อีก 1 แถว)
-- timezone อยู่ที่นี่ ไม่ใช่เดาจาก server (รายงานข้อ C8)
CREATE TABLE IF NOT EXISTS social_pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform       platform NOT NULL,
  provider       text NOT NULL DEFAULT 'meta',   -- meta | mock | (tiktok, line ในอนาคต)
  remote_id      text NOT NULL,                  -- fb page id หรือ ig user id
  display_name   text NOT NULL,
  timezone       text NOT NULL DEFAULT 'Asia/Bangkok',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform, remote_id)
);

-- token เข้ารหัส AES-256-GCM: เก็บ iv + auth_tag + key_version แยก (รายงานข้อ E2/C10)
-- key เองอยู่ใน env/KMS ไม่เคยอยู่ในตารางนี้
CREATE TABLE IF NOT EXISTS meta_credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label              text NOT NULL DEFAULT 'system-user',
  token_ciphertext   text NOT NULL,
  token_iv           text NOT NULL,
  token_auth_tag     text NOT NULL,
  key_version        int  NOT NULL DEFAULT 1,
  app_id             text,
  business_id        text,
  system_user_id     text,
  status             credential_status NOT NULL DEFAULT 'unchecked',
  last_checked_at    timestamptz,
  last_error_code    int,
  last_error_message text,
  -- ไม่มี token_expires_at แล้ว: System User token ไม่หมดอายุตามเวลา
  -- สิ่งที่ต้องรู้คือ "ยังใช้ได้ไหม" ไม่ใช่ "เหลือกี่วัน" (รายงานข้อ B3)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_credentials (
  page_id        uuid NOT NULL REFERENCES social_pages(id) ON DELETE CASCADE,
  credential_id  uuid NOT NULL REFERENCES meta_credentials(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, credential_id)
);

-- ─────────────────────────────────────────────────────────────
-- รูป: ต้นฉบับแยกจากที่ครอปแล้ว (รายงานข้อ C3)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,        -- path ของ "ต้นฉบับ" ห้ามเขียนทับ
  public_url    text,
  mime_type     text NOT NULL,
  width         int,
  height        int,
  bytes         bigint,
  status        asset_status NOT NULL DEFAULT 'uploading',
  original_name text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_tenant_idx ON media_assets (tenant_id, created_at DESC);

-- ครอป/overlay = derivative เสมอ re-crop สัดส่วนอื่นได้ตลอดเพราะต้นฉบับยังอยู่
CREATE TABLE IF NOT EXISTS media_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id      uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  aspect_ratio  text NOT NULL,        -- '1:1' | '4:5' | '9:16' | '1.91:1'
  storage_key   text NOT NULL,
  public_url    text NOT NULL,
  width         int NOT NULL,
  height        int NOT NULL,
  bytes         bigint,
  overlay       jsonb,                -- ข้อความ/โลโก้ที่วางทับ (ถ้ามี)
  status        asset_status NOT NULL DEFAULT 'ready',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, aspect_ratio)
);

-- ─────────────────────────────────────────────────────────────
-- คิวโพสต์ — เจตนา (posts) แยกจากผลรายปลายทาง (targets)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  caption        text NOT NULL DEFAULT '',
  asset_id       uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  scheduled_at   timestamptz NOT NULL,     -- timestamptz เสมอ (รายงานข้อ C8)
  status         post_status NOT NULL DEFAULT 'pending',
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  source         text NOT NULL DEFAULT 'human',   -- human | ai_agent (เผื่ออนาคต)
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,  -- (รายงานข้อ C6)
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_posts_queue_idx
  ON scheduled_posts (tenant_id, status, scheduled_at);

-- 1 แถว = 1 ปลายทาง หัวใจของการแก้ "โพสต์ครึ่งเดียว" (รายงานข้อ C1/D3)
CREATE TABLE IF NOT EXISTS post_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  post_id          uuid NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  page_id          uuid NOT NULL REFERENCES social_pages(id) ON DELETE CASCADE,
  platform         platform NOT NULL,
  status           target_status NOT NULL DEFAULT 'pending',

  -- กันงานซ้ำ: claim ด้วย FOR UPDATE SKIP LOCKED + locked_until (รายงานข้อ C2)
  locked_at        timestamptz,
  locked_until     timestamptz,
  locked_by        text,

  attempt_count    int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,

  -- idempotency: ก่อน retry เอาไปเทียบกับ recent media ของปลายทาง (รายงานข้อ D2)
  idempotency_key  text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),

  container_id     text,        -- IG creation_id ระหว่างรอ publish
  container_expires_at timestamptz,
  remote_id        text,        -- fb_post_id / ig_media_id หลังสำเร็จ
  remote_permalink text,

  error_code       int,
  error_subcode    int,
  error_message    text,
  error_retryable  boolean,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, page_id)
);
CREATE INDEX IF NOT EXISTS post_targets_claim_idx
  ON post_targets (status, next_attempt_at, locked_until);
CREATE INDEX IF NOT EXISTS post_targets_post_idx ON post_targets (post_id);

-- สถิติเป็น time series ไม่ใช่ column เดียว (รายงานข้อ C7)
CREATE TABLE IF NOT EXISTS post_metrics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_id    uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL DEFAULT now(),
  age_bucket   text NOT NULL,          -- '1h' | '24h' | '7d'
  impressions  bigint,
  reach        bigint,
  likes        bigint,
  comments     bigint,
  shares       bigint,
  saves        bigint,
  raw          jsonb,
  UNIQUE (target_id, age_bucket)
);

-- ─────────────────────────────────────────────────────────────
-- ชั้นคอนเทนต์ — แยกขาดจากชั้นโพสต์
-- ─────────────────────────────────────────────────────────────

-- โทนเสียงเป็นของ "เพจ" ไม่ใช่ของลูกค้า (รายงานข้อ C5)
CREATE TABLE IF NOT EXISTS brand_voice_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_id          uuid NOT NULL REFERENCES social_pages(id) ON DELETE CASCADE,
  tone_description text NOT NULL DEFAULT '',
  example_captions text[] NOT NULL DEFAULT '{}',
  keywords_include text[] NOT NULL DEFAULT '{}',
  keywords_avoid   text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id)
);

-- ร่างเกิดก่อนโพสต์ได้ FK จึง nullable (รายงานข้อ C4)
CREATE TABLE IF NOT EXISTS caption_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scheduled_post_id  uuid REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  page_id            uuid REFERENCES social_pages(id) ON DELETE SET NULL,
  prompt_used        text NOT NULL,
  options            jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_index     int,
  model              text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caption_drafts_tenant_idx ON caption_drafts (tenant_id, created_at DESC);

-- โควตา/ต้นทุน AI ต่อลูกค้า กันเผาเงิน (รายงานข้อ B5/E7)
CREATE TABLE IF NOT EXISTS ai_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_month   date NOT NULL,          -- วันที่ 1 ของเดือน
  calls          int NOT NULL DEFAULT 0,
  prompt_tokens  bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, period_month)
);

CREATE TABLE IF NOT EXISTS tenant_limits (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ai_calls_per_month  int NOT NULL DEFAULT 300,
  ai_cost_cap_usd     numeric(12,6) NOT NULL DEFAULT 5.0,
  posts_per_day       int NOT NULL DEFAULT 50
);

-- ─────────────────────────────────────────────────────────────
-- observability
-- ─────────────────────────────────────────────────────────────

-- Phase 4 ข้อ 3 บอกเองว่าต้องมี (รายงานข้อ C9) — ห้ามเก็บ token ลงในนี้
CREATE TABLE IF NOT EXISTS api_call_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  target_id     uuid REFERENCES post_targets(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  operation     text NOT NULL,
  http_status   int,
  error_code    int,
  error_message text,
  duration_ms   int,
  request_meta  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_call_log_recent_idx ON api_call_log (created_at DESC);

-- heartbeat ของ worker: ไม่มีอันนี้ cron ตายเงียบทั้งสัปดาห์ (รายงานข้อ D9)
CREATE TABLE IF NOT EXISTS job_runs (
  id           bigserial PRIMARY KEY,
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  claimed      int NOT NULL DEFAULT 0,
  succeeded    int NOT NULL DEFAULT 0,
  failed       int NOT NULL DEFAULT 0,
  note         text
);
CREATE INDEX IF NOT EXISTS job_runs_recent_idx ON job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level       text NOT NULL DEFAULT 'info',   -- info | warning | critical
  title       text NOT NULL,
  body        text,
  post_id     uuid REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (tenant_id, read_at, created_at DESC);
