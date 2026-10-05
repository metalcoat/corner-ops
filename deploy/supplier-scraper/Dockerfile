# Website price job (see scrape.mjs). Built from the repo root:
#   docker compose --profile tools build supplier-prices
FROM node:22-bookworm-slim
WORKDIR /scraper
COPY deploy/supplier-scraper/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /root/.npm
COPY deploy/supplier-scraper/scrape.mjs ./
COPY src/lib/supplier-web-extract.ts ./
ENV NODE_OPTIONS=--no-warnings
ENTRYPOINT ["node", "scrape.mjs"]
