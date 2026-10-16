import { describe, it, expect } from 'vitest';
import { buildFFmpegArgs, parseTimeToSeconds } from '../services/ffmpeg.js';

describe('buildFFmpegArgs Unit Tests', () => {
  const defaultOpts = {
    inputPath: '/path/input.mp4',
    outputPath: '/path/output.mp3',
    selectedTrackIndex: 0
  };

  it('menghasilkan argumen preset Super Jernih (MP3 320k)', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      format: 'mp3',
      preset: 'super_jernih'
    });

    expect(args).toContain('-vn');
    expect(args).toContain('-map');
    expect(args).toContain('0:a:0');
    expect(args).toContain('-map_metadata');
    expect(args).toContain('0');
    expect(args).toContain('-c:a');
    expect(args).toContain('libmp3lame');
    expect(args).toContain('-b:a');
    expect(args).toContain('320k');
    expect(args[args.length - 1]).toBe('/path/output.mp3');
  });

  it('menghasilkan argumen preset Lossless (FLAC compression 8)', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      outputPath: '/path/output.flac',
      format: 'flac',
      preset: 'lossless'
    });

    expect(args).toContain('-c:a');
    expect(args).toContain('flac');
    expect(args).toContain('-compression_level');
    expect(args).toContain('8');
  });

  it('menghasilkan argumen preset Studio WAV (pcm_s24le)', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      outputPath: '/path/output.wav',
      format: 'wav',
      preset: 'studio_wav'
    });

    expect(args).toContain('-c:a');
    expect(args).toContain('pcm_s24le');
  });

  it('menghasilkan argumen preset Hemat Ruang (MP3 VBR -q:a 2)', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      format: 'mp3',
      preset: 'hemat_ruang'
    });

    expect(args).toContain('-c:a');
    expect(args).toContain('libmp3lame');
    expect(args).toContain('-q:a');
    expect(args).toContain('2');
  });

  it('menghasilkan direct copy (-c:a copy) jika format m4a dan sumber AAC dengan copyCodec', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      outputPath: '/path/output.m4a',
      format: 'm4a',
      sourceCodec: 'aac',
      customOptions: { copyCodec: true }
    });

    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
    expect(args).not.toContain('libmp3lame');
  });

  it('menambahkan filter loudnorm jika diaktifkan', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      format: 'mp3',
      preset: 'super_jernih',
      customOptions: { loudnorm: true }
    });

    expect(args).toContain('-af');
    expect(args).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
  });

  it('menerapkan sample rate dan channel kustom', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      format: 'mp3',
      customOptions: {
        sampleRate: 48000,
        channels: 1
      }
    });

    expect(args).toContain('-ar');
    expect(args).toContain('48000');
    expect(args).toContain('-ac');
    expect(args).toContain('1');
  });

  it('memetakan track audio spesifik selain default 0', () => {
    const args = buildFFmpegArgs({
      ...defaultOpts,
      selectedTrackIndex: 2
    });

    expect(args).toContain('-map');
    expect(args).toContain('0:a:2');
  });
});

describe('parseTimeToSeconds Helper Tests', () => {
  it('mengonversi format HH:MM:SS.xx ke detik dengan tepat', () => {
    expect(parseTimeToSeconds('00:01:30.50')).toBeCloseTo(90.5);
    expect(parseTimeToSeconds('01:00:00.00')).toBe(3600);
    expect(parseTimeToSeconds('00:00:05.12')).toBeCloseTo(5.12);
  });
});
