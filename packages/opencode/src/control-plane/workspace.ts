import z from "zod"
import * as fs from "fs/promises"
import { Identifier } from "@/id/id"
import { fn } from "@/util/fn"
import { Database, eq } from "@/storage/db"
import { Project } from "@/project/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { Worktree } from "@/worktree"
import { Config } from "@/config/config"
import { WorkspaceTable } from "./workspace.sql"
import { getAdaptor } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { parseSSE } from "./sse"

export namespace Workspace {
  export class WorkspaceDirtyError extends Error {
    readonly uncommitted: number
    readonly unpushed: number

    constructor(input: { uncommitted: number; unpushed: number }) {
      super("WorkspaceDirtyError")
      this.name = "WorkspaceDirtyError"
      this.uncommitted = input.uncommitted
      this.unpushed = input.unpushed
    }
  }

  export const Event = {
    Ready: BusEvent.define(
      "workspace.ready",
      z.object({
        name: z.string(),
      }),
    ),
    Failed: BusEvent.define(
      "workspace.failed",
      z.object({
        message: z.string(),
      }),
    ),
  }

  export const Info = WorkspaceInfo.meta({
    ref: "Workspace",
  })
  export type Info = z.infer<typeof Info>

  function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
    return {
      id: row.id,
      type: row.type,
      branch: row.branch,
      name: row.name,
      directory: row.directory,
      extra: row.extra,
      projectID: row.project_id,
    }
  }

  const CreateInput = z.object({
    id: Identifier.schema("workspace").optional(),
    type: Info.shape.type,
    branch: Info.shape.branch,
    projectID: Info.shape.projectID,
    extra: Info.shape.extra,
  })

  export const create = fn(CreateInput, async (input) => {
    const id = Identifier.ascending("workspace", input.id)

    if (input.type === "worktree") {
      const cfg = await Config.get()
      const max = cfg.worktree?.maxConcurrent ?? 8
      const existing = list({ id: input.projectID } as Project.Info).filter((x) => x.type === "worktree")
      if (existing.length >= max) {
        throw new Error(
          `Maximum concurrent worktrees reached (${existing.length}/${max}). Archive a worktree session to free a slot.`,
        )
      }
    }

    const adaptor = await getAdaptor(input.type)

    const config = await adaptor.configure({ ...input, id, name: null, directory: null })

    const info: Info = {
      id,
      type: config.type,
      branch: config.branch ?? null,
      name: config.name ?? null,
      directory: config.directory ?? null,
      extra: config.extra ?? null,
      projectID: input.projectID,
    }

    Database.use((db) => {
      db.insert(WorkspaceTable)
        .values({
          id: info.id,
          type: info.type,
          branch: info.branch,
          name: info.name,
          directory: info.directory,
          extra: info.extra,
          project_id: info.projectID,
        })
        .run()
    })

    await adaptor.create(config)
    return info
  })

  export function list(project: Project.Info) {
    const rows = Database.use((db) =>
      db.select().from(WorkspaceTable).where(eq(WorkspaceTable.project_id, project.id)).all(),
    )
    return rows.map(fromRow).sort((a, b) => a.id.localeCompare(b.id))
  }

  export const get = fn(Identifier.schema("workspace"), async (id) => {
    const row = Database.use((db) => db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())
    if (!row) return
    return fromRow(row)
  })

  export async function remove(id: string, opts?: { force?: boolean }) {
    const parsed = Identifier.schema("workspace").parse(id)
    const row = Database.use((db) => db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())
    if (row) {
      const info = fromRow(row)
      if (info.type === "worktree" && info.directory) {
        const dirty = await Worktree.hasUnpushedWork(info.directory)
        if (dirty.dirty && opts?.force !== true) {
          throw new WorkspaceDirtyError({
            uncommitted: dirty.uncommitted,
            unpushed: dirty.unpushed,
          })
        }
      }
      const adaptor = await getAdaptor(row.type)
      await adaptor.remove(info)
      Database.use((db) => db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, parsed)).run())
      return info
    }
  }

  export async function pruneOrphans(project: Project.Info) {
    const spaces = list(project).filter((x) => x.type === "worktree")
    await Promise.all(
      spaces.map(async (space) => {
        if (!space.directory) {
          Database.use((db) => db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, space.id)).run())
          return
        }
        const found = await fs
          .access(space.directory)
          .then(() => true)
          .catch(() => false)
        if (found) return
        Database.use((db) => db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, space.id)).run())
      }),
    )
  }
  const log = Log.create({ service: "workspace-sync" })

  async function workspaceEventLoop(space: Info, stop: AbortSignal) {
    while (!stop.aborted) {
      const adaptor = await getAdaptor(space.type)
      const res = await adaptor.fetch(space, "/event", { method: "GET", signal: stop }).catch(() => undefined)
      if (!res || !res.ok || !res.body) {
        await Bun.sleep(1000)
        continue
      }
      await parseSSE(res.body, stop, (event) => {
        GlobalBus.emit("event", {
          directory: space.id,
          payload: event,
        })
      })
      // Wait 250ms and retry if SSE connection fails
      await Bun.sleep(250)
    }
  }

  export function startSyncing(project: Project.Info) {
    void pruneOrphans(project).catch((error) => {
      log.warn("workspace orphan prune failed", {
        projectID: project.id,
        error,
      })
    })
    const stop = new AbortController()
    const spaces = list(project).filter((space) => space.type !== "worktree")

    spaces.forEach((space) => {
      void workspaceEventLoop(space, stop.signal).catch((error) => {
        log.warn("workspace sync listener failed", {
          workspaceID: space.id,
          error,
        })
      })
    })

    return {
      async stop() {
        stop.abort()
      },
    }
  }
}
