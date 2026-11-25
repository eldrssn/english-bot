// Ученик проходит занятие до конца через бота: ответы кнопкой или сообщением, как в настоящем чате.
import type { Db } from "../../src/db/client.js";
import { answerCurrent, currentStep, userId, type FakeBot } from "./learning.js";

/** Решение «ответить верно?» по английскому слову вопроса и номеру попытки. */
export type Decide = (english: string, attemptNumber: number) => boolean;

/** Отвечает на текущее занятие ученика, пока оно не закончится. По умолчанию всё верно. */
export async function finishSession(db: Db, fake: FakeBot, telegramId: number, decide: Decide = () => true) {
  const id = await userId(db, telegramId);
  for (let guard = 0; guard < 200; guard++) {
    const step = await currentStep(db, id);
    if (!step) return;
    await answerCurrent(fake, db, telegramId, decide(step.version.english, step.attemptNumber));
  }
  throw new Error("Занятие не закончилось за 200 ответов");
}
