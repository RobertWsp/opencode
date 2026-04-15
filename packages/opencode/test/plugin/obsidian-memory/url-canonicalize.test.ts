import { describe, expect, test } from "bun:test"
import {
  canonicalizeLocal,
  canonicalizeRemote,
  deriveBasename,
} from "../../../src/plugin/obsidian-memory/scope"

describe("canonicalizeRemote", () => {
  test("scp-like SSH form", () => {
    expect(canonicalizeRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo")
    expect(canonicalizeRemote("git@github.com:owner/repo")).toBe("github.com/owner/repo")
  })

  test("HTTPS form", () => {
    expect(canonicalizeRemote("https://github.com/owner/repo.git")).toBe("github.com/owner/repo")
    expect(canonicalizeRemote("https://github.com/owner/repo")).toBe("github.com/owner/repo")
  })

  test("HTTPS with credentials", () => {
    expect(canonicalizeRemote("https://user@github.com/owner/repo.git")).toBe(
      "github.com/owner/repo",
    )
    expect(canonicalizeRemote("https://user:token@github.com/owner/repo.git")).toBe(
      "github.com/owner/repo",
    )
  })

  test("ssh:// scheme", () => {
    expect(canonicalizeRemote("ssh://git@github.com/owner/repo.git")).toBe(
      "github.com/owner/repo",
    )
    expect(canonicalizeRemote("ssh://git@github.com:22/owner/repo.git")).toBe(
      "github.com/owner/repo",
    )
  })

  test("self-hosted gitlab variants", () => {
    expect(canonicalizeRemote("git@gitlab.internal.example.com:team/proj.git")).toBe(
      "gitlab.internal.example.com/team/proj",
    )
    expect(canonicalizeRemote("https://gitlab.internal.example.com/team/proj.git")).toBe(
      "gitlab.internal.example.com/team/proj",
    )
  })

  test("host is lowercased", () => {
    expect(canonicalizeRemote("git@GitHub.Com:owner/repo.git")).toBe("github.com/owner/repo")
  })

  test("nested path (GitLab subgroup)", () => {
    expect(canonicalizeRemote("git@gitlab.com:group/subgroup/proj.git")).toBe(
      "gitlab.com/group/subgroup/proj",
    )
  })

  test("trailing slashes are stripped", () => {
    expect(canonicalizeRemote("https://github.com/owner/repo/")).toBe("github.com/owner/repo")
    expect(canonicalizeRemote("https://github.com/owner/repo.git/")).toBe(
      "github.com/owner/repo",
    )
  })

  test("empty input returns empty", () => {
    expect(canonicalizeRemote("")).toBe("")
    expect(canonicalizeRemote("   ")).toBe("")
  })

  test("all SSH/HTTPS variants converge to same canonical form", () => {
    const variants = [
      "git@github.com:owner/repo.git",
      "git@github.com:owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/",
      "https://user:token@github.com/owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "ssh://git@github.com:22/owner/repo.git",
    ]
    const canonicals = variants.map(canonicalizeRemote)
    const unique = new Set(canonicals)
    expect(unique.size).toBe(1)
    expect([...unique][0]).toBe("github.com/owner/repo")
  })
})

describe("canonicalizeLocal", () => {
  test("prefixes with local: marker", () => {
    expect(canonicalizeLocal("/tmp/foo")).toMatch(/^local:/)
  })

  test("empty input returns empty", () => {
    expect(canonicalizeLocal("")).toBe("")
  })

  test("resolves relative paths", () => {
    const result = canonicalizeLocal("/tmp/some/absolute")
    expect(result.startsWith("local:/")).toBe(true)
  })
})

describe("deriveBasename", () => {
  test("extracts last segment of canonical remote", () => {
    expect(deriveBasename("github.com/owner/repo")).toBe("repo")
    expect(deriveBasename("gitlab.com/group/subgroup/proj")).toBe("proj")
  })

  test("strips local: prefix", () => {
    expect(deriveBasename("local:/home/user/projects/myrepo")).toBe("myrepo")
  })

  test("slugifies special characters", () => {
    expect(deriveBasename("github.com/owner/My_Repo.Name")).toBe("my-repo-name")
  })

  test("falls back to 'repo' for empty input", () => {
    expect(deriveBasename("")).toBe("repo")
  })
})
