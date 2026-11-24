// Пересоздаёт отдельную базу e2e и выдаёт роли тестовым преподавателям. Запускается до серверов Playwright.
import pg from "pg";
import { setTeacherRole } from "../src/admin/roles.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { ADMIN_DATABASE_URL, E2E_DATABASE_URL, E2E_DB_NAME, accounts } from "./env.js";

const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
try {
  await admin.connect();
} catch (error) {
  console.error(`Нет подключения к PostgreSQL. Запустите кластер: npm run db:local:start\n${String(error)}`);
  process.exit(1);
}
await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
await admin.end();

const { db, close } = createDb(E2E_DATABASE_URL);
try {
  await runMigrations(db);
  for (const account of Object.values(accounts)) {
    if (account.teacher) await setTeacherRole(db, { telegramId: account.telegramId, actor: "e2e" });
  }
} finally {
  await close();
}
console.log(`База ${E2E_DB_NAME} готова`);
