import path from 'path';
import fs from 'fs';

// Folder aset cover 3D Cafe
const CANDIDATE_DIRS = [
  path.resolve('assets/covers/cafe3d'),
  path.resolve('server/assets/covers/cafe3d'),
  path.resolve('../assets/covers/cafe3d')
];
const COVERS_DIR = CANDIDATE_DIRS.find((d) => fs.existsSync(d)) || path.resolve('assets/covers/cafe3d');

// Koleksi gambar kartun 3D kedai kopi & cafe
export const CAFE_3D_COLLECTION = [
  {
    id: 'tiny_bean',
    filename: '01_tiny_bean_cafe.jpg',
    title: 'The Tiny Bean Cafe',
    theme: 'Miniatur Isometric 3D & Barista Chibi'
  },
  {
    id: 'parisian_terrace',
    filename: '02_parisian_terrace.jpg',
    title: "Café de L'Amour",
    theme: 'Teras Cafe Jalanan Paris 3D'
  },
  {
    id: 'rainy_mug',
    filename: '03_rainy_mug_night.jpg',
    title: 'The Rainy Mug',
    theme: 'Kedai Kopi Malam Hari 3D & Neon Lofi'
  },
  {
    id: 'cat_cafe',
    filename: '04_pawprint_cat_cafe.jpg',
    title: 'The Pawprint Cat Cafe',
    theme: 'Cat Cafe 3D dengan Kucing Menggemaskan'
  },
  {
    id: 'fern_bean',
    filename: '05_fern_bean_greenhouse.jpg',
    title: 'The Fern & Bean',
    theme: 'Greenhouse Botanical Cafe 3D Bernuansa Tanaman'
  },
  {
    id: 'boulangerie',
    filename: '06_boulangerie_pastry.jpg',
    title: 'Café Du Coeur Bakery',
    theme: 'Bakery Cafe 3D dengan Croissant & Macaron'
  },
  {
    id: 'kyoto_kissaten',
    filename: '07_kyoto_kissaten.jpg',
    title: 'Kissaten Momiji',
    theme: 'Kedai Kopi Tradisional Kyoto 3D & Sakura'
  },
  {
    id: 'vinyl_bean',
    filename: '08_vinyl_bean_lofi.jpg',
    title: 'The Vinyl Bean',
    theme: 'Cafe Piringan Hitam 3D Lofi Aesthetic'
  },
  {
    id: 'seaside_brews',
    filename: '09_seaside_brews.jpg',
    title: 'Seaside Brews',
    theme: 'Kedai Kopi Pantai 3D & Iced Coffee'
  },
  {
    id: 'snowflake_chalet',
    filename: '10_snowflake_chalet.jpg',
    title: 'The Snowflake Chalet',
    theme: 'Chalet Pegunungan Salju 3D & Cokelat Hangat'
  },
  {
    id: 'chibi_barista',
    filename: '11_chibi_barista_beats.jpg',
    title: 'Café Latté Beats',
    theme: 'Barista Chibi Anime 3D & Miniatur Kedai Kopi'
  },
  {
    id: 'neon_dreams',
    filename: '12_neon_dreams_cybercafe.jpg',
    title: 'Neon Dreams: Neko Cafe',
    theme: 'Cyberpunk Neko Cafe 3D Anime Futuristik'
  },
  {
    id: 'sakura_kissaten',
    filename: '13_sakura_kissaten_garden.jpg',
    title: 'Sakura Garden Kissaten',
    theme: 'Kedai Teh Matcha Kyoto 3D & Bunga Sakura'
  },
  {
    id: 'pawsitive_vibes',
    filename: '14_pawsitive_cat_melodies.jpg',
    title: 'Paw-sitive Cat Melodies',
    theme: 'Cat Cafe 3D Pastel & Kucing Lucu Menggemaskan'
  },
  {
    id: 'rainy_evening',
    filename: '15_rainy_evening_lofi.jpg',
    title: 'Rainy Street Coffee & Vinyl',
    theme: 'Kafe Romantis Senja Hujan 3D Anime & Piringan Hitam'
  }
];

let lastPickedIndex = -1;

/**
 * Mengambil cover kartun 3D acak dari koleksi
 * @param {number} [excludeIndex] - Opsional indeks yang dihindari agar tidak kembar berturut-turut
 * @returns {object} Metadata cover beserta path dan data base64
 */
export function getRandomCafeCover(excludeIndex = -1) {
  const total = CAFE_3D_COLLECTION.length;
  let pickIndex;

  if (total <= 1) {
    pickIndex = 0;
  } else {
    // Cari index yang tidak sama dengan excludeIndex atau lastPickedIndex
    let attempts = 0;
    do {
      pickIndex = Math.floor(Math.random() * total);
      attempts++;
    } while (
      (pickIndex === excludeIndex || pickIndex === lastPickedIndex) &&
      attempts < 15
    );
  }

  lastPickedIndex = pickIndex;
  const item = CAFE_3D_COLLECTION[pickIndex];
  const filePath = path.join(COVERS_DIR, item.filename);

  let base64 = null;
  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  return {
    index: pickIndex,
    id: item.id,
    filename: item.filename,
    title: item.title,
    theme: item.theme,
    previewUrl: `/api/cover/asset/${item.filename}`,
    base64
  };
}

/**
 * Ambil cover spesifik berdasarkan filename
 */
export function getCafeCoverByFilename(filename) {
  const safeFilename = path.basename(filename);
  const filePath = path.join(COVERS_DIR, safeFilename);
  if (!fs.existsSync(filePath)) return null;

  const item = CAFE_3D_COLLECTION.find((c) => c.filename === safeFilename) || {
    id: safeFilename,
    title: 'Kedai Kopi Kartun 3D',
    theme: '3D Cartoon Coffee Shop'
  };

  return {
    filePath,
    ...item
  };
}
