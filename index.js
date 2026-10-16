import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './routes/api.js';
import { setupCleanupService } from './services/cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7860;

// Percaya reverse proxy (Cloudflare tunnel / Nginx) agar IP asli client terdeteksi
app.set('trust proxy', 1);

// Middleware keamanan & parsing dengan CORS luas
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['*']
}));
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rate limiter: Sangat longgar (1000 req/menit), lewati preflight OPTIONS, health check, progress, dan download
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Terlalu banyak permintaan dari alamat IP Anda. Harap tunggu sejenak.'
  },
  skip: (req) => {
    return (
      req.method === 'OPTIONS' ||
      req.originalUrl.includes('/progress') ||
      req.originalUrl.includes('/download') ||
      req.originalUrl.includes('/health')
    );
  }
});

app.use('/api', limiter);

// Structured request logging
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/progress')) {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    });
  }
  next();
});

// Daftarkan rute API
app.use('/api', apiRoutes);

// Direktori static untuk client build jika sudah dibuild
const clientDist = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDist));

// Fallback untuk SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = path.join(clientDist, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
          <meta charset="UTF-8">
          <title>Video to Audio Converter Backend</title>
          <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; text-align: center; }
            .card { background: #1e293b; max-width: 600px; margin: 40px auto; padding: 30px; border-radius: 12px; border: 1px solid #334155; }
            h1 { color: #38bdf8; }
            a { color: #38bdf8; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🚀 Backend Server Berjalan</h1>
            <p>API Video to Audio Converter aktif di port ${PORT}.</p>
            <p>Buka <a href="/api/health">/api/health</a> untuk melihat status server.</p>
          </div>
        </body>
        </html>
      `);
    }
  });
});

// Global Error Handler dalam Bahasa Indonesia
app.use((err, req, res, next) => {
  console.error('[Global Error]', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Ukuran file melebihi batas maksimal 2 GB.' });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Maksimal 10 berkas video per batch upload.' });
  }

  if (err.code === 'ENOSPC') {
    return res.status(507).json({ error: 'Penyimpanan disk server penuh. Coba beberapa saat lagi.' });
  }

  res.status(err.status || 500).json({
    error: err.message || 'Terjadi kesalahan sistem saat memproses permintaan Anda.'
  });
});

// Setup cron pembersihan otomatis file temp
const uploadsDir = path.resolve('temp/uploads');
const outputsDir = path.resolve('temp/outputs');
setupCleanupService(uploadsDir, outputsDir);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🎵 Video to Audio Converter Server`);
  console.log(`📡 Berjalan di: http://localhost:${PORT}`);
  console.log(`🛡️  Rate limit: 30 req/min per IP`);
  console.log(`⚙️  Konkurensi FFmpeg: 2 proses simultan`);
  console.log(`===============================================`);
});

export default app;
