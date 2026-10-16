import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';

// Cari lokasi binary yt-dlp yang siap pakai
const CANDIDATE_YTDLP = [
  path.resolve('./bin/yt-dlp'),
  path.resolve('server/bin/yt-dlp'),
  path.resolve('../server/bin/yt-dlp'),
  path.resolve(process.cwd(), 'bin/yt-dlp'),
  path.resolve(process.cwd(), 'server/bin/yt-dlp')
];

export function getYtDlpBinary() {
  const found = CANDIDATE_YTDLP.find((p) => fs.existsSync(p));
  if (found) return found;
  // Fallback ke command PATH sistem jika ada
  return 'yt-dlp';
}

/**
 * Validasi apakah URL merupakan URL YouTube yang valid
 */
export function validateYoutubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const ytRegex = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}(.*)?$/;
  return ytRegex.test(url.trim());
}

/**
 * Ekstrak ID video YouTube dari URL
 */
export function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|v\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Mendapatkan metadata video YouTube (Judul, Uploader, Durasi, Thumbnail)
 */
export function getYoutubeInfo(url) {
  return new Promise((resolve, reject) => {
    if (!validateYoutubeUrl(url)) {
      return reject(new Error('Tautan YouTube tidak valid. Pastikan link diawali dengan youtube.com atau youtu.be.'));
    }

    const ytdlpBin = getYtDlpBinary();
    const args = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=android,web,tv',
      url.trim()
    ];

    const proc = spawn(ytdlpBin, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Gagal membaca video YouTube: ${stderr.trim() || 'Kode keluar ' + code}`));
      }

      try {
        const data = JSON.parse(stdout);
        const duration = parseInt(data.duration || 0, 10);

        // Batasi durasi jika terlalu panjang (misal lebih dari 2 jam)
        if (duration > 7200) {
          return reject(new Error('Durasi video melebihi batas maksimal 2 jam.'));
        }

        // Cari thumbnail resolusi terbaik
        let bestThumb = data.thumbnail || null;
        if (data.thumbnails && Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
          const sorted = [...data.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
          bestThumb = sorted[0]?.url || bestThumb;
        }

        resolve({
          id: data.id,
          title: data.title || 'YouTube Audio',
          uploader: data.uploader || data.channel || 'Artis YouTube',
          channel: data.channel || data.uploader || '',
          duration,
          durationFormatted: data.duration_string || `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`,
          thumbnailUrl: bestThumb,
          viewCount: data.view_count || 0,
          url: data.webpage_url || url
        });
      } catch (err) {
        reject(new Error(`Gagal memproses data video YouTube: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal menjalankan yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Helper internal untuk download yt-dlp dengan client profile tertentu
 */
function execYtDlpDownload({ ytdlpBin, ffmpegPath, url, outputPath, clientProfile, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'ba/b/best', // Prioritaskan best audio, fallback ke best stream
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--js-runtimes', 'node',
      '--extractor-args', `youtube:player_client=${clientProfile}`,
      '--ffmpeg-location', ffmpegPath,
      '-o', outputPath,
      url.trim()
    ];

    const proc = spawn(ytdlpBin, args);
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d\.]+)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        onProgress({ percent: Math.round(percent), status: `Mengunduh audio: ${Math.round(percent)}%` });
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        const dir = path.dirname(outputPath);
        const baseName = path.basename(outputPath);
        const foundFile = fs.readdirSync(dir).find((f) => f.startsWith(baseName));
        if (foundFile) {
          const actualPath = path.join(dir, foundFile);
          resolve(actualPath);
        } else {
          reject(new Error(stderr.trim() || `Kode keluar ${code}`));
        }
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Mengunduh aliran audio YouTube dengan auto-retry & rotasi client anti-403 Forbidden
 */
export async function downloadYoutubeAudio({ url, outputPath, onProgress = null }) {
  const ytdlpBin = getYtDlpBinary();
  const ffmpegPath = ffmpegStatic || 'ffmpeg';

  // Daftar client extractor profile untuk menghindari 403 Forbidden
  const clientProfiles = [
    'android,web,tv',
    'web_embedded,android',
    'ios,web',
    'tv,web'
  ];

  let lastError = null;

  for (let i = 0; i < clientProfiles.length; i++) {
    const profile = clientProfiles[i];
    try {
      if (i > 0 && onProgress) {
        onProgress({ percent: 10, status: `Mencoba alternatif client stream (${i + 1}/${clientProfiles.length})...` });
      }
      const downloadedPath = await execYtDlpDownload({
        ytdlpBin,
        ffmpegPath,
        url,
        outputPath,
        clientProfile: profile,
        onProgress
      });
      return downloadedPath;
    } catch (err) {
      console.warn(`[YouTube DL] Percobaan client "${profile}" gagal:`, err.message);
      lastError = err;
      // Jika error 403 atau format not available, coba profile berikutnya
      if (i < clientProfiles.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  throw new Error(`Gagal mengunduh audio YouTube: ${lastError?.message || 'Akses ditolak (HTTP 403)'}`);
}
