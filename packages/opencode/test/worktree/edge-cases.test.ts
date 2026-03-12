import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { Worktree } from "../../src/worktree"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

function fixture() {
  return tmpdir({
    git: true,
    dispose: async (dir) => {
      await $`git worktree prune`.cwd(dir).quiet().nothrow()
    },
  })
}

function ready(dir: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error(`timed out waiting for worktree.ready: ${dir}`))
    }, 3000)
    const on = (event: { directory?: string; payload?: { type?: string } }) => {
      if (event.directory !== dir) return
      if (event.payload?.type !== "worktree.ready") return
      clearTimeout(timeout)
      GlobalBus.off("event", on)
      resolve()
    }
    GlobalBus.on("event", on)
  })
}

describe("worktree edge cases", () => {
  test("hasUnpushedWork throws NotGitError for non-git projects", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(Worktree.hasUnpushedWork(tmp.path)).rejects.toBeInstanceOf(Worktree.NotGitError)
      },
    })
  })

  test("resolveDefaultBranch fails with guidance when no remote/default exists", async () => {
    await using tmp = await fixture()
    const global = process.env.GIT_CONFIG_GLOBAL
    const system = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    try {
      await expect(Worktree.resolveDefaultBranch(tmp.path)).rejects.toThrow(
        "Cannot detect default branch. Run: git remote set-head origin --auto",
      )
    } finally {
      if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      if (global !== undefined) process.env.GIT_CONFIG_GLOBAL = global
      if (system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      if (system !== undefined) process.env.GIT_CONFIG_NOSYSTEM = system
    }
  })

  test("resolveDefaultBranch resolves from remote HEAD", async () => {
    await using tmp = await fixture()
    const remote = path.join(tmp.path, "remote.git")
    await $`git init --bare ${remote}`.cwd(tmp.path).quiet()
    await $`git remote add origin ${remote}`.cwd(tmp.path).quiet()
    await $`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/dev`.cwd(tmp.path).quiet()

    const branch = await Worktree.resolveDefaultBranch(tmp.path)
    expect(branch).toBe("dev")
  })

  test("resolveDefaultBranch falls back to init.defaultBranch", async () => {
    await using tmp = await fixture()
    await $`git config init.defaultBranch main`.cwd(tmp.path).quiet()

    const branch = await Worktree.resolveDefaultBranch(tmp.path)
    expect(branch).toBe("main")
  })

  test("makeWorktreeInfo increments suffix when hinted name collides", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Worktree.makeWorktreeInfo("my-feature")
        const boot = await Worktree.createFromInfo(a)
        boot()
        await ready(a.directory)

        const b = await Worktree.makeWorktreeInfo("my-feature")
        expect(a.branch).toBe("opencode/my-feature")
        expect(b.branch).toBe("opencode/my-feature-2")

        await Worktree.remove({ directory: a.directory })
      },
    })
  })

  test("createFromInfo handles occupied path gracefully", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("occupied")
        await fs.mkdir(info.directory, { recursive: true })

        const next = await Worktree.makeWorktreeInfo("occupied")
        expect(next.name).toBe("occupied-2")

        const boot = await Worktree.createFromInfo(next)
        boot()
        await ready(next.directory)

        await Worktree.remove({ directory: next.directory })
        await fs.rm(info.directory, { recursive: true, force: true })
      },
    })
  })

  test("pruneOrphans removes workspace rows for deleted directories", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = Identifier.ascending("workspace")
        const dir = path.join(tmp.path, "missing-worktree")
        Database.use((db) => {
          db.insert(WorkspaceTable)
            .values({
              id,
              type: "worktree",
              branch: "opencode/missing",
              name: "missing",
              directory: dir,
              extra: null,
              project_id: Instance.project.id,
            })
            .run()
        })

        await Workspace.pruneOrphans(Instance.project)

        const got = await Workspace.get(id)
        expect(got).toBeUndefined()
      },
    })
  })

  test("pruneOrphans keeps workspace rows for existing directories", async () => {
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

        await Workspace.pruneOrphans(Instance.project)

        const got = await Workspace.get(ws.id)
        expect(got?.id).toBe(ws.id)

        await Workspace.remove(ws.id)
      },
    })
  })

  test("remove blocks uncommitted changes with WorkspaceDirtyError", async () => {
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

        const err = await Workspace.remove(ws.id).catch((err) => err)
        expect(err).toBeInstanceOf(Workspace.WorkspaceDirtyError)
        if (!(err instanceof Workspace.WorkspaceDirtyError)) throw err
        expect(err.uncommitted).toBeGreaterThan(0)

        await Workspace.remove(ws.id, { force: true })
      },
    })
  })

  test.skip("remove blocks unpushed commits with WorkspaceDirtyError (blocked by git log --not --remotes semantics)", () => {})

  test.skip("locked worktree is documented but requires manual git state manipulation", () => {})

  test("force remove succeeds for dirty worktrees", async () => {
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
        const gone = await Workspace.remove(ws.id, { force: true })
        expect(gone?.id).toBe(ws.id)
        expect(await Workspace.get(ws.id)).toBeUndefined()
      },
    })
  })

  test("very long title hint creates a valid branch", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("a".repeat(220))
        const boot = await Worktree.createFromInfo(info)
        boot()
        await ready(info.directory)

        expect(info.branch.startsWith("opencode/")).toBe(true)
        expect(info.branch.length).toBeLessThan(255)
        expect(info.branch.includes(" ")).toBe(false)

        await Worktree.remove({ directory: info.directory })
      },
    })
  })

  test("hasUnpushedWork reports clean worktree correctly", async () => {
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

        const got = await Worktree.hasUnpushedWork(ws.directory!)
        expect(got).toEqual({
          dirty: false,
          uncommitted: 0,
          unpushed: 0,
        })

        await Workspace.remove(ws.id)
      },
    })
  })

  test("worktree branch with no new commits has empty unpushed count", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("no-new-commits")
        const boot = await Worktree.createFromInfo(info)
        boot()
        await ready(info.directory)

        const got = await Worktree.hasUnpushedWork(info.directory)
        expect(got.unpushed).toBe(0)
        expect(got.dirty).toBe(false)

        await Worktree.remove({ directory: info.directory })
      },
    })
  })

  test("createFromInfo with nonexistent base branch throws clear error", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("bad-base")
        const err = await Worktree.createFromInfo(info, undefined, "nonexistent-branch-xyz").catch((err) => err)
        expect(err).toBeInstanceOf(Worktree.CreateFailedError)
        if (!(err instanceof Worktree.CreateFailedError)) throw err
        expect(err.message.length > 0).toBe(true)
      },
    })
  })

  test("resolveDefaultBranch handles missing remote HEAD gracefully", async () => {
    await using tmp = await fixture()
    const remote = path.join(tmp.path, "remote.git")
    await $`git init --bare ${remote}`.cwd(tmp.path).quiet()
    await $`git remote add origin ${remote}`.cwd(tmp.path).quiet()

    const global = process.env.GIT_CONFIG_GLOBAL
    const system = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = "/dev/null"
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    const err = await Worktree.resolveDefaultBranch(tmp.path).catch((err) => err)
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    if (global !== undefined) process.env.GIT_CONFIG_GLOBAL = global
    if (system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    if (system !== undefined) process.env.GIT_CONFIG_NOSYSTEM = system

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toBe("Cannot detect default branch. Run: git remote set-head origin --auto")
  })

  test("worktree creation works in path with spaces", async () => {
    await using tmp = await tmpdir<string>({
      init: async (dir) => {
        const target = path.join(dir, "repo with spaces")
        await fs.mkdir(target)
        await $`git init`.cwd(target).quiet()
        await $`git config core.fsmonitor false`.cwd(target).quiet()
        await $`git commit --allow-empty -m "root commit"`.cwd(target).quiet()
        return target
      },
      dispose: async (dir) => {
        const target = path.join(dir, "repo with spaces")
        await $`git worktree prune`.cwd(target).quiet().nothrow()
        return target
      },
    })

    await Instance.provide({
      directory: tmp.extra,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("space-path")
        const boot = await Worktree.createFromInfo(info)
        boot()
        await ready(info.directory)

        const ok = await fs
          .stat(info.directory)
          .then(() => true)
          .catch(() => false)
        expect(ok).toBe(true)

        await Worktree.remove({ directory: info.directory })
      },
    })
  })

  test("multiple sessions can share one workspace without duplicating workspaces", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const made = await Session.createWithWorktree({
          projectID: Instance.project.id,
          directory: tmp.path,
          title: "shared",
        })
        await ready(made.workspace.directory!)

        const a = await Session.createNext({
          directory: made.workspace.directory!,
          workspaceID: made.workspace.id,
          title: "a",
        })
        const b = await Session.createNext({
          directory: made.workspace.directory!,
          workspaceID: made.workspace.id,
          title: "b",
        })

        expect((await Session.get(a.id)).workspaceID).toBe(made.workspace.id)
        expect((await Session.get(b.id)).workspaceID).toBe(made.workspace.id)
        expect(Workspace.list(Instance.project).filter((x) => x.type === "worktree")).toHaveLength(1)

        await Session.remove(a.id)
        await Session.remove(b.id)
        await Session.remove(made.session.id)
      },
    })
  })

  test("concurrent sessions on same workspace do not duplicate workspaces", async () => {
    await using tmp = await fixture()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const made = await Session.createWithWorktree({
          projectID: Instance.project.id,
          directory: tmp.path,
          title: "shared-concurrent",
        })
        await ready(made.workspace.directory!)

        const created = await Promise.all([
          Session.createNext({
            directory: made.workspace.directory!,
            workspaceID: made.workspace.id,
            title: "c1",
          }),
          Session.createNext({
            directory: made.workspace.directory!,
            workspaceID: made.workspace.id,
            title: "c2",
          }),
        ])

        expect((await Session.get(created[0].id)).workspaceID).toBe(made.workspace.id)
        expect((await Session.get(created[1].id)).workspaceID).toBe(made.workspace.id)
        expect(Workspace.list(Instance.project).filter((x) => x.type === "worktree")).toHaveLength(1)

        await Session.remove(created[0].id)
        await Session.remove(created[1].id)
        await Session.remove(made.session.id)
      },
    })
  })

  test.skip("non-fast-forward push error is documented but requires remote setup", () => {})

  test.skip("disk full behavior is documented but not simulated in integration tests", () => {})

  test.skip("push auth failures are documented but not simulated in integration tests", () => {})

  test.skip("read-only filesystem behavior is documented but not simulated in integration tests", () => {})
})
