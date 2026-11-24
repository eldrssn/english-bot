// Экраны подключения. Тексты не называют ни имя ученика, ни детали чужих заявок.
import { Composer, InlineKeyboard } from "grammy";
import type { LinkingService, StudentAccess } from "../linking/service.js";
import {
  DECLINE_JOIN,
  JOIN_PATTERN,
  NEW_CODE,
  SWITCH_PATTERN,
  joinButton,
  switchButton,
} from "./callback-data.js";
import type { AppUser, BotContext } from "./context.js";

export const LINKING_TEXTS = {
  welcome:
    "Здравствуйте! Здесь вы будете заниматься английским с преподавателем. " +
    "Чтобы начать, попросите у преподавателя персональную ссылку и откройте её.",
  invalidLink: "Эта ссылка недействительна. Попросите у преподавателя новую.",
  teacherAccount:
    "Этот аккаунт — преподавательский: один аккаунт не может быть и преподавателем, и учеником. " +
    "Занятия с учениками ведутся в веб-кабинете.",
  hasActiveLink:
    "Вы уже занимаетесь с преподавателем. Чтобы подключиться по этой ссылке, " +
    "прежний преподаватель должен сначала убрать вас из своего списка.",
  declined: "Хорошо, присоединение отменено. Ссылка остаётся действительной до конца срока.",
  requestGone: "Заявка больше не действует. Попросите у преподавателя новую ссылку.",
  requestWaiting: "Заявка ждёт подтверждения преподавателя. Материалы откроются после этого.",
  formerNoCopies:
    "Преподаватель больше не ведёт ваши занятия, а выданных материалов у вас нет. " +
    "Чтобы заниматься снова, попросите у преподавателя персональную ссылку и откройте её.",
} as const;

export const newCodeKeyboard = () => new InlineKeyboard().text("Новый код", NEW_CODE);

const codeText = (code: string) =>
  `Ваш проверочный код: ${code}\n\n` +
  "Сообщите его преподавателю так, как вы обычно общаетесь. Код действует 24 часа. " +
  "Материалы откроются после подтверждения.";

/** Код хранится только хэшем, поэтому показать прежний нельзя: можно выпустить новый. */
export function requestText(codeActive: boolean) {
  return codeActive
    ? `${LINKING_TEXTS.requestWaiting}\n\nЕсли код потерялся, запросите новый: прежний перестанет действовать.`
    : `${LINKING_TEXTS.requestWaiting}\n\nСрок кода истёк или закончились попытки. Запросите новый.`;
}

async function replyWithAccess(ctx: BotContext, access: StudentAccess) {
  switch (access.kind) {
    case "teacher":
      await ctx.reply(LINKING_TEXTS.teacherAccount);
      return;
    case "request":
      await ctx.reply(requestText(access.codeActive), { reply_markup: newCodeKeyboard() });
      return;
    case "former_no_copies":
      await ctx.reply(LINKING_TEXTS.formerNoCopies);
      return;
    case "none":
    case "active":
    case "former":
      await ctx.reply(LINKING_TEXTS.welcome);
      return;
  }
}

function requireUser(ctx: BotContext): AppUser {
  if (!ctx.appUser) throw new Error("Обработчик вызван для события без отправителя");
  return ctx.appUser;
}

export function linkingHandlers(linking: LinkingService): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  // Код и кнопки показываются только в личном чате.
  const direct = composer.chatType("private");

  async function join(ctx: BotContext, token: string, allowSwitch: boolean) {
    const result = await linking.confirmJoin({ userId: requireUser(ctx).id, token, allowSwitch });
    await ctx.answerCallbackQuery();
    switch (result.kind) {
      case "joined":
        await ctx.reply(codeText(result.code), { reply_markup: newCodeKeyboard() });
        return;
      case "own_request":
        await ctx.reply(requestText(result.codeActive), { reply_markup: newCodeKeyboard() });
        return;
      case "switch_required":
        await ctx.reply(switchText(result.teacherName), { reply_markup: switchKeyboard(token) });
        return;
      case "invalid":
        await ctx.reply(LINKING_TEXTS.invalidLink);
        return;
      case "teacher_account":
        await ctx.reply(LINKING_TEXTS.teacherAccount);
        return;
      case "has_active_link":
        await ctx.reply(LINKING_TEXTS.hasActiveLink);
        return;
    }
  }

  direct.command("start", async (ctx, next) => {
    const token = typeof ctx.match === "string" ? ctx.match.trim() : "";
    const user = requireUser(ctx);
    if (token === "") {
      const access = await linking.getStudentAccess(user.id);
      // Ученик с активной связью или с копиями после отвязки идёт дальше, к учебным разделам.
      if (access.kind === "active" || access.kind === "former") {
        ctx.studentAccess = access;
        await next();
        return;
      }
      await replyWithAccess(ctx, access);
      return;
    }

    const opened = await linking.openLink({ userId: user.id, token });
    switch (opened.kind) {
      case "confirm_required":
        await ctx.reply(`Преподаватель ${opened.teacherName} приглашает вас на занятия. Присоединиться?`, {
          reply_markup: new InlineKeyboard().text("Присоединиться", joinButton(token)).row().text("Отказаться", DECLINE_JOIN),
        });
        return;
      case "switch_required":
        await ctx.reply(switchText(opened.teacherName), { reply_markup: switchKeyboard(token) });
        return;
      case "own_request":
        await ctx.reply(requestText(opened.codeActive), { reply_markup: newCodeKeyboard() });
        return;
      case "invalid":
        await ctx.reply(LINKING_TEXTS.invalidLink);
        return;
      case "teacher_account":
        await ctx.reply(LINKING_TEXTS.teacherAccount);
        return;
      case "has_active_link":
        await ctx.reply(LINKING_TEXTS.hasActiveLink);
        return;
    }
  });

  direct.callbackQuery(JOIN_PATTERN, (ctx) => join(ctx, ctx.match[1] as string, false));
  direct.callbackQuery(SWITCH_PATTERN, (ctx) => join(ctx, ctx.match[1] as string, true));

  direct.callbackQuery(DECLINE_JOIN, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(LINKING_TEXTS.declined);
  });

  direct.callbackQuery(NEW_CODE, async (ctx) => {
    const result = await linking.reissueCode({ userId: requireUser(ctx).id });
    await ctx.answerCallbackQuery();
    if (result.kind === "no_request") {
      await ctx.reply(LINKING_TEXTS.requestGone);
      return;
    }
    await ctx.reply(codeText(result.code), { reply_markup: newCodeKeyboard() });
  });

  // Всё остальное доступно ученику с активной связью и ученику с копиями после отвязки.
  composer.use(async (ctx, next) => {
    if (!ctx.appUser) return;
    if (ctx.studentAccess) {
      await next();
      return;
    }
    const access = await linking.getStudentAccess(ctx.appUser.id);
    if (access.kind === "active" || access.kind === "former") {
      ctx.studentAccess = access;
      await next();
      return;
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await replyWithAccess(ctx, access);
  });

  return composer;
}

function switchText(teacherName: string) {
  return (
    `У вас уже есть заявка к другому преподавателю, она ещё не подтверждена. ` +
    `Перейти к преподавателю ${teacherName}? Прежняя заявка будет отменена.`
  );
}

function switchKeyboard(token: string) {
  return new InlineKeyboard().text("Перейти", switchButton(token)).row().text("Оставить прежнюю", DECLINE_JOIN);
}
