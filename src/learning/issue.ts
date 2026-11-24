// Служебная выдача подборки из тестовых данных: до редактора этапа 4 другого способа выдать материалы нет.
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issueCollectionCopy } from "../db/collections.js";
import { SEED_TEACHER_TELEGRAM_ID, seedFixtures, type FixtureCollection } from "../db/fixtures.js";
import { sourceCollections, studentCards, studentLinks, users } from "../db/schema.js";
import { lockLinks, lockUser } from "../linking/locks.js";
import { enqueueNewCollection } from "../notifications/queue.js";

export class IssueError extends Error {
  override name = "IssueError";
}

export type IssueResult = {
  studentCollectionId: number;
  /** Копия создана сейчас, а не найдена прежняя. */
  created: boolean;
  /** queued: связь активна, уведомление в очереди. after_confirmation: придёт после подтверждения связи. */
  notification: "queued" | "after_confirmation";
};

export async function issueFixtureCollection(
  db: Db,
  input: { studentLinkId: number; title: string; fixtures: FixtureCollection[] },
): Promise<IssueResult> {
  if (!input.fixtures.some((fixture) => fixture.title === input.title)) {
    const titles = input.fixtures.map((fixture) => `«${fixture.title}»`).join(", ");
    throw new IssueError(`В тестовых данных нет подборки «${input.title}». Есть: ${titles}`);
  }
  await seedFixtures(db, input.fixtures);

  return db.transaction(async (tx): Promise<IssueResult> => {
    const [source] = await tx
      .select({ id: sourceCollections.id })
      .from(sourceCollections)
      .innerJoin(users, eq(users.id, sourceCollections.teacherUserId))
      .where(
        and(
          eq(users.telegramId, SEED_TEACHER_TELEGRAM_ID),
          eq(sourceCollections.title, input.title),
          isNull(sourceCollections.deletedAt),
        ),
      );
    if (!source) throw new IssueError(`Подборка «${input.title}» не загружена`);

    // Порядок блокировок тот же, что при подтверждении связи: выдача не разойдётся с ним.
    const [peek] = await tx
      .select({ studentUserId: studentLinks.studentUserId })
      .from(studentLinks)
      .where(eq(studentLinks.id, input.studentLinkId));
    if (!peek) throw new IssueError(`Запись ученика ${input.studentLinkId} не найдена`);
    if (peek.studentUserId !== null) await lockUser(tx, peek.studentUserId);
    const [link] = await lockLinks(tx, [input.studentLinkId]);
    if (!link || link.studentUserId !== peek.studentUserId) {
      throw new IssueError("Запись ученика изменилась, повторите команду");
    }
    if (link.status === "ended") {
      throw new IssueError("Связь завершена: после отвязки новые материалы не выдаются");
    }

    const { studentCollectionId, created } = await issueCollectionCopy(tx, {
      studentLinkId: link.id,
      sourceCollectionId: source.id,
    });
    if (link.status !== "active" || link.studentUserId === null) {
      return { studentCollectionId, created, notification: "after_confirmation" };
    }
    const [cards] = await tx
      .select({ value: count() })
      .from(studentCards)
      .where(and(eq(studentCards.studentCollectionId, studentCollectionId), isNull(studentCards.deletedAt)));
    await enqueueNewCollection(tx, link.studentUserId, {
      id: studentCollectionId,
      title: input.title,
      wordCount: cards?.value ?? 0,
    });
    return { studentCollectionId, created, notification: "queued" };
  });
}
