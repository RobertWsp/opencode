import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Workspace } from "../../src/control-plane/workspace"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

function fixture(cfg?: { max?: number }) {
  return tmpdir({
    git: true,
    config: cfg?.max
      ? {
          worktree: {
            maxConcurrent: cfg.max,
          },
        }
      : undefined,
    dispose: async (dir) => {
      await $`git worktree prune`.cwd(dir).quiet().nothrow()
    },
  })
}

function ready(dir: string) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error(`timed out waiting for worktree.ready: ${dir}`))
    }, 3000)
    const on = (event: { directory?: string; payload?: { type?: string } }) => {
      if (event.directory !== dir) return
      if (event.payload?.type !== "worktree.ready") return
      clearTimeout(t)
      GlobalBus.off("event", on)
      resolve()
    }
    GlobalBus.on("event", on)
  })
}

describe("session + workspace worktree integration", () => {
  test("creates a worktree workspace with branch and git registration", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ws = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        await ready(ws.directory!)

        expect(ws.directory).toBeTruthy()
        expect(ws.branch).toStartWith("opencode/")
        await fs.stat(ws.directory!)

        const list = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
        expect(list).toContain(`worktree ${ws.directory}`)
        expect(list).toContain(`branch refs/heads/${ws.branch}`)

        await Workspace.remove(ws.id, { force: true })
      },
    })
  })

  test("creates a session bound to the created workspace", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const made = await Session.createWithWorktree({
          projectID: Instance.project.id,
          directory: tmp.path,
        })
        expect(made.workspace.directory).toBeTruthy()
        await ready(made.workspace.directory!)

        expect(made.session.workspaceID).toBe(made.workspace.id)
        expect(made.session.directory).toBe(made.workspace.directory!)

        const got = await Session.get(made.session.id)
        expect(got.workspaceID).toBe(made.workspace.id)
        expect(got.directory).toBe(made.workspace.directory!)

        await Session.remove(made.session.id)
        const left = await Workspace.get(made.workspace.id)
        expect(left).toBeUndefined()
      },
    })
  })

  test("fork keeps workspace id and directory", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const made = await Session.createWithWorktree({
          projectID: Instance.project.id,
          directory: tmp.path,
        })
        await ready(made.workspace.directory!)
        const child = await Session.fork({ sessionID: made.session.id })

        expect(child.workspaceID).toBe(made.session.workspaceID)
        expect(child.directory).toBe(made.session.directory)

        await Session.remove(child.id)
        await Session.remove(made.session.id)
        const left = await Workspace.get(made.workspace.id)
        expect(left).toBeUndefined()
      },
    })
  })

  test("file writes stay in worktree and do not touch main repo", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ws = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        await ready(ws.directory!)

        const file = "worktree-only.txt"
        await Bun.write(path.join(ws.directory!, file), "isolated\n")

        const inWs = await fs
          .stat(path.join(ws.directory!, file))
          .then(() => true)
          .catch(() => false)
        const inRoot = await fs
          .stat(path.join(tmp.path, file))
          .then(() => true)
          .catch(() => false)

        expect(inWs).toBe(true)
        expect(inRoot).toBe(false)

        await Workspace.remove(ws.id, { force: true })
      },
    })
  })

  test("removes clean worktree workspace without force", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ws = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        await ready(ws.directory!)

        const gone = await Workspace.remove(ws.id)
        expect(gone?.id).toBe(ws.id)

        const left = await Workspace.get(ws.id)
        expect(left).toBeUndefined()
      },
    })
  })

  test("blocks dirty worktree removal unless forced", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ws = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        await ready(ws.directory!)

        await Bun.write(path.join(ws.directory!, "dirty.txt"), "dirty\n")

        await expect(Workspace.remove(ws.id)).rejects.toBeInstanceOf(Workspace.WorkspaceDirtyError)

        const gone = await Workspace.remove(ws.id, { force: true })
        expect(gone?.id).toBe(ws.id)
        const left = await Workspace.get(ws.id)
        expect(left).toBeUndefined()
      },
    })
  })

  test("keeps workspace while multiple sessions share it", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const made = await Session.createWithWorktree({
          projectID: Instance.project.id,
          directory: tmp.path,
        })
        await ready(made.workspace.directory!)

        const ws = made.workspace
        const sess = await Session.createNext({
          directory: ws.directory!,
          workspaceID: ws.id,
          title: "sibling",
        })

        await Session.remove(made.session.id)
        const still = await Workspace.get(ws.id)
        expect(still?.id).toBe(ws.id)

        await Session.remove(sess.id)
        const left = await Workspace.get(ws.id)
        expect(left).toBeUndefined()
      },
    })
  })

  test("enforces max concurrent worktree cap", async () => {
    await using tmp = await fixture({ max: 2 })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        const b = await Workspace.create({
          type: "worktree",
          projectID: Instance.project.id,
          branch: null,
          extra: null,
        })
        await ready(a.directory!)
        await ready(b.directory!)

        await expect(
          Workspace.create({
            type: "worktree",
            projectID: Instance.project.id,
            branch: null,
            extra: null,
          }),
        ).rejects.toThrow("Maximum concurrent worktrees reached (2/2). Archive a worktree session to free a slot.")

        await Workspace.remove(a.id, { force: true })
        await Workspace.remove(b.id, { force: true })
      },
    })
  })
})
