// Тексты и разметка разделов этапа 6: ежедневная практика, экзамен, прогресс, настройки. Без базы и Telegram.
import { InlineKeyboard } from "grammy";
import { formatClock, LEARNING_SETTINGS, parseClock, utcOffsetLabel } from "../domain/learning/index.js";
import type { DailyScreen, ExamScreen, ProgressScreen, StudentSettings } from "../learning/service.js";
import {
  DAILY_START,
  EXAM_START,
  MENU,
  REMINDER_TIME_LIST,
  SETTINGS_OPEN,
  remindersToggle,
  reminderTimeButton,
  resumeSession,
  timezoneButton,
  timezoneList,
} from "./callback-data.js";
import { TIMEZONE_PAGES, timezoneLabel } from "./timezones.js";

type Screen = { text: string; keyboard: InlineKeyboard };

export const PRACTICE_TEXTS = {
  /** Дословно по разделу 9 сценария. */
  dailyIntro: "Сегодня короткая практика: повторить сложные слова и проверить новые.",
  dailyNoTimezone:
    "Ежедневная практика привязана к вашему дню, поэтому сначала выберите часовой пояс. По нему же приходят напоминания.",
  dailyNoWords: "Слов пока нет, поэтому практики сегодня нет. Она появится, когда преподаватель выдаст подборку.",
  dailyCompleted: "Сегодняшняя практика пройдена. Следующая — завтра.",
  examNoWords: "Слов пока нет. Экзамен станет доступен, когда преподаватель выдаст подборку.",
  timezoneMissing:
    "Часовой пояс не выбран, поэтому напоминания о ежедневной практике не приходят. Выберите его, чтобы они приходили.",
  timezoneSaved: "Часовой пояс сохранён.",
  timeSaved: "Время напоминания сохранено.",
  remindersOn: "Напоминания включены.",
  remindersOff: "Напоминания выключены.",
  invalidTimezone: "Этот часовой пояс не распознан. Выберите другой.",
} as const;

const toMenu = (keyboard: InlineKeyboard) => keyboard.text("В меню", MENU);
export const chooseTimezoneButton = (keyboard: InlineKeyboard) => keyboard.text("Выбрать часовой пояс", timezoneList(0));

const streakLine = (streak: number) => `Серия дней с завершённой практикой: ${streak}.`;

// ---------- Ежедневная практика ----------

export function dailyScreen(screen: DailyScreen): Screen {
  const keyboard = new InlineKeyboard();
  const title = "Ежедневная практика";
  switch (screen.kind) {
    case "no_timezone":
      return { text: `${title}\n\n${PRACTICE_TEXTS.dailyNoTimezone}`, keyboard: toMenu(chooseTimezoneButton(keyboard).row()) };
    case "no_words":
      return { text: `${title}\n\n${PRACTICE_TEXTS.dailyNoWords}`, keyboard: toMenu(keyboard) };
    case "ready":
      return {
        text: [title, "", PRACTICE_TEXTS.dailyIntro, `Вопросов: ${screen.questionCount}.`, "", streakLine(screen.streak)].join("\n"),
        keyboard: toMenu(keyboard.text("Начать", DAILY_START).row()),
      };
    case "open":
      return {
        text: [
          title,
          "",
          PRACTICE_TEXTS.dailyIntro,
          `Отвечено: ${screen.answered} из ${screen.total}. Продолжить можно до конца дня.`,
          "",
          streakLine(screen.streak),
        ].join("\n"),
        keyboard: toMenu(keyboard.text("Продолжить", DAILY_START).row()),
      };
    case "completed":
      return {
        text: [title, "", PRACTICE_TEXTS.dailyCompleted, "", streakLine(screen.streak)].join("\n"),
        keyboard: toMenu(keyboard.text("Показать итог", resumeSession(screen.sessionId)).row()),
      };
  }
}

// ---------- Экзамен ----------

export function examScreen(screen: ExamScreen): Screen {
  const keyboard = new InlineKeyboard();
  if (screen.openSessionId !== null) {
    return {
      text: "Экзамен\n\nУ вас есть незавершённый экзамен. Продолжите его с сохранённого вопроса.",
      keyboard: toMenu(keyboard.text("Продолжить экзамен", resumeSession(screen.openSessionId)).row()),
    };
  }
  if (screen.wordCount === 0) return { text: `Экзамен\n\n${PRACTICE_TEXTS.examNoWords}`, keyboard: toMenu(keyboard) };
  const scope =
    screen.wordCount <= LEARNING_SETTINGS.examSize
      ? `Вопросов: ${screen.questionCount} — по всем вашим словам.`
      : `Вопросов: ${screen.questionCount} — поровну из всех ваших подборок.`;
  const text = [
    "Экзамен",
    "",
    scope,
    "Вопросы с кнопками и с вводом перевода, в обоих направлениях.",
    `После ошибки бот покажет верную пару и повторит слово один раз в конце серии из ${LEARNING_SETTINGS.seriesSize} вопросов.`,
    "Слово с двумя ошибками попадёт в «Сложные слова».",
    "В итоге — результат с первой попытки, после повтора и список ошибок.",
  ].join("\n");
  return { text, keyboard: toMenu(keyboard.text("Начать экзамен", EXAM_START).row()) };
}

