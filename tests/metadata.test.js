import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import nodeID3 from 'node-id3';
import { spawnSync } from 'child_process';
import {
  extractVideoThumbnail,
  applyAudioMetadata,
  createCompanionLrc,
  getBinaries
} from '../services/ffmpeg.js';

describe('Audio Metadata & Lyrics Integration Tests', () => {
  const sampleVideo = path.resolve('../test_assets/sample1.mp4');
  const tempDir = path.resolve('./temp/test_run');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const thumbOut = path.join(tempDir, 'thumb_test.jpg');
  const customCover = path.join(tempDir, 'cover_test.jpg');
  const mp3Out = path.join(tempDir, 'audio_test.mp3');

  afterAll(() => {
    // Bersihkan file hasil uji coba
    [thumbOut, customCover, mp3Out, path.join(tempDir, 'audio_test.lrc')].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    if (fs.existsSync(tempDir)) {
      try { fs.rmdirSync(tempDir); } catch (_) {}
    }
  });

  it('1. Ekstraksi thumbnail dari video berhasil', async () => {
    const success = await extractVideoThumbnail(sampleVideo, thumbOut, 5);
    expect(success).toBe(true);
    expect(fs.existsSync(thumbOut)).toBe(true);
    expect(fs.statSync(thumbOut).size).toBeGreaterThan(100);
  });

  it('2. Pembuatan file lirik pendamping (.lrc) dengan nama yang persis sama', () => {
    const lyricsContent = '[00:01.50] Hello World\n[00:04.20] Testing Audio Converter';
    const lrcPath = createCompanionLrc(mp3Out, lyricsContent);

    expect(lrcPath).toBe(path.join(tempDir, 'audio_test.lrc'));
    expect(fs.existsSync(lrcPath)).toBe(true);
    expect(fs.readFileSync(lrcPath, 'utf8')).toBe(lyricsContent);
  });

  it('3. Penanaman metadata ID3v2.3 (TIT2, TPE1, TALB, APIC, USLT) ke berkas MP3', () => {
    const { ffmpegBin } = getBinaries();
    // Buat file MP3 dummy dari sample video
    spawnSync(ffmpegBin, ['-y', '-i', sampleVideo, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', mp3Out]);
    expect(fs.existsSync(mp3Out)).toBe(true);

    const metadata = {
      title: 'Judul Lagu Keren',
      artist: 'Artis Populer',
      album: 'Album Emas 2026',
      genre: 'Pop',
      year: '2026',
      lyrics: '[00:01.00] Baris Satu\n[00:05.00] Baris Dua',
      useVideoThumbnail: true
    };

    const tagged = applyAudioMetadata(mp3Out, metadata, thumbOut);
    expect(tagged).toBe(true);

    // Baca tag dengan node-id3
    const read = nodeID3.read(mp3Out);
    expect(read.title).toBe('Judul Lagu Keren');
    expect(read.artist).toBe('Artis Populer');
    expect(read.album).toBe('Album Emas 2026');
    expect(read.genre).toBe('Pop');
    expect(read.year).toBe('2026');
    expect(read.unsynchronisedLyrics?.text).toContain('Baris Satu');
    expect(read.image).toBeDefined();
    expect(read.image?.mime).toBe('image/jpeg');
    expect(read.image?.type?.id).toBe(3); // Front Cover
  });

  it('4. Penanaman metadata, lirik atom ©lyr, dan cover art attached_pic ke berkas M4A', () => {
    const { ffmpegBin, ffprobeBin } = getBinaries();
    const m4aOut = path.join(tempDir, 'audio_test.m4a');

    // Buat file M4A dummy dari sample video
    spawnSync(ffmpegBin, ['-y', '-i', sampleVideo, '-vn', '-c:a', 'aac', '-b:a', '256k', m4aOut]);
    expect(fs.existsSync(m4aOut)).toBe(true);

    const metadata = {
      title: 'Judul Lagu M4A',
      artist: 'Artis M4A',
      album: 'Album M4A',
      genre: 'Pop',
      year: '2026',
      lyrics: '[00:01.00] Baris Satu M4A\n[00:05.00] Baris Dua M4A',
      useVideoThumbnail: true
    };

    const tagged = applyAudioMetadata(m4aOut, metadata, thumbOut, 'm4a');
    expect(tagged).toBe(true);

    // Cek streams dan tags dengan ffprobe
    const out = spawnSync(ffprobeBin, ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', m4aOut]);
    const probeData = JSON.parse(out.stdout.toString());

    expect(probeData.format.tags.title).toBe('Judul Lagu M4A');
    expect(probeData.format.tags.artist).toBe('Artis M4A');
    expect(probeData.format.tags.lyrics).toContain('Baris Satu M4A');

    const videoStream = probeData.streams.find((s) => s.codec_type === 'video');
    expect(videoStream).toBeDefined();
    expect(videoStream.disposition.attached_pic).toBe(1);

    if (fs.existsSync(m4aOut)) fs.unlinkSync(m4aOut);
  });
});

