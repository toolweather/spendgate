# Stdio MCP for Glama's open-source registry.
# Glama builds this image, starts it, and calls initialize + tools/list.
# Storage is in-memory. PAY_TO is not read and no payment facilitator is called.
# The production Worker and its pricing are unchanged.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Ignore install scripts so wrangler's workerd download is not required.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.stdio.json ./
COPY src ./src
RUN npm run build:stdio

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/stdio.js"]
