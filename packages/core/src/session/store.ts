export * as SessionStore from "./store.js"

import { and, asc, desc, eq, gt, isNotNull, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { Workspace } from "@opencode/schema/workspace"
import { AbsolutePath, PositiveInt, RelativePath } from "@opencode/schema/schema"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionHistory } from "./history.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { Session } from "@opencode/schema/session"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { fromRow } from "./info.js"

const ListInputBase = {
  workspaceID: Workspace.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  parentID: Schema.NullOr(Session.ID).pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
  /** Undefined omits temporary sessions entirely; true lists only temporary sessions. */
  temporary: Schema.Boolean.pipe(Schema.optional),
  anchor: Session.ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

export type MessagesInput = {
  sessionID: Session.ID
  limit?: number
  order?: "asc" | "desc"
  type?: SessionMessage.Type
  cursor?: {
    id: SessionMessage.ID
    direction: "previous" | "next"
  }
}

export interface Interface {
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  readonly list: (input?: ListInput) => Effect.Effect<Session.Info[]>
  readonly messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /** {@link Interface.messages} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
  readonly messagesWithRefs: (input: MessagesInput) => Effect.Effect<SessionMessage.MediaInfo[], MessageDecodeError>
  /** {@link Interface.message} for clients that fetch media themselves. */
  readonly messageWithRefs: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.MediaInfo } | undefined>
  /**
   * Top-level Sessions holding an execution claim. Recoverable background
   * children are resumed separately through their durable Job records.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * {@link Interface.listSuspended} with each claim's attribution: the boot id
   * (and advertised wake URL, when known) of the server that acquired the claim.
   */
  readonly listSuspendedClaims: () => Effect.Effect<
    ReadonlyArray<{ readonly sessionID: Session.ID; readonly owner?: string; readonly url?: string }>
  >
  /**
   * Records the execution claim: the durable write-ahead intent that a turn is
   * (or was) in flight. Set when execution starts; a claim that survives to the
   * next boot marks a turn that never completed — its process crashed or shut
   * down mid-turn. On the unclaimed→claimed transition the fence increments and
   * the acquiring server's attribution is stamped (cleared when the acquirer
   * has no identity).
   */
  readonly claim: (sessionID: Session.ID, owner?: { readonly id: string; readonly url?: string }) => Effect.Effect<void>
  /**
   * Fenced takeover of another server's active claim: stamps new attribution and
   * increments the fence only while the claim is held (and, when `expectID` is
   * given, still by the observed owner). Returns whether the claim was seized.
   */
  readonly seize: (
    sessionID: Session.ID,
    owner: { readonly id: string; readonly url?: string },
    expectID?: string,
  ) => Effect.Effect<boolean>
  /** Current claim attribution of a Session; undefined when the row is gone. The fence never resets. */
  readonly attribution: (
    sessionID: Session.ID,
  ) => Effect.Effect<{ readonly owner?: string; readonly url?: string; readonly fence: number } | undefined>
  /**
   * Releases the claim and resets resume accounting. Terminal events call this
   * on commit; a `guardID` restricts the release to rows still attributed to
   * that boot, so a server whose ownership was fenced away mid-turn cannot clear
   * the new owner's claim.
   */
  readonly release: (sessionID: Session.ID, guardID?: string) => Effect.Effect<void>
  /**
   * Clears orphaned child claims except children owned by recoverable
   * background subagent jobs.
   */
  readonly releaseChildClaims: (recoverable: ReadonlyArray<Session.ID>) => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID) => Effect.Effect<number | undefined>
  /**
   * Temporary Sessions eligible for garbage collection: terminal-idle ones
   * whose idle moment predates `cutoff`, plus ones that never reached a
   * terminal transition and hold no execution claim.
   */
  readonly listExpiredTemporary: (cutoff: number) => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Boot-only: clears execution claims left on temporary Sessions by a
   * crashed turn so reclamation sweeps them instead of resuming disposable
   * work.
   */
  readonly releaseTemporaryClaims: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    /** One page of a session's message rows, oldest first within the page when paging backwards. */
    const messageRows = Effect.fnUntraced(function* (input: MessagesInput) {
      const direction = input.cursor?.direction ?? "next"
      const requestedOrder = input.order ?? "desc"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const anchor = input.cursor
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      if (input.cursor && !anchor) return []
      const boundary = anchor
        ? order === "asc"
          ? gt(SessionMessageTable.seq, anchor.seq)
          : lt(SessionMessageTable.seq, anchor.seq)
        : undefined
      const query = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            boundary,
            input.type === undefined ? undefined : eq(SessionMessageTable.type, input.type),
          ),
        )
        .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
      const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
      return direction === "previous" ? rows.toReversed() : rows
    })

    const messageRow = (messageID: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie)

    return Service.of({
      get: Effect.fnUntraced(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      list: Effect.fn("SessionStore.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if ("project" in input && input.subpath !== undefined) conditions.push(eq(SessionTable.path, input.subpath))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        if (input.archived !== undefined)
          conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
        // Temporary sessions are invisible to ordinary listings; only an
        // explicit temporary:true query surfaces them.
        conditions.push(eq(SessionTable.temporary, input.temporary === true))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("SessionStore.messages")(function* (input) {
        return yield* SessionHistory.decodeMessageRows(db, yield* messageRows(input))
      }),
      messagesWithRefs: Effect.fn("SessionStore.messagesWithRefs")(function* (input) {
        return yield* SessionHistory.decodeMessageRowsWithRefs(db, yield* messageRows(input))
      }),
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      messageWithRefs: Effect.fn("SessionStore.messageWithRefs")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRowsWithRefs(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(and(isNotNull(SessionTable.time_suspended), isNull(SessionTable.parent_id)))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      listSuspendedClaims: Effect.fn("SessionStore.listSuspendedClaims")(function* () {
        return yield* db
          .select({
            sessionID: SessionTable.id,
            owner: SessionTable.execution_owner,
            url: SessionTable.execution_url,
          })
          .from(SessionTable)
          .where(and(isNotNull(SessionTable.time_suspended), isNull(SessionTable.parent_id)))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map((row) => ({
                sessionID: row.sessionID,
                ...(row.owner === null ? {} : { owner: row.owner }),
                ...(row.url === null ? {} : { url: row.url }),
              })),
            ),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID, owner) {
        // The null guard makes re-claiming a still-claimed Session a zero-row
        // no-op (a resumed turn re-claims through the same started hook).
        // Claim bookkeeping never counts as user activity: time_updated is
        // pinned so session ordering only moves on real changes.
        yield* db
          .update(SessionTable)
          .set({
            time_suspended: Date.now(),
            execution_owner: owner?.id ?? null,
            execution_url: owner?.url ?? null,
            execution_fence: sql`${SessionTable.execution_fence} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
      }),
      seize: Effect.fn("SessionStore.seize")(function* (sessionID, owner, expectID) {
        // Takeover only converts an already-held claim; an idle Session is
        // acquired through the ordinary started-hook claim instead. RETURNING
        // reports whether this statement won the race against a concurrent
        // release or a competing seize.
        const row = yield* db
          .update(SessionTable)
          .set({
            execution_owner: owner.id,
            execution_url: owner.url ?? null,
            execution_fence: sql`${SessionTable.execution_fence} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              eq(SessionTable.id, sessionID),
              isNotNull(SessionTable.time_suspended),
              expectID === undefined ? undefined : eq(SessionTable.execution_owner, expectID),
            ),
          )
          .returning({ fence: SessionTable.execution_fence })
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      attribution: Effect.fn("SessionStore.attribution")(function* (sessionID) {
        const row = yield* db
          .select({ owner: SessionTable.execution_owner, url: SessionTable.execution_url, fence: SessionTable.execution_fence })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return undefined
        return {
          ...(row.owner === null ? {} : { owner: row.owner }),
          ...(row.url === null ? {} : { url: row.url }),
          fence: row.fence,
        }
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID, guardID) {
        yield* db
          .update(SessionTable)
          .set({
            time_suspended: null,
            resume_attempts: 0,
            execution_owner: null,
            execution_url: null,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              eq(SessionTable.id, sessionID),
              guardID === undefined
                ? undefined
                : or(isNull(SessionTable.execution_owner), eq(SessionTable.execution_owner, guardID)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      releaseChildClaims: Effect.fn("SessionStore.releaseChildClaims")((recoverable) =>
        db
          .update(SessionTable)
          .set({
            time_suspended: null,
            resume_attempts: 0,
            execution_owner: null,
            execution_url: null,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              isNotNull(SessionTable.parent_id),
              recoverable.length > 0 ? notInArray(SessionTable.id, Array.from(recoverable)) : undefined,
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      ),
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID) {
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(eq(SessionTable.id, sessionID))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        return row?.attempts
      }),
      listExpiredTemporary: Effect.fn("SessionStore.listExpiredTemporary")(function* (cutoff) {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.temporary, true),
              or(
                and(isNull(SessionTable.time_idle), isNull(SessionTable.time_suspended)),
                and(isNotNull(SessionTable.time_idle), lt(SessionTable.time_idle, cutoff)),
              ),
            ),
          )
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      releaseTemporaryClaims: Effect.suspend(() =>
        db
          .update(SessionTable)
          .set({
            time_suspended: null,
            resume_attempts: 0,
            execution_owner: null,
            execution_url: null,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(and(eq(SessionTable.temporary, true), isNotNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie),
      ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
