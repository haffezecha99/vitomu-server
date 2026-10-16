import fs from 'fs';
import path from 'path';

const SYNC_TOPIC = 'https://ntfy.sh/vitomu_audio_engine_sync';
let lastPublishedUrl = null;

/**
 * Publikasikan URL server aktif ke registry online agar aplikasi HP dapat menemukannya secara otomatis
 */
export async function publishServerUrl(url) {
  if (!url || url === lastPublishedUrl) return;
  try {
    const res = await fetch(SYNC_TOPIC, {
      method: 'POST',
      headers: { 'Title': 'Vitomu Active Server' },
      body: url.trim()
    });
    if (res.ok) {
      lastPublishedUrl = url.trim();
      console.log(`[TunnelSync] Berhasil mempublikasikan URL aktif ke ntfy: ${lastPublishedUrl}`);
    }
  } catch (err) {
    console.warn(`[TunnelSync] Gagal mempublikasikan URL:`, err.message);
  }
}

/**
 * Setup sinkronisasi berkala
 */
export function setupTunnelSync() {
  const checkAndPublish = async () => {
    // 1. Cek file .active_tunnel jika ada
    const tunnelFilePath = path.resolve('.active_tunnel');
    if (fs.existsSync(tunnelFilePath)) {
      try {
        const fileContent = fs.readFileSync(tunnelFilePath, 'utf-8').trim();
        if (fileContent.startsWith('https://') && fileContent !== lastPublishedUrl) {
          await publishServerUrl(fileContent);
          return;
        }
      } catch (_) {}
    }
  };

  checkAndPublish();
  setInterval(checkAndPublish, 15000);
}