// ---------- Прогресс ----------

export function progressScreen(progress: ProgressScreen): Screen {
  const lines = [
    "Мой прогресс",
    "",
    `Доступно слов: ${progress.available}`,
    `Изучено (есть хотя бы один ответ): ${progress.studied}`,
    `Сложные: ${progress.hard}`,
    `Освоено: ${progress.mastered}`,
    `Завершено подборок: ${progress.completedCollections} из ${progress.totalCollections}`,
    streakLine(progress.questStreak),
  ];
  if (progress.questCompletedToday === true) lines.push("Сегодняшняя практика пройдена.");
  if (progress.questCompletedToday === false) lines.push("Сегодняшняя практика ещё не пройдена.");
  return { text: lines.join("\n"), keyboard: toMenu(new InlineKeyboard()) };
}

// ---------- Настройки ----------

export function settingsScreen(settings: StudentSettings, now: Date, notice?: string): Screen {
  const zone = settings.timezone
    ? `${timezoneLabel(settings.timezone)} (${utcOffsetLabel(now, settings.timezone)})`
    : "не выбран — напоминания не приходят";
  const lines = [
    ...(notice ? [notice, ""] : []),
    "Настройки",
    "",
    `Напоминания о ежедневной практике: ${settings.remindersEnabled ? "включены" : "выключены"}`,
    `Время напоминания: ${settings.reminderTime}`,
    `Часовой пояс: ${zone}`,
  ];
  const keyboard = new InlineKeyboard()
    .text(settings.remindersEnabled ? "Выключить напоминания" : "Включить напоминания", remindersToggle(!settings.remindersEnabled))
    .row()
    .text(`Время: ${settings.reminderTime}`, REMINDER_TIME_LIST)
    .text("Часовой пояс", timezoneList(0))
    .row();
  return { text: lines.join("\n"), keyboard: toMenu(keyboard) };
}

/** Время напоминания: целые часы, по четыре в ряд. Текущее отмечено. */
export function reminderTimeScreen(settings: StudentSettings): Screen {
  const current = parseClock(settings.reminderTime);
  const keyboard = new InlineKeyboard();
  for (let hour = 0; hour < 24; hour++) {
    const minutes = hour * 60;
    const label = formatClock(minutes);
    keyboard.text(minutes === current ? `✓ ${label}` : label, reminderTimeButton(minutes));
    if (hour % 4 === 3) keyboard.row();
  }
  keyboard.text("Назад", SETTINGS_OPEN);
  return {
    text: `Во сколько присылать напоминание? Время — по вашему часовому поясу.\nСейчас: ${settings.reminderTime}.`,
    keyboard: toMenu(keyboard),
  };
}

export function timezoneScreen(settings: StudentSettings, requestedPage: number, now: Date): Screen {
  const pageIndex = Math.min(requestedPage, TIMEZONE_PAGES.length - 1);
  const page = TIMEZONE_PAGES[pageIndex]!;
  const keyboard = new InlineKeyboard();
  TIMEZONE_PAGES.forEach((tab, index) => {
    keyboard.text(index === pageIndex ? `• ${tab.title}` : tab.title, timezoneList(index));
  });
  keyboard.row();
  const perRow = page.showOffset ? 2 : 4;
  page.options.forEach((option, index) => {
    const selected = option.zone === settings.timezone ? "✓ " : "";
    const offset = page.showOffset ? ` (${utcOffsetLabel(now, option.zone)})` : "";
    keyboard.text(`${selected}${option.label}${offset}`, timezoneButton(option.zone));
    if (index % perRow === perRow - 1 || index === page.options.length - 1) keyboard.row();
  });
  keyboard.text("Назад", SETTINGS_OPEN);
  const current = settings.timezone ? `Сейчас: ${timezoneLabel(settings.timezone)} (${utcOffsetLabel(now, settings.timezone)}).` : "Сейчас пояс не выбран.";
  const lines = [
    "Выберите часовой пояс. По нему бот определяет ваш день для ежедневной практики и время напоминания.",
    current,
    "",
    `${page.title}.${page.showOffset ? "" : " Летнее время для этих поясов не учитывается."} Нет вашего города — выберите город с тем же временем или смещение от UTC.`,
  ];
  return { text: lines.join("\n"), keyboard: toMenu(keyboard) };
}
