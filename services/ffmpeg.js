import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

import nodeID3 from 'node-id3';

// Cari binary ffmpeg & ffprobe yang tersedia di sistem atau fallback ke static
export function getBinaries() {
  const customFfmpeg = process.env.FFMPEG_PATH;
  const customFfprobe = process.env.FFPROBE_PATH;

  let ffmpegBin = customFfmpeg || ffmpegStatic;
  let ffprobeBin = customFfprobe || ffprobeStatic.path;

  // Cek jika ada binary sistem bawaan seperti /opt/homebrew/bin/ffmpeg atau /usr/local/bin/ffmpeg
  if (!customFfmpeg) {
    if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
      ffmpegBin = '/opt/homebrew/bin/ffmpeg';
    } else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
      ffmpegBin = '/usr/local/bin/ffmpeg';
    } else if (fs.existsSync('/usr/bin/ffmpeg')) {
      ffmpegBin = '/usr/bin/ffmpeg';
    }
  }

  if (!customFfprobe) {
    if (fs.existsSync('/opt/homebrew/bin/ffprobe')) {
      ffprobeBin = '/opt/homebrew/bin/ffprobe';
    } else if (fs.existsSync('/usr/local/bin/ffprobe')) {
      ffprobeBin = '/usr/local/bin/ffprobe';
    } else if (fs.existsSync('/usr/bin/ffprobe')) {
      ffprobeBin = '/usr/bin/ffprobe';
    }
  }

  return { ffmpegBin, ffprobeBin };
}

/**
 * Validasi dan ekstrak metadata media via ffprobe
 */
export async function probeMedia(filePath) {
  const { ffprobeBin } = getBinaries();

  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    const proc = spawn(ffprobeBin, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Gagal menjalankan ffprobe: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`File tidak valid atau rusak: ${stderr || 'Kode keluar ' + code}`));
      }

      try {
        const data = JSON.parse(stdout);
        const format = data.format || {};
        const streams = data.streams || [];

        const audioStreams = streams
          .filter((s) => s.codec_type === 'audio')
          .map((s, idx) => ({
            index: s.index,
            audioTrackIndex: idx,
            codec_name: s.codec_name || 'unknown',
            sample_rate: s.sample_rate ? parseInt(s.sample_rate, 10) : null,
            channels: s.channels ? parseInt(s.channels, 10) : null,
            channel_layout: s.channel_layout || null,
            bit_rate: s.bit_rate ? parseInt(s.bit_rate, 10) : (format.bit_rate ? Math.round(parseInt(format.bit_rate, 10) * 0.2) : null),
            title: s.tags?.title || `Track ${idx + 1}`,
            language: s.tags?.language || 'und'
          }));

        if (audioStreams.length === 0) {
          return reject(new Error('File tidak memiliki trek audio yang dapat diproses.'));
        }

        const duration = parseFloat(format.duration || audioStreams[0]?.duration || 0);
        const size = parseInt(format.size || 0, 10);

        resolve({
          duration,
          size,
          format_name: format.format_name,
          bit_rate: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
          tags: format.tags || {},
          audioStreams,
          defaultAudio: audioStreams[0]
        });
      } catch (err) {
        reject(new Error(`Gagal membaca informasi media: ${err.message}`));
      }
    });
  });
}

/**
 * Susun array argumen FFmpeg secara ketat tanpa shell string
 */
