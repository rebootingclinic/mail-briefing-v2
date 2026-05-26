FROM node:20

# ghostscript 설치 (PDF → JPEG 변환용)
RUN apt-get update && \
    apt-get install -y ghostscript --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
