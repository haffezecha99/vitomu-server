import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import archiver from 'archiver';
import { probeMedia, getBinaries, extractVideoThumbnail } from '../services/ffmpeg.js';
import { queueManager } from '../services/queue.js';
import { getRandomCafeCover, getCafeCoverByFilename, CAFE_3D_COLLECTION } from '../services/coverService.js';
import { validateYoutubeUrl, getYoutubeInfo, extractVideoId } from '../services/youtubeService.js';
import { spawnSync } from 'child_process';

const router = express.Router();

// Siapkan folder penyimpanan upload
const uploadsDir = path.resolve('temp/uploads');
const outputsDir = path.resolve('temp/outputs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

// Konfigurasi Multer untuk penyimpanan ke disk dengan batas 2GB
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeId = uuidv4();
    cb(null, `${safeId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2 GB
  }
});

// Helper sanitasi nama file untuk download selaras dengan metadata judul & artis
function getDownloadFilename(job, targetExt) {
  const meta = job?.audioMetadata || {};
  let baseName = '';
  if (meta.artist && meta.title) {
    baseName = `${meta.artist.trim()} - ${meta.title.trim()}`;
  } else if (meta.title) {
    baseName = meta.title.trim();
  } else {
    baseName = path.basename(job.originalName, path.extname(job.originalName));
  }
  const cleanBase = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'audio_converted';
  return `${cleanBase}.${targetExt}`;
}

function sanitizeFilename(originalName, targetExt) {
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim() || 'audio_converted';
  return `${baseName}.${targetExt}`;
}

// Helper simpan custom cover base64 ke disk
function saveCustomCover(jobId, base64Str) {
  if (!base64Str || typeof base64Str !== 'string') return null;
  const matches = base64Str.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
  if (!matches || matches.length < 3) return null;
  const ext = matches[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  const buffer = Buffer.from(matches[2], 'base64');
  const coverPath = path.join(uploadsDir, `${jobId}_custom_cover.${ext}`);
  fs.writeFileSync(coverPath, buffer);
  return coverPath;
}

/**
 * POST /api/upload
 * Mendukung upload hingga 10 berkas video sekaligus
 */
router.post('/upload', upload.array('videos', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Tidak ada berkas yang diunggah.' });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      const jobId = path.basename(file.filename, path.extname(file.filename));
      try {
        // Cek dengan ffprobe
        const metadata = await probeMedia(file.path);

        // Ekstrak thumbnail 1 frame dari video sebagai default cover art
        const thumbPath = path.join(uploadsDir, `${jobId}_thumb.jpg`);
        await extractVideoThumbnail(file.path, thumbPath, metadata.duration);

        const defaultTitle = path.basename(file.originalname, path.extname(file.originalname));

        // Buat otomatis cover kartun 3D kedai kopi/cafe unik untuk video ini
        const aiCover = getRandomCafeCover();
        if (aiCover && aiCover.base64) {
          const coverPath = path.join(uploadsDir, `${jobId}_custom_cover.jpg`);
          fs.writeFileSync(coverPath, Buffer.from(aiCover.base64.split(',')[1], 'base64'));
        }

        const job = queueManager.createJob({
          jobId,
          originalName: file.originalname,
          filePath: file.path,
          metadata
        });

        results.push({
          jobId: job.jobId,
          originalName: job.originalName,
          defaultTitle,
          thumbnailUrl: `/api/thumbnail/${job.jobId}`,
          aiCover: aiCover ? {
            id: aiCover.id,
            title: aiCover.title,
            theme: aiCover.theme,
            previewUrl: aiCover.previewUrl,
            base64: aiCover.base64
          } : null,
          size: file.size,
          metadata: {
            duration: metadata.duration,
            size: metadata.size,
            format_name: metadata.format_name,
            audioStreams: metadata.audioStreams,
            defaultAudio: metadata.defaultAudio
          }
        });
      } catch (probeErr) {
        // Hapus file fisik jika ffprobe gagal (misal corrupt atau tidak ada audio)
        if (fs.existsSync(file.path)) {
          try { fs.unlinkSync(file.path); } catch (_) {}
        }
        errors.push({
          fileName: file.originalname,
          error: probeErr.message
        });
      }
    }

    res.json({
      success: true,
      files: results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('[API /upload error]', err);
    res.status(500).json({ error: `Gagal memproses upload: ${err.message}` });
  }
});

/**
 * POST /api/youtube/info
 * Menerima URL YouTube, membaca metadata video, thumbnail, dan menyiapkan job konversi audio
 */
router.post('/youtube/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !validateYoutubeUrl(url)) {
      return res.status(400).json({
        error: 'Tautan YouTube tidak valid. Pastikan link diawali dengan youtube.com atau youtu.be.'
      });
    }

    const info = await getYoutubeInfo(url);
    const videoId = info.id || extractVideoId(url) || uuidv4().substring(0, 8);
    const jobId = `yt_${videoId}_${Date.now()}`;

    // Jalankan pembersihan artis & judul
    let detectedArtist = info.uploader || info.channel || '';
    let detectedTitle = info.title;

    const junkPatterns = [
      /\[[^\]]*(official\s*music\s*video|official\s*video|official\s*audio|official\s*lyric|official\s*mv|official|music\s*video|lyric\s*video|lyrics|lirik|visualizer|audio\s*only|audio|video|remastered|4k|1080p|720p|hd|hq|live\s*at|live)[^\]]*\]/gi,
      /\([^)]*(official\s*music\s*video|official\s*video|official\s*audio|official\s*lyric|official\s*mv|official|music\s*video|lyric\s*video|lyrics|lirik|visualizer|audio\s*only|audio|video|remastered|4k|1080p|720p|hd|hq|live\s*at|live)[^)]*\)/gi,
      /\[(mv|m\/v)\]/gi,
      /\((mv|m\/v)\)/gi
    ];

    let cleaned = info.title;
    for (const pat of junkPatterns) {
      cleaned = cleaned.replace(pat, '');
    }
    cleaned = cleaned.trim();

    if (cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ');
      if (parts.length >= 2) {
        detectedArtist = parts[0].trim();
        detectedTitle = parts.slice(1).join(' - ').trim();
      }
    } else {
      detectedTitle = cleaned;
    }

    // Unduh thumbnail YouTube sebagai cover awal
    const thumbPath = path.join(uploadsDir, `${jobId}_thumb.jpg`);
    if (info.thumbnailUrl) {
      try {
        const thumbRes = await fetch(info.thumbnailUrl);
        if (thumbRes.ok) {
          const buffer = Buffer.from(await thumbRes.arrayBuffer());
          fs.writeFileSync(thumbPath, buffer);
        }
      } catch (thumbErr) {
        console.warn(`[YouTube] Gagal mengunduh thumbnail:`, thumbErr.message);
      }
    }

    const rawAudioPath = path.join(uploadsDir, `${jobId}_source.webm`);
    const job = queueManager.createJob({
      jobId,
      originalName: `${detectedTitle || info.title}.webm`,
      filePath: rawAudioPath,
      sourceType: 'youtube',
      youtubeUrl: url,
      metadata: {
        duration: info.duration,
        size: 0,
        format_name: 'youtube_stream',
        audioStreams: [
          {
            index: 0,
            audioTrackIndex: 0,
            codec_name: 'opus',
            title: 'Trek Audio YouTube',
            language: 'und'
          }
        ],
        defaultAudio: {
          index: 0,
          audioTrackIndex: 0,
          codec_name: 'opus',
          title: 'Trek Audio YouTube'
        }
      }
    });

    const hasLocalThumb = fs.existsSync(thumbPath);
    const thumbUrl = hasLocalThumb ? `/api/thumbnail/${job.jobId}` : info.thumbnailUrl;

    res.json({
      success: true,
      file: {
        jobId: job.jobId,
        sourceType: 'youtube',
        youtubeUrl: url,
        originalName: `${detectedTitle || info.title}.webm`,
        defaultTitle: detectedTitle,
        defaultArtist: detectedArtist,
        thumbnailUrl: thumbUrl,
        duration: info.duration,
        formattedDuration: info.durationFormatted,
        size: 0,
        metadata: job.metadata,
        metadataInput: {
          title: detectedTitle,
          artist: detectedArtist,
          album: '',
          genre: '',
          year: new Date().getFullYear().toString(),
          useVideoThumbnail: true,
          customCoverBase64: null,
          customCoverPreview: thumbUrl,
          coverSource: 'youtube_thumbnail',
          coverTitle: 'Thumbnail YouTube',
          coverTheme: 'Original YouTube Cover',
          lyrics: ''
        }
      }
    });
  } catch (err) {
    console.error('[API /youtube/info error]', err);
    res.status(500).json({ error: err.message || 'Gagal memproses video YouTube.' });
  }
});

/**
 * GET /api/thumbnail/:jobId
 * Pratinjau thumbnail/frame video yang diekstrak
 */
router.get('/thumbnail/:jobId', (req, res) => {
  const { jobId } = req.params;
  const thumbPath = path.join(uploadsDir, `${jobId}_thumb.jpg`);
  if (fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(thumbPath);
  } else {
    res.status(404).json({ error: 'Thumbnail tidak ditemukan.' });
  }
});

/**
 * GET /api/cover/random-cafe
 * Mengambil cover album kartun 3D kedai kopi/cafe acak dari koleksi
 */
router.get('/cover/random-cafe', (req, res) => {
  try {
    const exclude = req.query.exclude ? parseInt(req.query.exclude, 10) : -1;
    const cover = getRandomCafeCover(exclude);
    const { jobId } = req.query;

    if (jobId && cover && cover.base64) {
      const coverPath = path.join(uploadsDir, `${jobId}_custom_cover.jpg`);
      fs.writeFileSync(coverPath, Buffer.from(cover.base64.split(',')[1], 'base64'));
    }

    res.json({
      success: true,
      cover
    });
  } catch (err) {
    console.error('[API /cover/random-cafe error]', err);
    res.status(500).json({ error: `Gagal mengambil cover cafe 3D: ${err.message}` });
  }
});

/**
 * GET /api/cover/asset/:filename
 * Menyajikan berkas cover kartun 3D cafe
 */
router.get('/cover/asset/:filename', (req, res) => {
  const cover = getCafeCoverByFilename(req.params.filename);
  if (!cover || !cover.filePath) {
    return res.status(404).json({ error: 'Berkas cover tidak ditemukan.' });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(cover.filePath);
});

/**
 * GET /api/cover/list
 * Daftar semua pilihan cover kartun 3D cafe
 */
router.get('/cover/list', (req, res) => {
  res.json({
    success: true,
    covers: CAFE_3D_COLLECTION.map((c, idx) => ({
      ...c,
      index: idx,
      previewUrl: `/api/cover/asset/${c.filename}`
    }))
  });
});

/**
 * GET /api/cover/search-online
 * Mencari cover album dan metadata musik resmi dari internet (iTunes Search API)
 */
router.get('/cover/search-online', async (req, res) => {
  try {
    const term = (req.query.term || req.query.query || `${req.query.artist || ''} ${req.query.title || ''}`).trim();
    if (!term) {
      return res.status(400).json({ error: 'Parameter term atau judul lagu diperlukan.' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Vitomu/2.0 MusicCoverFinder'
      }
    });

    if (!response.ok) {
      throw new Error(`iTunes API error (${response.status})`);
    }

    const data = await response.json();
    const results = (data.results || []).map((item) => {
      const art100 = item.artworkUrl100 || item.artworkUrl60 || '';
      return {
        id: item.trackId,
        title: item.trackName || '',
        artist: item.artistName || '',
        album: item.collectionName || '',
        year: item.releaseDate ? item.releaseDate.substring(0, 4) : '',
        genre: item.primaryGenreName || '',
        trackNumber: item.trackNumber || 1,
        coverUrlSmall: art100,
        coverUrlMedium: art100 ? art100.replace('100x100bb.jpg', '600x600bb.jpg') : '',
        coverUrlLarge: art100 ? art100.replace('100x100bb.jpg', '1000x1000bb.jpg') : '',
        previewAudioUrl: item.previewUrl || null
      };
    });

    res.json({
      success: true,
      term,
      count: results.length,
      results
    });
  } catch (err) {
    console.error('[API /cover/search-online error]', err);
    res.status(500).json({ error: `Gagal mencari cover musik di internet: ${err.message}` });
  }
});

/**
 * POST /api/cover/fetch-base64 & GET /api/cover/fetch-base64
 * Mengunduh gambar cover dari URL dan mengonversinya ke Base64
 */
async function handleFetchCoverBase64(req, res) {
  try {
    const imageUrl = req.body?.url || req.query?.url;
    const jobId = req.body?.jobId || req.query?.jobId;

    if (!imageUrl) {
      return res.status(400).json({ error: 'Parameter url gambar diperlukan.' });
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Gagal mengunduh gambar (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;

    if (jobId) {
      const coverPath = path.join(uploadsDir, `${jobId}_custom_cover.jpg`);
      fs.writeFileSync(coverPath, buffer);
    }

    res.json({
      success: true,
      base64,
      contentType,
      size: buffer.length
    });
  } catch (err) {
    console.error('[API /cover/fetch-base64 error]', err);
    res.status(500).json({ error: `Gagal mengambil cover: ${err.message}` });
  }
}

router.get('/cover/fetch-base64', handleFetchCoverBase64);
router.post('/cover/fetch-base64', handleFetchCoverBase64);

/**
 * POST /api/convert
 * Mulai konversi untuk satu atau banyak jobId dengan opsi metadata & lirik
 */
router.post('/convert', (req, res) => {
  try {
    const {
      jobId,
      jobIds,
      jobs,
      format = 'mp3',
      preset = 'super_jernih',
      customOptions = {},
      selectedTrackIndex = 0,
      metadata = {}
    } = req.body;

    const queuedJobs = [];

    // Helper untuk memastikan job ada sebelum di-enqueue (misal job YouTube yang dibuat via oEmbed di HP)
    const ensureJobExists = (id, meta, ytUrl) => {
      let existing = queueManager.getJob(id);
      if (!existing && (ytUrl || id.startsWith('yt_'))) {
        const rawAudioPath = path.join(uploadsDir, `${id}_source.webm`);
        existing = queueManager.createJob({
          jobId: id,
          originalName: `${meta.title || 'youtube_audio'}.webm`,
          filePath: rawAudioPath,
          sourceType: 'youtube',
          youtubeUrl: ytUrl || '',
          metadata: {
            duration: 0,
            size: 0,
            format_name: 'youtube_stream',
            audioStreams: [
              { index: 0, audioTrackIndex: 0, codec_name: 'opus', title: 'Trek Audio YouTube' }
            ]
          }
        });
      }
      return existing;
    };

    // Jika mengirim batch spesifik array jobs [{ jobId, format, preset, customOptions, selectedTrackIndex, metadata, youtubeUrl }]
    if (jobs && Array.isArray(jobs) && jobs.length > 0) {
      for (const item of jobs) {
        const id = item.jobId;
        const jobMeta = item.metadata || {};
        if (jobMeta.customCoverBase64) {
          const coverPath = saveCustomCover(id, jobMeta.customCoverBase64);
          if (coverPath) jobMeta.customCoverPath = coverPath;
        }

        ensureJobExists(id, jobMeta, item.youtubeUrl);

        const job = queueManager.enqueue(id, {
          format: item.format || format,
          preset: item.preset || preset,
          customOptions: item.customOptions || customOptions,
          selectedTrackIndex: item.selectedTrackIndex || 0,
          metadata: jobMeta
        });

        queuedJobs.push({
          jobId: job.jobId,
          status: job.status,
          format: job.format,
          preset: job.preset
        });
      }
    } else {
      const targetIds = jobIds && Array.isArray(jobIds) ? jobIds : [jobId].filter(Boolean);

      if (targetIds.length === 0) {
        return res.status(400).json({ error: 'Parameter jobId, jobIds, atau jobs wajib disertakan.' });
      }

      for (const id of targetIds) {
        const jobMeta = { ...metadata };
        if (jobMeta.customCoverBase64) {
          const coverPath = saveCustomCover(id, jobMeta.customCoverBase64);
          if (coverPath) jobMeta.customCoverPath = coverPath;
        }

        ensureJobExists(id, jobMeta, req.body?.youtubeUrl);

        const job = queueManager.enqueue(id, {
          format,
          preset,
          customOptions,
          selectedTrackIndex,
          metadata: jobMeta
        });

        queuedJobs.push({
          jobId: job.jobId,
          status: job.status,
          format: job.format,
          preset: job.preset
        });
      }
    }

    res.json({
      success: true,
      jobs: queuedJobs
    });
  } catch (err) {
    console.error('[API /convert error]', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/progress/:jobId
 * Server-Sent Events (SSE) stream untuk update progress real-time
 */
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = queueManager.getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job tidak ditemukan.' });
  }

  // Setup SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering untuk Nginx jika ada

  // Kirim initial state langsung
  const sendData = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendData({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    error: job.error
  });

  const progressHandler = (updatedJob) => {
    sendData({
      jobId: updatedJob.jobId,
      status: updatedJob.status,
      progress: updatedJob.progress,
      error: updatedJob.error
    });

    if (['completed', 'failed', 'cancelled'].includes(updatedJob.status)) {
      // Tunggu sejenak sebelum menutup koneksi
      setTimeout(() => {
        try { res.end(); } catch (_) {}
      }, 1000);
    }
  };

  queueManager.on(`progress:${jobId}`, progressHandler);

  req.on('close', () => {
    queueManager.off(`progress:${jobId}`, progressHandler);
  });
});

/**
 * POST /api/cancel/:jobId
 * Batalkan proses konversi
 */
router.post('/cancel/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const result = queueManager.cancelJob(jobId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/download/:jobId
 * Unduh hasil konversi berkas tunggal atau streaming preview
 */
router.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = queueManager.getJob(jobId);

  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Berkas hasil konversi tidak ditemukan atau belum selesai.' });
  }

  const isPreview = req.query.preview === 'true';
  const ext = job.format || path.extname(job.outputPath).replace('.', '') || 'mp3';
  const downloadName = getDownloadFilename(job, ext);

  if (isPreview) {
    res.sendFile(job.outputPath);
  } else {
    res.download(job.outputPath, downloadName, (err) => {
      if (err && !res.headersSent) {
        console.error(`[Download error] ${jobId}:`, err);
      }
    });
  }
});

/**
 * GET /api/download-lrc/:jobId
 * Unduh berkas lirik pendamping (.lrc) untuk pemutar musik offline seperti Melodia
 */
router.get('/download-lrc/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = queueManager.getJob(jobId);

  if (!job || !job.lrcPath || !fs.existsSync(job.lrcPath)) {
    return res.status(404).json({ error: 'Berkas lirik (.lrc) tidak ditemukan.' });
  }

  const downloadName = getDownloadFilename(job, 'lrc');
  // Pastikan content-type binary/lrc agar browser mobile tidak menambahkan .txt
  res.setHeader('Content-Type', 'application/octet-stream');
  res.download(job.lrcPath, downloadName, (err) => {
    if (err && !res.headersSent) {
      console.error(`[Download LRC error] ${jobId}:`, err);
    }
  });
});

/**
 * POST /api/download-zip
 * Unduh banyak hasil berkas dalam satu ZIP (termasuk file .lrc pendamping jika ada)
 */
router.post('/download-zip', (req, res) => {
  const { jobIds } = req.body;

  if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Daftar jobIds wajib disertakan.' });
  }

  const validJobs = jobIds
    .map((id) => queueManager.getJob(id))
    .filter((j) => j && j.outputPath && fs.existsSync(j.outputPath));

  if (validJobs.length === 0) {
    return res.status(404).json({ error: 'Tidak ada berkas yang selesai untuk diunduh dalam ZIP.' });
  }

  const archive = archiver('zip', {
    zlib: { level: 6 }
  });

  const zipName = `Audio_Converted_Batch_${Date.now()}.zip`;
  res.attachment(zipName);

  archive.on('error', (err) => {
    console.error('[Archive error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal membuat file ZIP.' });
    }
  });

  archive.pipe(res);

  const usedNames = new Set();
  for (const job of validJobs) {
    const ext = job.format || path.extname(job.outputPath).replace('.', '') || 'mp3';
    let baseName = getDownloadFilename(job, ext);
    let counter = 1;
    while (usedNames.has(baseName)) {
      const parsed = path.parse(baseName);
      baseName = `${parsed.name}_${counter}${parsed.ext}`;
      counter++;
    }
    usedNames.add(baseName);

    archive.file(job.outputPath, { name: baseName });

    // Sertakan file lirik .lrc pendamping dengan nama basis yang persis sama
    if (job.lrcPath && fs.existsSync(job.lrcPath)) {
      const baseNameWithoutExt = path.parse(baseName).name;
      const lrcName = `${baseNameWithoutExt}.lrc`;
      archive.file(job.lrcPath, { name: lrcName });
    }
  }

  archive.finalize();
});

/**
 * GET /api/health
 * Status kesehatan server dan informasi FFmpeg
 */
router.get('/health', (req, res) => {
  const { ffmpegBin, ffprobeBin } = getBinaries();

  let ffmpegVersion = 'Unknown';
  try {
    const check = spawnSync(ffmpegBin, ['-version']);
    if (check.stdout) {
      ffmpegVersion = check.stdout.toString().split('\n')[0] || 'Available';
    }
  } catch (e) {
    ffmpegVersion = 'Error checking: ' + e.message;
  }

  const allJobs = queueManager.getAllJobs();
  const activeCount = allJobs.filter((j) => j.status === 'converting').length;
  const queuedCount = allJobs.filter((j) => j.status === 'queued').length;

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    ffmpeg: {
      binary: ffmpegBin,
      version: ffmpegVersion
    },
    concurrency: queueManager.concurrency,
    activeJobs: activeCount,
    queueLength: queuedCount,
    totalJobsLoaded: allJobs.length,
    timestamp: new Date().toISOString()
  });
});

export default router;
