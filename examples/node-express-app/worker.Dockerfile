# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY worker.js ./

CMD ["node", "worker.js"]
