import { sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TEST_DATABASE_URL, assertTestDatabase } from "./db.js";

/** Каждый запуск применяет миграции на пустую базу: так проверяется и сама цепочка миграций. */
export default async function setup() {
  assertTestDatabase(TEST_DATABASE_URL);
  const { db, close } = createDb(TEST_DATABASE_URL);
  try {
    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      throw new Error(
        "PostgreSQL для тестов недоступен. Запустите npm run db:local:start или docker compose up -d, " +
          "либо задайте TEST_DATABASE_URL. Подмены базы в тестах нет.",
        { cause: error },
      );
    }
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);
    await runMigrations(db);
  } finally {
    await close();
  }
}
