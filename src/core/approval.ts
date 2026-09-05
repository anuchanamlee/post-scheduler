import { one, query, tx } from '../lib/db.js';

/**
 * ขั้นตอนอนุมัติก่อนเผยแพร่ และสิทธิ์ผู้ใช้
 *
 * ทำไมร้านค้าต้องใช้: เจ้าของจ้างคนมาช่วยทำคอนเทนต์ แต่ยังอยากตรวจก่อนขึ้นเพจ
 * โพสต์ผิดบนเพจธุรกิจ ลบทีหลังก็มีคนเห็นไปแล้ว
 *
 * กติกาถูกบังคับที่ชั้นนี้ ไม่ใช่ที่ UI — ซ่อนปุ่มอย่างเดียวไม่ใช่การจำกัดสิทธิ์
 */

export type Role = 'owner' | 'approver' | 'editor';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'เจ้าของ',
  approver: 'ผู้อนุมัติ',
  editor: 'ผู้เขียน',
};

export const ROLE_HINT: Record<Role, string> = {
  owner: 'ทำได้ทุกอย่าง รวมจัดการผู้ใช้และการเชื่อมต่อ',
  approver: 'เขียนโพสต์ได้ และอนุมัติงานของคนอื่นได้',
  editor: 'เขียนโพสต์ได้ งานต้องผ่านการอนุมัติก่อนถึงจะขึ้นคิว',
};

export function canApprove(role: string): boolean {
  return role === 'owner' || role === 'approver';
}

export function canManageUsers(role: string): boolean {
  return role === 'owner';
}

export async function needsApproval(tenantId: string, role: string): Promise<boolean> {
  if (canApprove(role)) return false;
  const t = await one<{ require_approval: boolean }>(
    `SELECT require_approval FROM tenants WHERE id = $1`, [tenantId]);
  return Boolean(t?.require_approval);
}

export async function setApprovalRequired(tenantId: string, on: boolean) {
  await query(`UPDATE tenants SET require_approval = $2 WHERE id = $1`, [tenantId, on]);
}

export async function isApprovalRequired(tenantId: string): Promise<boolean> {
  const t = await one<{ require_approval: boolean }>(
    `SELECT require_approval FROM tenants WHERE id = $1`, [tenantId]);
  return Boolean(t?.require_approval);
}

/**
 * อนุมัติแล้วเข้าคิวทันที
 * บันทึกว่าใครอนุมัติและเมื่อไหร่ — ถ้าโพสต์มีปัญหาทีหลังจะได้รู้ว่าใครปล่อยผ่าน
 */
export async function approve(tenantId: string, postId: string, userId: string) {
  const rows = await query<{ id: string; scheduled_at: Date }>(
    `UPDATE scheduled_posts
        SET status = 'pending', approved_by = $3, approved_at = now(),
            rejected_reason = NULL, rejected_by = NULL, rejected_at = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending_approval'
      RETURNING id, scheduled_at`,
    [tenantId, postId, userId],
  );
  if (!rows.length) throw new Error('โพสต์นี้ไม่ได้อยู่ในสถานะรออนุมัติ');

  // เลยเวลาไปแล้วตอนอนุมัติ = ต้องบอก ไม่ใช่ปล่อยให้ worker mark missed เงียบๆ
  const late = rows[0].scheduled_at.getTime() < Date.now();
  return { id: rows[0].id, late, scheduledAt: rows[0].scheduled_at };
}

/** ตีกลับพร้อมเหตุผล — ไม่บอกว่าทำไม คนเขียนก็แก้ไม่ถูก */
export async function reject(
  tenantId: string, postId: string, userId: string, reason: string,
) {
  if (!reason.trim()) throw new Error('ต้องบอกเหตุผลที่ตีกลับ');

  return tx(async (client) => {
    const rows = await client.query<{ id: string }>(
      `UPDATE scheduled_posts
          SET status = 'draft', rejected_reason = $4, rejected_by = $3, rejected_at = now(),
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending_approval'
        RETURNING id`,
      [tenantId, postId, userId, reason.trim()],
    );
    if (!rows.rows.length) throw new Error('โพสต์นี้ไม่ได้อยู่ในสถานะรออนุมัติ');

    // คนเขียนต้องรู้ว่างานถูกตีกลับ ไม่ใช่มาเจอเองว่าโพสต์ไม่ขึ้น
    await client.query(
      `INSERT INTO notifications (tenant_id, level, title, body, post_id)
       VALUES ($1, 'warning', 'โพสต์ถูกตีกลับให้แก้', $2, $3)`,
      [tenantId, reason.trim(), postId],
    );
    return rows.rows[0];
  });
}

/** ส่งงานให้ตรวจ — ใช้ตอนคนเขียนแก้เสร็จแล้วส่งอีกรอบ */
export async function submitForApproval(tenantId: string, postId: string) {
  const rows = await query<{ id: string }>(
    `UPDATE scheduled_posts SET status = 'pending_approval', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING id`,
    [tenantId, postId],
  );
  if (!rows.length) throw new Error('ส่งตรวจได้เฉพาะโพสต์ที่เป็นร่าง');
  return rows[0];
}

export async function countAwaiting(tenantId: string): Promise<number> {
  const r = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM scheduled_posts
      WHERE tenant_id = $1 AND status = 'pending_approval'`,
    [tenantId],
  );
  return Number(r?.n ?? 0);
}

// ── จัดการผู้ใช้ ─────────────────────────────────────────────

export async function listUsers(tenantId: string) {
  return query<{ id: string; email: string; role: string; created_at: Date }>(
    `SELECT id, email, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
}

export async function setRole(tenantId: string, userId: string, role: Role, actorId: string) {
  if (userId === actorId) throw new Error('เปลี่ยนสิทธิ์ของตัวเองไม่ได้');

  // ต้องเหลือเจ้าของอย่างน้อย 1 คนเสมอ ไม่งั้นไม่มีใครจัดการระบบได้อีก
  if (role !== 'owner') {
    const owners = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE tenant_id = $1 AND role = 'owner' AND id <> $2`,
      [tenantId, userId],
    );
    if (Number(owners?.n ?? 0) === 0) {
      throw new Error('ต้องมีเจ้าของอย่างน้อย 1 คน');
    }
  }

  await query(`UPDATE users SET role = $3 WHERE tenant_id = $1 AND id = $2`,
              [tenantId, userId, role]);
}

export async function removeUser(tenantId: string, userId: string, actorId: string) {
  if (userId === actorId) throw new Error('ลบบัญชีตัวเองไม่ได้');
  const owners = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM users
      WHERE tenant_id = $1 AND role = 'owner' AND id <> $2`,
    [tenantId, userId],
  );
  if (Number(owners?.n ?? 0) === 0) throw new Error('ต้องมีเจ้าของอย่างน้อย 1 คน');
  await query(`DELETE FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
}
