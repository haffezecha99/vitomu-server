import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import { runConversion, buildFFmpegArgs, applyAudioMetadata, createCompanionLrc } from './ffmpeg.js';
import { downloadYoutubeAudio } from './youtubeService.js';

export class ConversionQueue extends EventEmitter {
  constructor(concurrency = 2) {
    super();
    this.concurrency = concurrency;
    this.jobs = new Map(); // jobId -> jobData
    this.activeProcesses = new Map(); // jobId -> ChildProcess
    this.queue = []; // Array of jobIds
  }

  createJob({ jobId, originalName, filePath, metadata, sourceType = 'upload', youtubeUrl = null }) {
    const job = {
      jobId,
      originalName,
      filePath,
      sourceType,
      youtubeUrl,
      metadata,
      status: 'uploaded', // 'uploaded' | 'queued' | 'converting' | 'completed' | 'failed' | 'cancelled'
      format: null,
      preset: null,
      outputPath: null,
      audioMetadata: null,
      thumbPath: null,
      customCoverPath: null,
      lrcPath: null,
      hasLyrics: false,
      progress: {
        percent: 0,
        currentSec: 0,
        totalDuration: metadata?.duration || 0,
        speed: '0x',
        etaSeconds: 0
      },
      error: null,
      createdAt: Date.now(),
      completedAt: null
    };

    this.jobs.set(jobId, job);
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  enqueue(jobId, { format = 'mp3', preset = 'super_jernih', customOptions = {}, selectedTrackIndex = 0, metadata = {} }) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job tidak ditemukan.');

    if (job.status === 'converting' || job.status === 'queued') {
      throw new Error('Proses konversi untuk berkas ini sedang berlangsung atau berada dalam antrean.');
    }

    const ext = format.toLowerCase() === 'opus' ? 'opus' : format.toLowerCase();
    const outputFileName = `${jobId}.${ext}`;
    const outputDir = path.resolve(path.dirname(job.filePath), '../outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const outputPath = path.join(outputDir, outputFileName);

    job.status = 'queued';
    job.format = format;
    job.preset = preset;
    job.customOptions = customOptions;
    job.selectedTrackIndex = selectedTrackIndex;
    job.outputPath = outputPath;
    job.audioMetadata = metadata || {};
    job.error = null;
    job.progress.percent = 0;

    this.queue.push(jobId);
    this.emit('job-updated', job);
    this.emit(`progress:${jobId}`, job);

    this.processNext();
    return job;
  }

  async processNext() {
    if (this.activeProcesses.size >= this.concurrency) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    const nextJobId = this.queue.shift();
    const job = this.jobs.get(nextJobId);

    if (!job || job.status === 'cancelled') {
      return this.processNext();
    }

    job.status = 'converting';
    this.emit('job-updated', job);
    this.emit(`progress:${job.jobId}`, job);

    // Jika sumber adalah YouTube dan berkas stream belum ada di disk, unduh terlebih dahulu
    if (job.sourceType === 'youtube' && (!job.filePath || !fs.existsSync(job.filePath))) {
      job.progress = {
        percent: 5,
        currentSec: 0,
        totalDuration: job.metadata?.duration || 0,
        speed: '1x',
        etaSeconds: 0,
        status: 'Mengunduh audio dari YouTube...'
      };
      this.emit(`progress:${job.jobId}`, job);

      try {
        const actualDownloaded = await downloadYoutubeAudio({
          url: job.youtubeUrl,
          outputPath: job.filePath,
          onProgress: (p) => {
            job.progress = {
              ...job.progress,
              percent: Math.min(Math.round(p.percent * 0.4), 40),
              status: p.status
            };
            this.emit(`progress:${job.jobId}`, job);
          }
        });
        job.filePath = actualDownloaded;
      } catch (dlErr) {
        console.error(`[Queue] Gagal unduh audio YouTube pada ${job.jobId}:`, dlErr.message);
        job.status = 'failed';
        job.error = `Gagal mengunduh audio YouTube: ${dlErr.message}`;
        this.emit('job-updated', job);
        this.emit(`progress:${job.jobId}`, job);
        return this.processNext();
      }
    }

    const sourceCodec = job.metadata?.audioStreams?.[job.selectedTrackIndex]?.codec_name || '';

    const ffmpegArgs = buildFFmpegArgs({
      inputPath: job.filePath,
      outputPath: job.outputPath,
      format: job.format,
      preset: job.preset,
      customOptions: job.customOptions || {},
      selectedTrackIndex: job.selectedTrackIndex || 0,
      sourceCodec
    });

    console.log(`[Queue] Memulai konversi jobId: ${job.jobId} -> Format: ${job.format}`);

    const proc = runConversion({
      jobId: job.jobId,
      inputPath: job.filePath,
      outputPath: job.outputPath,
      duration: job.metadata?.duration || 0,
      ffmpegArgs,
      onProgress: (p) => {
        job.progress = { ...job.progress, ...p };
        this.emit(`progress:${job.jobId}`, job);
      },
      onComplete: () => {
        this.activeProcesses.delete(job.jobId);

        // 1. Tanam Metadata, Cover Art Album, dan Lirik langsung ke dalam wadah file audio (MP3, M4A, FLAC, dll.)
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          const uploadsDir = path.dirname(job.filePath);
          const thumbPath = path.join(uploadsDir, `${job.jobId}_thumb.jpg`);
          try {
            applyAudioMetadata(job.outputPath, job.audioMetadata || {}, thumbPath, job.format);
          } catch (tagErr) {
            console.warn(`[Queue] Gagal menanam metadata audio pada ${job.jobId}:`, tagErr.message);
          }
        }

        // 2. Buat file lirik pendamping (.lrc) di folder dan nama yang sama dengan audio jika lirik tersedia
        if (job.audioMetadata?.lyrics && job.outputPath && fs.existsSync(job.outputPath)) {
          try {
            const lrcPath = createCompanionLrc(job.outputPath, job.audioMetadata.lyrics, job.audioMetadata || {});
            if (lrcPath) {
              job.lrcPath = lrcPath;
              job.hasLyrics = true;
            }
          } catch (lrcErr) {
            console.warn(`[Queue] Gagal membuat file lirik .lrc pendamping pada ${job.jobId}:`, lrcErr.message);
          }
        }

        job.status = 'completed';
        job.progress.percent = 100;
        job.progress.etaSeconds = 0;
        job.completedAt = Date.now();
        console.log(`[Queue] Selesai: ${job.jobId} (${job.originalName})`);
        this.emit('job-updated', job);
        this.emit(`progress:${job.jobId}`, job);
        this.processNext();
      },
      onError: (err) => {
        this.activeProcesses.delete(job.jobId);
        if (job.status !== 'cancelled') {
          job.status = 'failed';
          job.error = err.message;
          console.error(`[Queue] Gagal: ${job.jobId} - ${err.message}`);
        }
        job.completedAt = Date.now();
        this.emit('job-updated', job);
        this.emit(`progress:${job.jobId}`, job);
        this.processNext();
      }
    });

    this.activeProcesses.set(job.jobId, proc);
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job tidak ditemukan.');

    if (this.queue.includes(jobId)) {
      this.queue = this.queue.filter((id) => id !== jobId);
      job.status = 'cancelled';
      job.completedAt = Date.now();
      this.emit('job-updated', job);
      this.emit(`progress:${jobId}`, job);
      return { success: true, message: 'Antrean berhasil dibatalkan.' };
    }

    const proc = this.activeProcesses.get(jobId);
    if (proc) {
      job.status = 'cancelled';
      job.completedAt = Date.now();
      proc.kill('SIGTERM');
      this.activeProcesses.delete(jobId);
      this.emit('job-updated', job);
      this.emit(`progress:${jobId}`, job);
      this.processNext();
      return { success: true, message: 'Proses konversi aktif berhasil dihentikan.' };
    }

    return { success: false, message: 'Job tidak sedang berjalan atau mengantre.' };
  }

  cleanupExpired(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      const isOld = (now - job.createdAt) > maxAgeMs;
      if (isOld && job.status !== 'converting') {
        try {
          if (job.filePath && fs.existsSync(job.filePath)) {
            fs.unlinkSync(job.filePath);
          }
          if (job.outputPath && fs.existsSync(job.outputPath)) {
            fs.unlinkSync(job.outputPath);
          }
          if (job.lrcPath && fs.existsSync(job.lrcPath)) {
            fs.unlinkSync(job.lrcPath);
          }
          const uploadsDir = path.dirname(job.filePath);
          const thumbFile = path.join(uploadsDir, `${jobId}_thumb.jpg`);
          if (fs.existsSync(thumbFile)) fs.unlinkSync(thumbFile);
          const coverFile = path.join(uploadsDir, `${jobId}_custom_cover.jpg`);
          if (fs.existsSync(coverFile)) fs.unlinkSync(coverFile);
        } catch (e) {
          console.warn(`[Cleanup] Error hapus berkas job ${jobId}: ${e.message}`);
        }
        this.jobs.delete(jobId);
        console.log(`[Cleanup] Berkas job kadaluarsa dihapus: ${jobId}`);
      }
    }
  }
}

export const queueManager = new ConversionQueue(2);
