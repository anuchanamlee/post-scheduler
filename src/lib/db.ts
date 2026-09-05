import pg from 'pg';
import { env } from './env.js';

/**
 * ทุก query ที่แตะข้อมูลลูกค้าต้องผ่าน tenantQuery ซึ่งบังคับ tenant_id เสมอ
 * ตอนนี้ deploy แยก 1 DB ต่อ 1 ลูกค้า แต่โค้ดเขียนแบบ multi-tenant ตั้งแต่วันแรก
 * วันที่รวม DB = เปิด RLS ไม่ต้องไล่แก้ query (รายงานข้อ B1)
 */

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

export type Sql = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> {
  const res = await client.query<T>(sql, params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** ตัวช่วยที่ทำให้ลืม tenant_id ไม่ได้ — $1 คือ tenant เสมอ */
export function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> {
  if (!sql.includes('$1')) throw new Error('tenantQuery: SQL ต้องอ้าง $1 เป็น tenant_id');
  return query<T>(sql, [tenantId, ...params], client);
}
