// Служебная выдача подборки из тестовых данных. Работает и с записью, которая ещё не подключена:
// копия хранится, а уведомление уйдёт после подтверждения связи.
// npm run dev:issue-collection -- <student_link_id> "<название подборки из fixtures>"
import { loadDatabaseConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadFixtureCollections } from "../src/db/fixtures.js";
import { IssueError, issueFixtureCollection } from "../src/learning/issue.js";

const [rawLinkId, title] = process.argv.slice(2);
if (!rawLinkId || !/^[1-9]\d{0,14}$/.test(rawLinkId) || !title) {
  console.error('Использование: npm run dev:issue-collection -- <student_link_id> "<название подборки из fixtures>"');
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.error("Команда не работает при NODE_ENV=production");
  process.exit(1);
}

const { db, close } = createDb(loadDatabaseConfig().databaseUrl);
try {
  const result = await issueFixtureCollection(db, {
    studentLinkId: Number(rawLinkId),
    title,
    fixtures: await loadFixtureCollections(),
  });
  console.log(result.created ? `Копия создана: ${result.studentCollectionId}` : `Копия уже была: ${result.studentCollectionId}`);
  console.log(
    result.notification === "queued"
      ? "Уведомление поставлено в очередь."
      : "Связь ещё не подтверждена: уведомление уйдёт после подтверждения.",
  );
} catch (error) {
  console.error(error instanceof IssueError ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
