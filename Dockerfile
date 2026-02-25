# ── Base: Node 20 on Debian slim ─────────────────────────────────────────────
FROM node:20-slim

# ── Install Chromium + dependencies ──────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-cjk \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Tell Puppeteer where Chromium lives ──────────────────────────────────────
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV HEADLESS=true

# ── Create app directory ──────────────────────────────────────────────────────
WORKDIR /app

# ── Install Node dependencies ─────────────────────────────────────────────────
COPY package.json .
RUN npm install --omit=dev

# ── Copy source code ──────────────────────────────────────────────────────────
COPY src/ ./src/

# ── Run as non-root ─────────────────────────────────────────────────────────
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app
USER appuser

# ── Render uses PORT env var (default 10000) ────────────────────────────────
ENV PORT=10000
EXPOSE 10000

CMD ["node", "src/server.js"]
