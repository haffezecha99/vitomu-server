import { describe, it, expect } from 'vitest';
import { validateYoutubeUrl, extractVideoId, getYoutubeInfo } from '../services/youtubeService.js';

describe('YouTube Service Tests', () => {
  it('1. Validasi URL YouTube berhasil mendeteksi format yang benar dan menolak format salah', () => {
    expect(validateYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(validateYoutubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(validateYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
    expect(validateYoutubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);

    expect(validateYoutubeUrl('https://google.com')).toBe(false);
    expect(validateYoutubeUrl('https://vimeo.com/123456')).toBe(false);
    expect(validateYoutubeUrl('')).toBe(false);
  });

  it('2. extractVideoId berhasil mengambil 11 karakter video id', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=123')).toBe('dQw4w9WgXcQ');
  });

  it('3. getYoutubeInfo membaca informasi video YouTube dengan benar', async () => {
    const info = await getYoutubeInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(info).toBeDefined();
    expect(info.id).toBe('dQw4w9WgXcQ');
    expect(info.title).toContain('Never Gonna Give You Up');
    expect(info.uploader).toContain('Rick Astley');
    expect(info.duration).toBeGreaterThan(0);
    expect(info.thumbnailUrl).toBeTruthy();
  }, 20000);
});
