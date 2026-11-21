# Autopilot Forex — production image.
# Railway builds this automatically when a Dockerfile is present at the repo root.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.json

FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# Runtime deps only; prisma and tsx are regular dependencies so migrations and
# the seed script still work inside the image.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist
# Seed script imports helpers from src, so it ships alongside the build.
COPY src ./src
COPY docs ./docs

# Railway injects PORT; the app defaults to 8080.
EXPOSE 8080

# migrate deploy is idempotent, so restarts are safe. Alternatively set a
# Pre-Deploy Command in Railway and drop this from CMD.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
