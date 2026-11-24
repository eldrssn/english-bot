// Выдача исходной подборки нескольким ученикам. Каждому — независимая копия, выдача атомарна по каждому ученику.
// Ограничение «одна действующая копия на запись ученика и исходную подборку» оставлено сознательно:
// повтор запроса и повторная выдача не создают дублей.
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issueCollectionCopy } from "../db/collections.js";
import { sourceCards, sourceCollections, studentCards, studentCollections, studentLinks } from "../db/schema.js";
import { lockLinks, lockUser } from "../linking/locks.js";
import { enqueueNewCollection } from "../notifications/queue.js";
import { renderNotification } from "../notifications/render.js";
import type { IssueOutcome, IssuePreviewResponse, IssueResponse } from "../shared/api-contract.js";
import { MaterialsError } from "./errors.js";

type OpenLink = { id: number; displayName: string; status: "pending_connection" | "pending_confirmation" | "active" };

export function createIssueService(db: Db) {
  async function liveSource(teacherUserId: number, collectionId: number) {
    const [source] = await db
      .select({ id: sourceCollections.id, title: sourceCollections.title })
      .from(sourceCollections)
      .where(
        and(
          eq(sourceCollections.id, collectionId),
          eq(sourceCollections.teacherUserId, teacherUserId),
          isNull(sourceCollections.deletedAt),
        ),
      );
    if (!source) throw new MaterialsError("not_found");
    return source;
  }

  /** Записи из запроса. Хотя бы одна чужая, завершённая или несуществующая — отказ целиком, без подробностей. */
  async function ownLinks(teacherUserId: number, studentIds: number[]): Promise<OpenLink[]> {
    const ids = [...new Set(studentIds)];
    const rows = await db
      .select({ id: studentLinks.id, displayName: studentLinks.displayName, status: studentLinks.status })
      .from(studentLinks)
      .where(and(inArray(studentLinks.id, ids), eq(studentLinks.teacherUserId, teacherUserId), ne(studentLinks.status, "ended")));
    if (rows.length !== ids.length) throw new MaterialsError("not_found");
    const byId = new Map(rows.map((row) => [row.id, row as OpenLink]));
    return ids.map((id) => byId.get(id)!);
  }

  return {
    /** Кто и какое уведомление получит. Ничего не меняет. */
    async preview(teacherUserId: number, collectionId: number, studentIds: number[]): Promise<IssuePreviewResponse> {
      const source = await liveSource(teacherUserId, collectionId);
      const links = await ownLinks(teacherUserId, studentIds);
      const [cards] = await db
        .select({ value: count() })
        .from(sourceCards)
        .where(and(eq(sourceCards.collectionId, collectionId), isNull(sourceCards.deletedAt)));
      const issued = await db
        .select({ linkId: studentCollections.studentLinkId })
        .from(studentCollections)
        .where(
          and(
            eq(studentCollections.sourceCollectionId, collectionId),
            inArray(
              studentCollections.studentLinkId,
              links.map((link) => link.id),
            ),
            isNull(studentCollections.deletedAt),
          ),
        );
      const already = new Set(issued.map((row) => row.linkId));
      const message = renderNotification("new_collection", { title: source.title, wordCount: cards?.value ?? 0 });
      return {
        recipients: links.map((link) => {
          const outcome: IssueOutcome = already.has(link.id) ? "already_issued" : link.status === "active" ? "now" : "after_connection";
          return {
            studentId: link.id,
            displayName: link.displayName,
            status: link.status,
            outcome,
            message: outcome === "already_issued" ? null : message,
          };
        }),
      };
    },

    /**
     * Выдача. Права проверяются для всех записей до первой копии. Затем каждому ученику — своя транзакция:
     * копия и уведомление появляются вместе или не появляются вовсе.
     */
    async issue(teacherUserId: number, collectionId: number, studentIds: number[]): Promise<IssueResponse> {
      await liveSource(teacherUserId, collectionId);
      const links = await ownLinks(teacherUserId, studentIds);
      const results: IssueResponse["results"] = [];
      for (const target of links) {
        results.push(await issueOne(teacherUserId, collectionId, target));
      }
      return { results };
    },
  };

  async function issueOne(teacherUserId: number, collectionId: number, target: OpenLink): Promise<IssueResponse["results"][number]> {
    return db.transaction(async (tx) => {
      // Порядок блокировок общий для проекта: ученик, затем запись.
      const [peek] = await tx.select({ studentUserId: studentLinks.studentUserId }).from(studentLinks).where(eq(studentLinks.id, target.id));
      if (!peek) throw new MaterialsError("not_found");
      if (peek.studentUserId !== null) await lockUser(tx, peek.studentUserId);
      const [link] = await lockLinks(tx, [target.id]);
      if (!link || link.teacherUserId !== teacherUserId || link.studentUserId !== peek.studentUserId) {
        throw new MaterialsError("state_changed");
      }
      // Ученика убрали из списка, пока шёл запрос: после отвязки новые материалы не выдаются.
      if (link.status === "ended") throw new MaterialsError("state_changed");

      // Подборку не удалят и не изменят, пока копируются карточки.
      const [source] = await tx
        .select({ id: sourceCollections.id, title: sourceCollections.title })
        .from(sourceCollections)
        .where(and(eq(sourceCollections.id, collectionId), isNull(sourceCollections.deletedAt)))
        .for("share");
      if (!source) throw new MaterialsError("not_found");

      const { studentCollectionId, created } = await issueCollectionCopy(tx, { studentLinkId: link.id, sourceCollectionId: source.id });
      let outcome: IssueOutcome = "already_issued";
      if (created && link.status === "active" && link.studentUserId !== null) {
        const [cards] = await tx
          .select({ value: count() })
          .from(studentCards)
          .where(and(eq(studentCards.studentCollectionId, studentCollectionId), isNull(studentCards.deletedAt)));
        await enqueueNewCollection(tx, link.studentUserId, { id: studentCollectionId, title: source.title, wordCount: cards?.value ?? 0 });
        outcome = "now";
      } else if (created) {
        // Уведомление поставит подтверждение связи: linking/service.ts approveRequest.
        outcome = "after_connection";
      }
      return { studentId: link.id, displayName: link.displayName, outcome, copyId: studentCollectionId };
    });
  }
}

export type IssueService = ReturnType<typeof createIssueService>;
