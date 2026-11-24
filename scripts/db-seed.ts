import { loadDatabaseConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadFixtureCollections, seedFixtures } from "../src/db/fixtures.js";

const { db, close } = createDb(loadDatabaseConfig().databaseUrl);
try {
  const result = await seedFixtures(db, await loadFixtureCollections());
  console.log(`Загружено подборок: ${result.collectionCount}, карточек: ${result.cardCount}`);
} finally {
  await close();
}
