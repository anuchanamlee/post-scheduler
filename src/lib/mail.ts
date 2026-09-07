import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';

/**
 * ส่งอีเมล — ใช้ที่เดียวคือลิงก์ตั้งรหัสผ่านใหม่
 *
 * ค่าเริ่มต้น `MAIL_TRANSPORT=mock` เขียนลงไฟล์แทนการยิงออกเน็ต เหตุผลเดียวกับ
 * notify: ระบบที่ส่งของจริงหาคนได้ตั้งแต่ยังไม่ตั้งใจส่ง คือระบบที่จะส่งผิดสักวัน
 * เทสต์กับเดโม่จึงอ่านผลจาก storage/sent-mail.json
 *
 * เขียน SMTP เองแทนลาก nodemailer เข้ามา ด้วยเหตุผลเดียวกับที่ storage.ts
 * ลงลายมือชื่อ SigV4 เอง: ที่ใช้จริงมีไม่กี่คำสั่ง และ dependency ที่ต้องตามอัปเดต
 * ตลอดอายุโปรเจกต์แพงกว่าโค้ดเท่านี้
 */

export type Mail = { to: string; subject: string; text: string };

export function mailConfigured(): boolean {
  return env.mail.transport === 'mock' || Boolean(env.mail.host && env.mail.from);
}

export async function sendMail(mail: Mail): Promise<void> {
  if (env.mail.transport === 'mock') {
    const file = path.join(env.storageDir, 'sent-mail.json');
    let sent: unknown[] = [];
    try {
      sent = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { /* ยังไม่มีไฟล์ */ }
    sent.unshift({ ...mail, sentAt: new Date().toISOString() });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(sent.slice(0, 200), null, 2));
    return;
  }

  if (!env.mail.host || !env.mail.from) {
    throw new Error('ยังไม่ได้ตั้งค่า SMTP (MAIL_HOST / MAIL_FROM)');
  }
  await sendSmtp(mail);
}

/**
 * SMTP เท่าที่ต้องใช้: EHLO → (STARTTLS) → (AUTH LOGIN) → MAIL FROM → RCPT TO → DATA
 *
 * ไม่รองรับ: ไฟล์แนบ · หลายผู้รับ · AUTH แบบอื่น — ยังไม่มีอะไรในระบบต้องใช้
 * เพิ่มเมื่อมีของที่ต้องใช้จริง ไม่ใช่เพิ่มเผื่อ
 */
async function sendSmtp(mail: Mail): Promise<void> {
  const { host, port, user, pass, from, secure } = env.mail;

  let socket: net.Socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setEncoding('utf8');
  socket.setTimeout(env.mail.timeoutMs);

  let buffer = '';
  const waiters: Array<(line: string) => void> = [];
  let failure: Error | null = null;

  const attach = (s: net.Socket) => {
    s.setEncoding('utf8');
    s.setTimeout(env.mail.timeoutMs);
    s.on('data', (chunk: string) => {
      buffer += chunk;
      // คำตอบหลายบรรทัดขึ้นต้นด้วย "250-" และปิดท้ายด้วย "250 " (ช่องว่าง)
      // อ่านทีละบรรทัดแล้วส่งต่อเฉพาะบรรทัดปิดท้าย
      let nl: number;
      while ((nl = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (/^\d{3} /.test(line)) waiters.shift()?.(line);
      }
    });
    s.on('timeout', () => { failure ??= new Error('SMTP ไม่ตอบภายในเวลาที่กำหนด'); s.destroy(); });
    s.on('error', (err) => { failure ??= err; });
  };
  attach(socket);

  const expect = (want: number) => new Promise<string>((resolve, reject) => {
    if (failure) return reject(failure);
    waiters.push((line) => {
      const code = Number(line.slice(0, 3));
      if (code === want) resolve(line);
      // ข้อความจากเซิร์ฟเวอร์บอกสาเหตุจริงเสมอ (โควตาเต็ม, ปฏิเสธผู้ส่ง, auth ผิด)
      // เก็บไว้ทั้งบรรทัด — สรุปเองแล้วจะ debug ไม่ออก
      else reject(new Error(`SMTP ตอบ ${line} (คาดว่า ${want})`));
    });
    socket.once('close', () => reject(failure ?? new Error('SMTP ปิดการเชื่อมต่อกลางคัน')));
  });

  const send = (line: string) => new Promise<void>((resolve, reject) => {
    socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
  });

  try {
    await expect(220);
    await send(`EHLO ${env.mail.helo}`);
    await expect(250);

    if (!secure && env.mail.starttls) {
      await send('STARTTLS');
      await expect(220);
      socket = tls.connect({ socket, host, servername: host });
      attach(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await send(`EHLO ${env.mail.helo}`);
      await expect(250);
    }

    if (user) {
      await send('AUTH LOGIN');
      await expect(334);
      await send(Buffer.from(user).toString('base64'));
      await expect(334);
      await send(Buffer.from(pass).toString('base64'));
      await expect(235);
    }

    await send(`MAIL FROM:<${from}>`);
    await expect(250);
    await send(`RCPT TO:<${mail.to}>`);
    await expect(250);
    await send('DATA');
    await expect(354);
    await send(body(mail, from));
    await send('.');
    await expect(250);
    // รอ 221 ก่อนปิด ไม่งั้นเราปิดสายไปแล้วเซิร์ฟเวอร์ยังไม่ทันอ่าน QUIT
    // ซึ่งฝั่งนั้นจะบันทึกว่าเป็นการตัดสายกลางคัน ทั้งที่จดหมายส่งสำเร็จไปแล้ว
    await send('QUIT');
    await expect(221).catch(() => { /* จดหมายรับไปแล้วตั้งแต่ 250 หลังจุด */ });
  } finally {
    socket.destroy();
  }
}

function body(mail: Mail, from: string): string {
  // หัวข้อภาษาไทยต้องเข้ารหัสเป็น base64 ตาม RFC 2047 ไม่งั้นปลายทางเห็นเป็นขยะ
  const subject = /^[\x20-\x7e]*$/.test(mail.subject)
    ? mail.subject
    : `=?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=`;
  // จุดที่ต้นบรรทัดต้องเบิ้ล ไม่งั้นบรรทัดนั้นถูกอ่านว่าจบข้อความ (dot-stuffing)
  const text = mail.text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
    '',
    text,
  ].join('\r\n');
}
