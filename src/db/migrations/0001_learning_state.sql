ALTER TYPE "public"."notification_reason" ADD VALUE 'request_rejected' BEFORE 'new_collection';--> statement-breakpoint
-- Демо-занятия этапа 1: история ответов остаётся, незавершённые закрываются, тип становится обычным тестом.
-- Продолжить их нельзя: у них нет learning_state.
UPDATE "questions" SET "status" = 'closed'
WHERE "status" <> 'closed' AND "session_id" IN (SELECT "id" FROM "sessions" WHERE "type" = 'demo');--> statement-breakpoint
UPDATE "sessions"
SET "status" = CASE WHEN "status" IN ('current', 'paused') THEN 'incomplete'::"public"."session_status" ELSE "status" END,
    "finished_at" = COALESCE("finished_at", now()),
    "type" = 'test'
WHERE "type" = 'demo';--> statement-breakpoint
-- Ограничение и индекс сравнивают тип с литералом перечисления: без пересоздания смена перечисления невозможна.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_quest_date_only_for_quest";--> statement-breakpoint
DROP INDEX "sessions_one_quest_per_local_date";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."session_type";--> statement-breakpoint
CREATE TYPE "public"."session_type" AS ENUM('test', 'translate', 'hard_words', 'daily_quest', 'exam');--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "type" SET DATA TYPE "public"."session_type" USING "type"::"public"."session_type";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_quest_date_only_for_quest" CHECK (("sessions"."type" = 'daily_quest') = ("sessions"."quest_local_date" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_quest_per_local_date" ON "sessions" USING btree ("student_user_id","quest_local_date") WHERE "sessions"."type" = 'daily_quest';--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "became_hard" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "learning_state" jsonb;
