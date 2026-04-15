import { describe, expect, test } from "bun:test"
import {
  detectGitEvent,
  extractIssueRefs,
  splitCommand,
  toCaptureEvent,
} from "../../../src/plugin/obsidian-memory/git-event-detector"

describe("splitCommand", () => {
  test("splits on whitespace", () => {
    expect(splitCommand("git commit -m foo")).toEqual(["git", "commit", "-m", "foo"])
  })

  test("preserves double-quoted args", () => {
    expect(splitCommand('git commit -m "fix the bug"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix the bug",
    ])
  })

  test("preserves single-quoted args", () => {
    expect(splitCommand("git commit -m 'my message'")).toEqual([
      "git",
      "commit",
      "-m",
      "my message",
    ])
  })

  test("handles empty string", () => {
    expect(splitCommand("")).toEqual([])
  })

  test("collapses runs of whitespace", () => {
    expect(splitCommand("git    commit")).toEqual(["git", "commit"])
  })
})

describe("detectGitEvent", () => {
  test("returns null for non-git commands", () => {
    expect(detectGitEvent("ls -la")).toBeNull()
    expect(detectGitEvent("echo hello")).toBeNull()
    expect(detectGitEvent("cd /tmp")).toBeNull()
  })

  test("returns null for read-only git commands", () => {
    expect(detectGitEvent("git status")).toBeNull()
    expect(detectGitEvent("git log --oneline")).toBeNull()
    expect(detectGitEvent("git diff HEAD")).toBeNull()
    expect(detectGitEvent("git show abc123")).toBeNull()
    expect(detectGitEvent("git branch")).toBeNull()
  })

  test("detects checkout", () => {
    const ev = detectGitEvent("git checkout -b feature/foo")
    expect(ev).not.toBeNull()
    expect(ev!.subcommand).toBe("checkout")
    expect(ev!.summary).toContain("branch switched")
    expect(ev!.summary).toContain("feature/foo")
  })

  test("detects switch as branch change", () => {
    const ev = detectGitEvent("git switch main")
    expect(ev).not.toBeNull()
    expect(ev!.subcommand).toBe("switch")
  })

  test("detects commit", () => {
    const ev = detectGitEvent('git commit -m "add auth"')
    expect(ev).not.toBeNull()
    expect(ev!.subcommand).toBe("commit")
  })

  test("detects rebase", () => {
    const ev = detectGitEvent("git rebase main")
    expect(ev!.subcommand).toBe("rebase")
    expect(ev!.summary).toContain("main")
  })

  test("detects cherry-pick", () => {
    const ev = detectGitEvent("git cherry-pick abc123")
    expect(ev!.subcommand).toBe("cherry-pick")
  })

  test("detects revert", () => {
    const ev = detectGitEvent("git revert HEAD")
    expect(ev!.subcommand).toBe("revert")
  })

  test("detects push/pull/merge", () => {
    expect(detectGitEvent("git push origin main")!.subcommand).toBe("push")
    expect(detectGitEvent("git pull")!.subcommand).toBe("pull")
    expect(detectGitEvent("git merge feature")!.subcommand).toBe("merge")
  })

  test("detects worktree", () => {
    const ev = detectGitEvent("git worktree add ../wt main")
    expect(ev!.subcommand).toBe("worktree")
  })

  test("handles absolute git path", () => {
    const ev = detectGitEvent("/usr/bin/git commit -m foo")
    expect(ev).not.toBeNull()
    expect(ev!.subcommand).toBe("commit")
  })

  test("handles flags before subcommand", () => {
    const ev = detectGitEvent("git -C /some/path commit -m foo")
    expect(ev).not.toBeNull()
    expect(ev!.subcommand).toBe("commit")
  })

  test("sets memory-kind to episode", () => {
    const ev = detectGitEvent("git checkout -b x")
    expect(ev!.kind).toBe("episode")
  })

  test("includes stdout excerpt in summary when given", () => {
    const ev = detectGitEvent(
      "git checkout -b feature/x",
      "Switched to a new branch 'feature/x'",
    )
    expect(ev!.summary).toContain("Switched to")
  })

  test("detects merge command with kind merge", () => {
    const ev = detectGitEvent("git merge feature/foo")
    expect(ev!.subcommand).toBe("merge")
    expect(ev!.kind).toBe("merge")
  })

  test("detects revert command with kind revert and extracts reverted hash", () => {
    const ev = detectGitEvent("git revert abc1234")
    expect(ev!.subcommand).toBe("revert")
    expect(ev!.kind).toBe("revert")
    expect(ev!.hash).toBe("abc1234")
  })
})

describe("extractIssueRefs", () => {
  test("extracts PROJ-123 style refs", () => {
    const refs = extractIssueRefs("PROJ-123 fix auth bug")
    expect(refs).toContain("PROJ-123")
  })

  test("extracts bare #N refs", () => {
    const refs = extractIssueRefs("fix bug #456")
    expect(refs).toContain("#456")
  })

  test("extracts ref from fixes #N pattern", () => {
    const refs = extractIssueRefs("fixes #789 memory leak")
    expect(refs).toContain("#789")
  })

  test("returns empty array for messages without refs", () => {
    expect(extractIssueRefs("normal commit message")).toEqual([])
    expect(extractIssueRefs("")).toEqual([])
  })

  test("handles multiple refs in one message", () => {
    const refs = extractIssueRefs("PROJ-123 and fixes #456 also closes #789")
    expect(refs).toContain("PROJ-123")
    expect(refs).toContain("#456")
    expect(refs).toContain("#789")
    expect(refs).toHaveLength(3)
  })
})

describe("toCaptureEvent", () => {
  test("produces a valid CaptureEventInput", () => {
    const candidate = detectGitEvent("git checkout main")!
    const ev = toCaptureEvent(candidate, "ses_xyz")
    expect(ev.kind).toBe("tool.after")
    expect(ev.sessionID).toBe("ses_xyz")
    expect(ev.summary).toContain("git:checkout")
    expect(ev.details?.tool).toBe("git")
    expect(ev.details?.subcommand).toBe("checkout")
  })

  test("includes commit hash in details when stdout has hash", () => {
    const candidate = detectGitEvent("git commit -m fix", "[main abc1234] fix\n 1 file changed")!
    const ev = toCaptureEvent(candidate, "ses_1")
    expect(ev.details?.hash).toBe("abc1234")
  })

  test("marks revert events with kind revert in details", () => {
    const candidate = detectGitEvent("git revert abc1234")!
    const ev = toCaptureEvent(candidate, "ses_1")
    expect(ev.details?.kind).toBe("revert")
  })
})
