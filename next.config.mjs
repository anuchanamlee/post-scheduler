/** @type {import('next').NextConfig} */
export default {
  experimental: {
    serverActions: { bodySizeLimit: '12mb' },
  },
  // โค้ดชุดเดียวถูกรัน 2 ทาง: Next bundler (เว็บ) และ node/tsx ตรงๆ (worker + scripts)
  // node ESM ต้องการนามสกุล .js ในทุก import ส่วน bundler ของ Next ไม่รู้จัก
  // extensionAlias ทำให้ทั้งสองฝั่งใช้ไฟล์ต้นฉบับชุดเดียวกันได้โดยไม่ต้อง build แยก
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
