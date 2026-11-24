// Готовит ученика к проверке бота: связь с преподавателем для разработки, три тестовые подборки
// как собственные подборки этого преподавателя (их видно и можно править в кабинете) и их выдача ученику.
// npm run dev:prepare-student -- [telegram_id] [--reset]
//   telegram_id  ваш Telegram ID; без него берётся DEV_STUDENT_TELEGRAM_ID
//   --reset      начать обучение заново: удалить занятия, ответы и просмотры
import { loadWebConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadFixtureCollections } from "../src/db/fixtures.js";
import { PrepareStudentError, prepareDevStudent } from "../src/dev/prepare-student.js";
import { IssueError } from "../src/learning/issue.js";
import { MaterialsError } from "../src/materials/errors.js";

const args = process.argv.slice(2);
const resetProgress = args.includes("--reset");
const rawId = args.find((arg) => !arg.startsWith("--")) ?? process.env.DEV_STUDENT_TELEGRAM_ID;
const usage = "Использование: npm run dev:prepare-student -- <ваш telegram_id> [--reset]";

if (!rawId || !/^[1-9]\d{0,15}$/.test(rawId)) {
  console.error(usage);
  console.error("Telegram ID можно не указывать, если задать DEV_STUDENT_TELEGRAM_ID в .env.local.");
  process.exit(1);
}
const { databaseUrl, web } = loadWebConfig();
if (web.isProduction) {
  console.error("Команда не работает при NODE_ENV=production");
  process.exit(1);
}
if (!web.devLoginTelegramId) {
  console.error("Нужен DEV_LOGIN_TELEGRAM_ID в .env.local: под этим преподавателем вы входите в кабинет.");
  process.exit(1);
}

const { db, close } = createDb(databaseUrl);
try {
  const result = await prepareDevStudent(db, {
    appSecret: web.appSecret,
    teacherTelegramId: web.devLoginTelegramId,
    studentTelegramId: Number(rawId),
    fixtures: await loadFixtureCollections(),
    resetProgress,
  });
  console.log(
    result.link === "created"
      ? `Связь создана: запись ученика ${result.linkId}, преподаватель ${result.teacherTelegramId}.`
      : `Связь уже была: запись ученика ${result.linkId}, преподаватель ${result.teacherTelegramId}.`,
  );
  for (const collection of result.teacherCollections) {
    console.log(`Подборка преподавателя ${collection.created ? "создана" : "уже была"}: ${collection.title} (${collection.id})`);
  }
  for (const collection of result.collections) {
    const from = collection.source === "seed" ? " (копия служебной тестовой подборки, а не подборки из кабинета)" : "";
    console.log(`  ${collection.created ? "выдана" : "уже была"}: ${collection.title}${from}`);
  }
  if (result.resetSessions !== null) {
    console.log(`Прогресс сброшен: удалено занятий ${result.resetSessions}, слова и подборки в начальном состоянии.`);
  }
  console.log("Уведомления придут, когда запущен сервис (npm run dev). Если нет, откройте бота и нажмите /start.");
} catch (error) {
  if (error instanceof PrepareStudentError || error instanceof IssueError || error instanceof MaterialsError) {
    console.error(`Отказ: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await close();
}
