import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { queueManager } from './queue.js';

export function setupCleanupService(uploadsDir, outputsDir) {
  // Jalankan setiap 5 menit
  cron.schedule('*/5 * * * *', () => {
    console.log('[Cleanup] Menjalankan pembersihan otomatis file kadaluarsa...');
    const maxAgeMs = 30 * 60 * 1000; // 30 menit
    const now = Date.now();

    // 1. Bersihkan memory queue dan file terkait
    queueManager.cleanupExpired(maxAgeMs);

    // 2. Bersihkan file yatim di folder uploads
    [uploadsDir, outputsDir].forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            console.log(`[Cleanup] Menghapus file fisik kadaluarsa: ${filePath}`);
          }
        }
      } catch (err) {
        console.error(`[Cleanup] Gagal memindai direktori ${dir}:`, err.message);
      }
    });
  });

  console.log('[Cleanup] Layanan cron pembersihan otomatis aktif (setiap 5 menit).');
}
