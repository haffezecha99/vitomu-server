FROM node:20-slim

# Install dependencies: python3, ffmpeg, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install binary yt-dlp terbaru
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Copy dependencies
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY . .

# Buat folder sementara untuk proses konversi
RUN mkdir -p temp/uploads temp/outputs

# Konfigurasi Port Render (default 5005 atau diberikan Render otomatis via env $PORT)
ENV PORT=5005
ENV NODE_ENV=production

EXPOSE 5005

CMD ["node", "index.js"]
