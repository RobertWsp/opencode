import { describe, it, expect } from "bun:test"
import { KEYWORDS, expand } from "./signals"
import { rank } from "../tool/skill-rank"
import type { Skill } from "../skill"

const stub = (name: string, desc: string): Skill.Info => ({
  name,
  description: desc,
  location: `/mock/${name}`,
  content: "",
})

describe("KEYWORDS", () => {
  it("maps package.json to node/js keywords", () => {
    expect(KEYWORDS["package.json"]).toContain("node")
    expect(KEYWORDS["package.json"]).toContain("javascript")
    expect(KEYWORDS["package.json"]).toContain("typescript")
  })

  it("maps pyproject.toml to python keywords", () => {
    expect(KEYWORDS["pyproject.toml"]).toContain("python")
    expect(KEYWORDS["pyproject.toml"]).toContain("pip")
  })

  it("maps Cargo.toml to rust keywords", () => {
    expect(KEYWORDS["Cargo.toml"]).toContain("rust")
  })

  it("maps go.mod to go keywords", () => {
    expect(KEYWORDS["go.mod"]).toContain("go")
    expect(KEYWORDS["go.mod"]).toContain("golang")
  })

  it("maps Dockerfile to docker keywords", () => {
    expect(KEYWORDS["Dockerfile"]).toContain("docker")
    expect(KEYWORDS["Dockerfile"]).toContain("container")
  })

  it("maps pom.xml to java keywords", () => {
    expect(KEYWORDS["pom.xml"]).toContain("java")
  })

  it("maps .github to ci keywords", () => {
    expect(KEYWORDS[".github"]).toContain("github")
    expect(KEYWORDS[".github"]).toContain("ci")
  })

  it("maps Makefile to make keyword", () => {
    expect(KEYWORDS["Makefile"]).toContain("make")
  })

  it("has at least 8 signal mappings", () => {
    expect(Object.keys(KEYWORDS).length).toBeGreaterThanOrEqual(8)
  })
})

describe("expand", () => {
  it("expands package.json to node keywords", () => {
    const result = expand(["package.json"])
    expect(result).toContain("node")
    expect(result).toContain("typescript")
  })

  it("expands multiple signals", () => {
    const result = expand(["package.json", "Dockerfile"])
    expect(result).toContain("node")
    expect(result).toContain("docker")
  })

  it("returns empty for unknown signals", () => {
    expect(expand(["unknown.txt"])).toEqual([])
  })

  it("returns empty for empty input", () => {
    expect(expand([])).toEqual([])
  })
})

describe("signal-boosted ranking", () => {
  it("node signals boost node-related skills", () => {
    const skills = [stub("python-dev", "Python development tools"), stub("node-runner", "Node.js test runner")]
    const result = rank(skills, expand(["package.json"]))
    expect(result[0].skill.name).toBe("node-runner")
    expect(result[0].score).toBeGreaterThan(0)
  })

  it("python signals boost python-related skills", () => {
    const skills = [stub("node-runner", "Node.js test runner"), stub("python-dev", "Python development tools")]
    const result = rank(skills, expand(["pyproject.toml"]))
    expect(result[0].skill.name).toBe("python-dev")
    expect(result[0].score).toBeGreaterThan(0)
  })

  it("no signals keeps equal ranking (no crash)", () => {
    const skills = [stub("alpha", "First tool"), stub("beta", "Second tool")]
    const result = rank(skills, [])
    expect(result).toHaveLength(2)
    expect(result[0].score).toBe(0)
    expect(result[1].score).toBe(0)
  })

  it("undefined signals keeps equal ranking", () => {
    const skills = [stub("alpha", "First tool")]
    const result = rank(skills)
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0)
  })

  it("docker signals boost docker-related skills", () => {
    const skills = [stub("code-review", "Code review assistant"), stub("docker-deploy", "Docker container deployment")]
    const result = rank(skills, expand(["Dockerfile"]))
    expect(result[0].skill.name).toBe("docker-deploy")
  })

  it("combined signals and query boost scores additively", () => {
    const skills = [stub("playwright", "Browser automation"), stub("node-test", "Node.js testing")]
    const result = rank(skills, expand(["package.json"]), "node")
    const node = result.find((r) => r.skill.name === "node-test")!
    expect(node.score).toBeGreaterThanOrEqual(2)
  })

  it("github signals boost ci-related skills", () => {
    const skills = [stub("database-tool", "Database management"), stub("github-actions", "CI/CD with GitHub Actions")]
    const result = rank(skills, expand([".github"]))
    expect(result[0].skill.name).toBe("github-actions")
  })
})
