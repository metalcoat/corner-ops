# Website price job (see scrape.mjs) and the Payroll Relief job (payroll-relief.mjs). Built from the repo root:
#   docker compose --profile tools build supplier-prices
FROM node:22-bookworm-slim
WORKDIR /scraper
COPY deploy/supplier-scraper/package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /root/.npm
# Sign-in by hand (signin.sh): a virtual screen, shared on the deli network as a web page.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/supplier-scraper/scrape.mjs deploy/supplier-scraper/signin.mjs deploy/supplier-scraper/signin.sh deploy/supplier-scraper/session-cookies.mjs deploy/supplier-scraper/payroll-relief.mjs ./
# Payroll Relief job (payroll-relief.mjs) reads and fills the timesheet with this, as the app does.
COPY src/lib/supplier-web-extract.ts src/lib/payroll-relief-timesheet.ts ./
ENV NODE_OPTIONS=--no-warnings
ENTRYPOINT ["node", "scrape.mjs"]
