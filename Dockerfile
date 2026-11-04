# Arunachala dashboard, production image
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
