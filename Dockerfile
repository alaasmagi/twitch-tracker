FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV CHROME_PATH=/usr/bin/google-chrome-stable

CMD ["node", "server.js"]
