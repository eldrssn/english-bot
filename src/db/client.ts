import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { appLogger } from "../logger.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
/** Транзакция принимается там же, где и Db: функции работы с данными не зависят от того, что им передали. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | DbTx;

export type DbHandle = {
  db: Db;
  close: () => Promise<void>;
};

export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Без обработчика обрыв простаивающего соединения завершил бы процесс.
  pool.on("error", (error) => {
    appLogger.error({ component: "db", err: error }, "Ошибка соединения с PostgreSQL");
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
