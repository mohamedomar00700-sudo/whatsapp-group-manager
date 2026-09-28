FROM node:22-slim

ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/tmp/app-data

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

RUN mkdir -p /tmp/app-data && chown -R 1000:1000 /tmp/app-data /app
USER 1000

EXPOSE 7860
CMD ["node", "server.js"]
