import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CAFE_3D_COLLECTION,
  getRandomCafeCover,
  getCafeCoverByFilename
} from '../services/coverService.js';

describe('3D Cartoon Coffee Shop & Cafe Cover Service Tests', () => {
  it('1. Semua item koleksi 3D Cafe memiliki berkas gambar fisik yang valid di server', () => {
    expect(CAFE_3D_COLLECTION.length).toBeGreaterThanOrEqual(10);

    for (const item of CAFE_3D_COLLECTION) {
      expect(item.id).toBeTruthy();
      expect(item.filename).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.theme).toBeTruthy();

      const itemData = getCafeCoverByFilename(item.filename);
      expect(itemData).not.toBeNull();
      expect(fs.existsSync(itemData.filePath)).toBe(true);

      const stats = fs.statSync(itemData.filePath);
      expect(stats.size).toBeGreaterThan(10000); // Pastikan ukuran gambar valid (> 10KB)
    }
  });

  it('2. getRandomCafeCover menghasilkan cover acak lengkap dengan data base64', () => {
    const cover = getRandomCafeCover();
    expect(cover).toBeDefined();
    expect(cover.title).toBeTruthy();
    expect(cover.previewUrl).toContain('/api/cover/asset/');
    expect(cover.base64).toBeTruthy();
    expect(cover.base64.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('3. getRandomCafeCover menghindari duplikasi berturut-turut jika diberi excludeIndex', () => {
    const firstCover = getRandomCafeCover();
    const secondCover = getRandomCafeCover(firstCover.index);

    expect(secondCover.index).not.toBe(firstCover.index);
  });

  it('4. getCafeCoverByFilename mencegah directory traversal dan menangani berkas non-existent', () => {
    const invalid = getCafeCoverByFilename('../../../index.js');
    expect(invalid).toBeNull();

    const notFound = getCafeCoverByFilename('tidak_ada.jpg');
    expect(notFound).toBeNull();
  });

  it('5. Pencarian cover musik online iTunes API berhasil mengembalikan artwork HD dan metadata', async () => {
    const term = 'Coldplay Fix You';
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=3`;
    const response = await fetch(searchUrl);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data.results.length).toBeGreaterThan(0);

    const top = data.results[0];
    expect(top.artistName.toLowerCase()).toContain('coldplay');
    expect(top.artworkUrl100).toBeTruthy();

    const largeArt = top.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg');
    const imgRes = await fetch(largeArt);
    expect(imgRes.ok).toBe(true);
    expect(imgRes.headers.get('content-type')).toContain('image');
  });
});