export function buildFFmpegArgs({
  inputPath,
  outputPath,
  format = 'mp3',
  preset = 'super_jernih',
  customOptions = {},
  selectedTrackIndex = 0,
  sourceCodec = ''
}) {
  const args = ['-y', '-i', inputPath, '-vn'];

  // Map audio track yang dipilih
  args.push('-map', `0:a:${selectedTrackIndex}`);

  // Pertahankan metadata
  args.push('-map_metadata', '0');

  const fmt = format.toLowerCase();
  const {
    sampleRate,
    channels,
    bitrate,
    loudnorm = false,
    copyCodec = false
  } = customOptions;

  // Jika opsi direct copy AAC diaktifkan dan format tujuan m4a
  if (copyCodec && fmt === 'm4a' && (sourceCodec === 'aac' || sourceCodec.includes('aac'))) {
    args.push('-c:a', 'copy');
  } else {
    // Penentuan codec & parameter kualitas berdasarkan format dan opsi/preset
    switch (fmt) {
      case 'm4a':
      case 'aac': {
        args.push('-c:a', 'aac');
        const br = bitrate || (preset === 'hemat_ruang' ? '128' : (preset === 'super_jernih' ? '256' : '320'));
        args.push('-b:a', `${br}k`);
        args.push('-movflags', '+faststart');
        break;
      }
      case 'flac':
        args.push('-c:a', 'flac', '-compression_level', '8');
        break;
      case 'wav':
        args.push('-c:a', 'pcm_s24le');
        break;
      case 'opus': {
        args.push('-c:a', 'libopus');
        const br = bitrate || (preset === 'hemat_ruang' ? '96' : '160');
        args.push('-b:a', `${br}k`, '-vbr', 'on');
        break;
      }
      case 'ogg':
        args.push('-c:a', 'libvorbis');
        args.push('-q:a', preset === 'hemat_ruang' ? '4' : '7');
        break;
      case 'mp3':
      default:
        args.push('-c:a', 'libmp3lame');
        if (preset === 'hemat_ruang') {
          args.push('-q:a', '2');
        } else {
          const br = bitrate || '320';
          args.push('-b:a', `${br}k`);
        }
        break;
    }

    // Sample rate kustom jika dipilih
    if (sampleRate && [44100, 48000].includes(parseInt(sampleRate, 10))) {
      args.push('-ar', String(sampleRate));
    }

    // Channel kustom jika dipilih
    if (channels && [1, 2].includes(parseInt(channels, 10))) {
      args.push('-ac', String(channels));
    }

    // Audio filter: normalisasi volume (loudnorm -16 LUFS)
    if (loudnorm) {
      args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    }
  }

  // Gunakan ID3v2.3 untuk format MP3 agar kompatibel penuh dengan Android MediaStore & MediaMetadataRetriever
  if (fmt === 'mp3') {
    args.push('-id3v2_version', '3');
  }

  // Progress monitoring via pipe
  args.push('-progress', 'pipe:1', '-nostats', outputPath);

  return args;
}

/**
 * Ekstrak 1 frame gambar (thumbnail) dari video untuk dijadikan cover album default
 */
export async function extractVideoThumbnail(videoPath, outputPath, duration = 0) {
  const { ffmpegBin } = getBinaries();
  // Pilih titik waktu: 1 detik atau jika video sangat pendek (<1s), gunakan 0.1 detik
  const seekTime = duration > 1 ? '00:00:01' : '00:00:00.100';

  return new Promise((resolve) => {
    const args = [
      '-y',
      '-ss', seekTime,
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ];

    const proc = spawn(ffmpegBin, args);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(true);
      } else {
        // Fallback coba di 00:00:00 jika seek 1 detik gagal
        const fallbackProc = spawn(ffmpegBin, [
          '-y',
          '-ss', '00:00:00',
          '-i', videoPath,
          '-vframes', '1',
          '-q:v', '2',
          outputPath
        ]);
        fallbackProc.on('close', (fCode) => {
          resolve(fCode === 0 && fs.existsSync(outputPath));
        });
        fallbackProc.on('error', () => resolve(false));
      }
    });
    proc.on('error', () => resolve(false));
  });
}

/**
 * Parse teks LRC untuk memisahkan baris tersinkronisasi (timestamps)
 * dan lirik bersih teks murni (tanpa tag timestamp)
 */
export function parseLrcContent(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { syncItems: [], cleanText: '', hasTimestamps: false };
  }

  const lines = rawText.split(/\r?\n/);
  const syncItems = [];
  const cleanLines = [];
  let hasTimestamps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Lewati tag header seperti [ar:...], [ti:...], [length:...], [al:...]
    if (/^\[(ti|ar|al|by|offset|length):/i.test(line)) {
      continue;
    }

    // Tangkap baris timestamp: [mm:ss.xx] atau [mm:ss.xxx]
    const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/);
    if (match) {
      hasTimestamps = true;
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      let ms = 0;
      if (match[3]) {
        ms = match[3].length === 2 ? parseInt(match[3], 10) * 10 : parseInt(match[3], 10);
      }
      const totalMs = (min * 60 + sec) * 1000 + ms;
      const text = match[4].trim();
      syncItems.push({ text: text || ' ', timeStamp: totalMs });
      if (text && text !== '♪') {
        cleanLines.push(text);
      }
    } else {
      cleanLines.push(line);
    }
  }

  return {
    syncItems,
    cleanText: cleanLines.join('\n'),
    hasTimestamps
  };
}

/**
 * Tanam Metadata Audio, Cover Art, dan Lirik langsung ke dalam file audio (MP3, M4A, FLAC, dll.)
 * Menyuntikkan lirik dan cover art langsung ke dalam wadah file agar bisa diputar langsung tanpa file .lrc terpisah.
 */
