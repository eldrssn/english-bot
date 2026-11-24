import { loadDatabaseConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const { db, close } = createDb(loadDatabaseConfig().databaseUrl);
try {
  await runMigrations(db);
  console.log("Миграции применены");
} finally {
  await close();
}
