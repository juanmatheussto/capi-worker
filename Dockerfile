FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
COPY public ./public
RUN npm run build

ENV NODE_ENV=production
# APP_ROLE=worker -> processa a fila; qualquer outro valor (ou vazio) -> API
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec node dist/worker.js; else exec node dist/server.js; fi"]
