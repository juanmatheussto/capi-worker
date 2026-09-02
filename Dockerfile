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
CMD ["node", "dist/server.js"]
