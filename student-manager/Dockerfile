FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/revera.db
# 데이터는 /data 에 저장됩니다. 클라우드(Railway 등)에서 볼륨을 /data 에 연결하세요.
# (Railway는 Dockerfile 안의 볼륨 선언 명령을 허용하지 않아서 넣지 않습니다)
EXPOSE 3000
CMD ["node", "server.js"]
