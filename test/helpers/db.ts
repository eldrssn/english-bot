import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://english_bot@127.0.0.1:54329/english_bot_test";

/** Тесты очищают базу целиком, поэтому работают только с базой, в имени которой есть test. */
export function assertTestDatabase(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!name.includes("test")) {
    throw new Error(`Тесты запускаются только на базе с "test" в имени, получено: ${name}`);
  }
}

export function openTestDb() {
  assertTestDatabase(TEST_DATABASE_URL);
  return createDb(TEST_DATABASE_URL);
}

export async function resetDb(db: Db) {
  await db.execute(sql`
    DO $$
    DECLARE names text;
    BEGIN
      SELECT string_agg(format('%I', tablename), ', ') INTO names FROM pg_tables WHERE schemaname = 'public';
      EXECUTE 'TRUNCATE ' || names || ' RESTART IDENTITY CASCADE';
    END $$;
  `);
}

/** Проверяет, что запрос отклонён настоящим ограничением PostgreSQL с указанным именем. */
export async function expectConstraintViolation(promise: Promise<unknown>, constraint: string) {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, `ожидалось нарушение ${constraint}`).not.toBeNull();
  const cause = (error as { cause?: { constraint?: string; code?: string } }).cause;
  expect(cause?.constraint).toBe(constraint);
}
