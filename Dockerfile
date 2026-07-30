FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY app/package.json app/package.json
COPY sdk/package.json sdk/package.json
COPY mcp-server/package.json mcp-server/package.json

RUN npm ci --ignore-scripts

COPY sdk sdk
COPY mcp-server mcp-server

RUN npm --prefix sdk run build \
  && npm --prefix mcp-server run build

ENV NODE_ENV=production
ENV CHAINPAY_HTTP_HOST=0.0.0.0
ENV CHAINPAY_HTTP_PORT=3000

EXPOSE 3000

CMD ["node", "mcp-server/dist/http.js"]