export function applyAudioMetadata(audioPath, metadata = {}, fallbackThumbPath = null, format = 'mp3') {
  if (!fs.existsSync(audioPath)) return false;

  const fmt = (format || path.extname(audioPath).replace('.', '') || 'mp3').toLowerCase();

  // Tentukan file cover art (gambar kustom atau thumbnail video)
  let coverFile = null;
  if (metadata.customCoverPath && fs.existsSync(metadata.customCoverPath)) {
    coverFile = metadata.customCoverPath;
  } else if (metadata.useVideoThumbnail !== false && fallbackThumbPath && fs.existsSync(fallbackThumbPath)) {
    coverFile = fallbackThumbPath;
  }

  // 1. FORMAT MP3: Gunakan node-id3 untuk menanam tag ID3v2.3 (APIC, TIT2, TPE1, TALB, USLT, SYLT, TXXX:LYRICS)
  if (fmt === 'mp3') {
    const tags = {};

    if (metadata.title) tags.title = String(metadata.title).trim();
    if (metadata.artist) tags.artist = String(metadata.artist).trim();
    if (metadata.album) tags.album = String(metadata.album).trim();
    if (metadata.genre) tags.genre = String(metadata.genre).trim();
    if (metadata.year) tags.year = String(metadata.year).trim();

    // Suntikkan Lirik Langsung ke Berbagai Tag ID3 (USLT, SYLT, TXXX:LYRICS)
    if (metadata.lyrics && String(metadata.lyrics).trim().length > 0) {
      const rawLyrics = String(metadata.lyrics).trim();
      const { syncItems, hasTimestamps } = parseLrcContent(rawLyrics);

      // Tag USLT (Unsynchronized Lyrics): Masukkan format LRC bertanda waktu
      // agar player offline seperti Melodia langsung membaca timestamp tanpa butuh file .lrc terpisah!
      tags.unsynchronisedLyrics = {
        language: 'eng',
        text: rawLyrics
      };

      // Tag SYLT (Synchronised Lyrics ID3v2.3)
      if (hasTimestamps && syncItems.length > 0) {
        tags.synchronisedLyrics = [{
          language: 'eng',
          timeStampFormat: 2, // Milliseconds
          contentType: 1, // Lyrics
          shortText: '',
          synchronisedText: syncItems
        }];
      }

      // Tag TXXX:LYRICS & TXXX:UNSYNCEDLYRICS (dibaca langsung oleh Melodia, Musicolet, Poweramp)
      tags.userDefinedText = [
        { description: 'LYRICS', value: rawLyrics },
        { description: 'UNSYNCEDLYRICS', value: rawLyrics }
      ];
    }

    // Cover Art APIC (Type 3: Front Cover)
    if (coverFile) {
      try {
        const ext = path.extname(coverFile).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const imageBuffer = fs.readFileSync(coverFile);
        tags.image = {
          mime,
          type: { id: 3, name: 'front cover' },
          description: 'Front Cover',
          imageBuffer
        };
      } catch (imgErr) {
        console.warn(`[Metadata] Gagal menyematkan cover art MP3: ${imgErr.message}`);
      }
    }

    try {
      const success = nodeID3.write(tags, audioPath);
      return Boolean(success);
    } catch (err) {
      console.error(`[Metadata] Gagal menulis ID3 tag ke ${audioPath}:`, err.message);
      return false;
    }
  }

  // 2. FORMAT M4A / AAC / FLAC / OPUS / OGG: Gunakan FFmpeg Remuxing (Super Cepat ~0.05s tanpa re-encode)
  // Menyematkan Cover Art (attached_pic), Atom Metadata, dan Lirik (atom ©lyr / Vorbis Comments)
  try {
    const { ffmpegBin } = getBinaries();
    const parsedExt = path.extname(audioPath) || `.${fmt}`;
    const tempTagged = `${audioPath}_tagged_temp${parsedExt}`;

    const ffmpegArgs = ['-y', '-i', audioPath];

    if (coverFile) {
      ffmpegArgs.push('-i', coverFile);
    }

    // Audio stream mapping
    ffmpegArgs.push('-map', '0:a:0');

    // Video/Cover art stream mapping jika ada
    if (coverFile) {
      ffmpegArgs.push('-map', '1:v:0');
      ffmpegArgs.push('-c:v', 'copy');
      ffmpegArgs.push('-disposition:v:0', 'attached_pic');
    }

    // Copy audio stream langsung
    ffmpegArgs.push('-c:a', 'copy');

    // Metadata
    if (metadata.title) ffmpegArgs.push('-metadata', `title=${metadata.title.trim()}`);
    if (metadata.artist) {
      ffmpegArgs.push('-metadata', `artist=${metadata.artist.trim()}`);
      ffmpegArgs.push('-metadata', `album_artist=${metadata.artist.trim()}`);
    }
    if (metadata.album) ffmpegArgs.push('-metadata', `album=${metadata.album.trim()}`);
    if (metadata.year) ffmpegArgs.push('-metadata', `date=${metadata.year.trim()}`);
    if (metadata.genre) ffmpegArgs.push('-metadata', `genre=${metadata.genre.trim()}`);

    // Suntikkan lirik ke atom ©lyr (M4A) atau Vorbis LYRICS
    if (metadata.lyrics && String(metadata.lyrics).trim().length > 0) {
      ffmpegArgs.push('-metadata', `lyrics=${String(metadata.lyrics).trim()}`);
    }

    if (fmt === 'm4a') {
      ffmpegArgs.push('-movflags', '+faststart');
    }

    ffmpegArgs.push(tempTagged);

    const proc = spawnSync(ffmpegBin, ffmpegArgs);

    if (proc.status === 0 && fs.existsSync(tempTagged)) {
      fs.unlinkSync(audioPath);
      fs.renameSync(tempTagged, audioPath);
      return true;
    } else {
      if (fs.existsSync(tempTagged)) fs.unlinkSync(tempTagged);
      console.warn(`[Metadata] Remuxing tag FFmpeg gagal (kode ${proc.status})`);
      return false;
    }
  } catch (m4aErr) {
    console.error(`[Metadata] Gagal remuxing tag audio: ${m4aErr.message}`);
    return false;
  }
}

