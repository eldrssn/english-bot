# Образ сервиса для Railway (и любого хостинга с Docker): бот (webhook), API кабинета, кабинет и фоновые циклы
# в одном процессе. Миграции применяются отдельной командой перед запуском новой версии (preDeployCommand
# в railway.json): node dist/scripts/db-migrate.js.
# Проверка локально: docker build -t english-bot .

# ---------- Сборка: TypeScript в dist/, кабинет в dist/web ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- Запуск: только сборка и зависимости для работы ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
# Railway передаёт порт в PORT; при BOT_MODE=webhook сервис слушает 0.0.0.0.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["node", "dist/src/main.js"]
