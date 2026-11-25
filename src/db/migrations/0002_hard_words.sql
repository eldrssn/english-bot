ALTER TABLE "attempts" ADD COLUMN "became_mastered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "prompt_message_id" bigint;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_hard_or_mastered" CHECK (NOT ("attempts"."became_hard" AND "attempts"."became_mastered"));--> statement-breakpoint
-- Попытка не меняется после записи: повторение и правка карточки создают новые строки, исходный результат остаётся.
-- Удаление не запрещено: его использует только сброс прогресса для разработки.
CREATE FUNCTION "attempts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Попытка % неизменна', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attempts_immutable" BEFORE UPDATE ON "attempts" FOR EACH ROW EXECUTE FUNCTION "attempts_immutable"();