/**
 * Buat file lirik pendamping (.lrc) di folder dan nama yang sama persis dengan audio
 */
export function createCompanionLrc(audioPath, lyrics, metadata = {}) {
  if (!lyrics || typeof lyrics !== 'string' || lyrics.trim().length === 0) {
    return null;
  }

  let content = lyrics.trim();

  // Tambahkan header tag [ti:...], [ar:...], [al:...] jika belum ada
  const headers = [];
  if (metadata.title && !content.includes('[ti:')) {
    headers.push(`[ti:${metadata.title.trim()}]`);
  }
  if (metadata.artist && !content.includes('[ar:')) {
    headers.push(`[ar:${metadata.artist.trim()}]`);
  }
  if (metadata.album && !content.includes('[al:')) {
    headers.push(`[al:${metadata.album.trim()}]`);
  }

  if (headers.length > 0) {
    content = `${headers.join('\n')}\n${content}`;
  }

  const lrcPath = audioPath.replace(/\.[^.]+$/, '.lrc');
  fs.writeFileSync(lrcPath, content, 'utf8');
  return lrcPath;
}

/**
 * Parse output time string "HH:MM:SS.micro" ke detik
 */
export function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return parseFloat(timeStr) || 0;
}

/**
 * Jalankan proses konversi FFmpeg dengan SSE progress tracking
 */
export function runConversion({
  jobId,
  inputPath,
  outputPath,
  duration,
  ffmpegArgs,
  onProgress,
  onComplete,
  onError
}) {
  const { ffmpegBin } = getBinaries();
  const proc = spawn(ffmpegBin, ffmpegArgs);

  let stderrBuffer = '';

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    let outTimeUs = null;
    let outTimeStr = null;
    let speedStr = null;
    let totalSize = null;
    let isEnd = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const [key, val] = line.split('=');
      if (key === 'out_time_us') outTimeUs = parseInt(val, 10);
      else if (key === 'out_time') outTimeStr = val;
      else if (key === 'speed') speedStr = val;
      else if (key === 'total_size') totalSize = parseInt(val, 10);
      else if (key === 'progress' && val === 'end') isEnd = true;
    }

    let currentSec = 0;
    if (outTimeUs && outTimeUs > 0) {
      currentSec = outTimeUs / 1000000;
    } else if (outTimeStr) {
      currentSec = parseTimeToSeconds(outTimeStr);
    }

    let percent = 0;
    if (duration > 0) {
      percent = Math.min(100, Math.max(0, Math.round((currentSec / duration) * 100)));
    }
    if (isEnd) percent = 100;

    let speedNum = 1;
    if (speedStr && speedStr.endsWith('x')) {
      speedNum = parseFloat(speedStr.slice(0, -1)) || 1;
    }

    let etaSeconds = 0;
    if (duration > currentSec && speedNum > 0) {
      etaSeconds = Math.max(0, Math.round((duration - currentSec) / speedNum));
    }

    onProgress({
      jobId,
      percent,
      currentSec: Math.round(currentSec * 10) / 10,
      totalDuration: duration,
      speed: speedStr || '1x',
      etaSeconds,
      totalSize: totalSize || 0
    });
  });

  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    // Simpan hanya 1000 karakter terakhir untuk debugging jika terjadi error
    if (stderrBuffer.length > 3000) {
      stderrBuffer = stderrBuffer.slice(-3000);
    }
  });

  proc.on('error', (err) => {
    onError(new Error(`Gagal memulai FFmpeg: ${err.message}`));
  });

  proc.on('close', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      onError(new Error('Proses konversi telah dibatalkan oleh pengguna.'));
    } else if (code === 0) {
      onComplete({ jobId, outputPath });
    } else {
      onError(new Error(`Konversi gagal (kode ${code}): ${stderrBuffer || 'Kesalahan internal FFmpeg'}`));
    }
  });

  return proc;
}
