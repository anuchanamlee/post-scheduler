import { resetTokenValid } from '../../../core/reset.js';
import ResetForm from './ResetForm.js';

/**
 * ตรวจลิงก์ตั้งแต่ตอนเปิดหน้า ไม่ใช่ตอนกดบันทึก
 * คนที่คิดรหัสใหม่เสร็จแล้วค่อยโดนบอกว่าลิงก์หมดอายุ คือคนที่ต้องคิดใหม่ทั้งหมดอีกรอบ
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await resetTokenValid(token);

  if (!valid) {
    return (
      <div className="wrap">
        <div className="panel login">
          <h2>ลิงก์ใช้ไม่ได้แล้ว</h2>
          <p className="msg bad">ลิงก์นี้ถูกใช้ไปแล้ว หมดอายุ หรือมีการขอลิงก์ใหม่ทับ</p>
          <p className="hint"><a href="/forgot">ขอลิงก์ใหม่อีกครั้ง</a></p>
        </div>
      </div>
    );
  }

  return <ResetForm token={token} />;
}
