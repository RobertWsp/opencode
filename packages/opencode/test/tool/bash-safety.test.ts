import { describe, expect, test } from "bun:test"
import { BashSafety } from "../../src/tool/bash-safety"

function classify(raw: string) {
  return BashSafety.classify(BashSafety.tokenize(raw), raw)
}

describe("BashSafety.classify — blocked", () => {
  test("git reset --hard", () => {
    const result = classify("git reset --hard HEAD")
    expect(result.level).toBe("blocked")
    expect(result.reason).toContain("uncommitted")
    expect(result.alternative).toContain("git stash")
  })

  test("git reset --hard without ref", () => {
    const result = classify("git reset --hard")
    expect(result.level).toBe("blocked")
  })

  test("git push --force to main", () => {
    const result = classify("git push --force origin main")
    expect(result.level).toBe("blocked")
    expect(result.reason).toContain("main/master")
  })

  test("git push --force to master", () => {
    const result = classify("git push --force origin master")
    expect(result.level).toBe("blocked")
  })

  test("git clean -fdx", () => {
    const result = classify("git clean -fdx")
    expect(result.level).toBe("blocked")
    expect(result.alternative).toContain("dry-run")
  })

  test("rm -rf /", () => {
    const result = classify("rm -rf /")
    expect(result.level).toBe("blocked")
  })

  test("rm -rf ~", () => {
    const result = classify("rm -rf ~")
    expect(result.level).toBe("blocked")
  })

  test("rm -rf with root wildcard", () => {
    const result = classify("rm -rf /*")
    expect(result.level).toBe("blocked")
  })

  test("dd writing to block device", () => {
    const result = classify("dd if=/dev/zero of=/dev/sda bs=1M")
    expect(result.level).toBe("blocked")
  })

  test("mkfs command", () => {
    const result = classify("mkfs.ext4 /dev/sda1")
    expect(result.level).toBe("blocked")
  })

  test("redirect to block device", () => {
    const raw = "echo something > /dev/sda"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("blocked")
  })

  test("chmod -R 777 on root", () => {
    const result = classify("chmod -R 777 /")
    expect(result.level).toBe("blocked")
  })

  test("fork bomb", () => {
    const raw = ":(){ :|:& };:"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("blocked")
  })
})

describe("BashSafety.classify — danger", () => {
  test("rm -rf on project directory", () => {
    const result = classify("rm -rf ./node_modules")
    expect(result.level).toBe("danger")
    expect(result.reason).toContain("ecursive")
  })

  test("rm -r flag", () => {
    const result = classify("rm -r ./dist")
    expect(result.level).toBe("danger")
  })

  test("git push --force to feature branch", () => {
    const result = classify("git push --force origin feature/my-branch")
    expect(result.level).toBe("danger")
  })

  test("git push --force-with-lease", () => {
    const result = classify("git push --force-with-lease origin dev")
    expect(result.level).toBe("danger")
  })

  test("git push -f", () => {
    const result = classify("git push -f origin dev")
    expect(result.level).toBe("danger")
  })

  test("git clean without -x", () => {
    const result = classify("git clean -f")
    expect(result.level).toBe("danger")
  })

  test("git checkout -- discard", () => {
    const result = classify("git checkout -- src/file.ts")
    expect(result.level).toBe("danger")
  })

  test("git branch -D", () => {
    const result = classify("git branch -D feature/old")
    expect(result.level).toBe("danger")
  })

  test("git rebase", () => {
    const result = classify("git rebase main")
    expect(result.level).toBe("danger")
  })

  test("chmod", () => {
    const result = classify("chmod 755 script.sh")
    expect(result.level).toBe("danger")
  })

  test("chown", () => {
    const result = classify("chown root:root file.txt")
    expect(result.level).toBe("danger")
  })

  test("DROP TABLE", () => {
    const raw = "psql -c 'DROP TABLE users'"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("danger")
  })

  test("DELETE FROM without WHERE", () => {
    const raw = "mysql -e 'DELETE FROM users;'"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("danger")
  })

  test("TRUNCATE TABLE", () => {
    const raw = "psql -c 'TRUNCATE TABLE sessions'"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("danger")
  })

  test("npm publish", () => {
    const result = classify("npm publish")
    expect(result.level).toBe("danger")
  })

  test("cargo publish", () => {
    const result = classify("cargo publish")
    expect(result.level).toBe("danger")
  })

  test("git config --global", () => {
    const result = classify("git config --global user.name test")
    expect(result.level).toBe("danger")
  })
})

describe("BashSafety.classify — safe", () => {
  test("echo", () => {
    expect(classify("echo hello").level).toBe("safe")
  })

  test("ls", () => {
    expect(classify("ls -la").level).toBe("safe")
  })

  test("git status", () => {
    expect(classify("git status").level).toBe("safe")
  })

  test("git log", () => {
    expect(classify("git log --oneline -5").level).toBe("safe")
  })

  test("git diff", () => {
    expect(classify("git diff HEAD").level).toBe("safe")
  })

  test("git add", () => {
    expect(classify("git add .").level).toBe("safe")
  })

  test("git commit", () => {
    expect(classify("git commit -m 'fix: something'").level).toBe("safe")
  })

  test("git push (no force)", () => {
    expect(classify("git push origin dev").level).toBe("safe")
  })

  test("git stash", () => {
    expect(classify("git stash").level).toBe("safe")
  })

  test("git fetch", () => {
    expect(classify("git fetch origin").level).toBe("safe")
  })

  test("npm install", () => {
    expect(classify("npm install").level).toBe("safe")
  })

  test("bun test", () => {
    expect(classify("bun test").level).toBe("safe")
  })

  test("cat file", () => {
    expect(classify("cat package.json").level).toBe("safe")
  })

  test("mkdir", () => {
    expect(classify("mkdir -p src/components").level).toBe("safe")
  })

  test("rm single file (no recursive)", () => {
    expect(classify("rm temp.txt").level).toBe("safe")
  })

  test("touch", () => {
    expect(classify("touch new-file.ts").level).toBe("safe")
  })

  test("git reset --soft", () => {
    expect(classify("git reset --soft HEAD~1").level).toBe("safe")
  })

  test("git reset (mixed, no flag)", () => {
    expect(classify("git reset HEAD~1").level).toBe("safe")
  })

  test("DELETE FROM with WHERE", () => {
    const raw = "psql -c 'DELETE FROM users WHERE id = 1'"
    const result = BashSafety.classify(BashSafety.tokenize(raw), raw)
    expect(result.level).toBe("safe")
  })

  test("git clean -n (dry-run)", () => {
    expect(classify("git clean -n").level).toBe("safe")
  })
})

describe("BashSafety.tokenize", () => {
  test("simple command", () => {
    expect(BashSafety.tokenize("git status")).toEqual(["git", "status"])
  })

  test("command with flags", () => {
    expect(BashSafety.tokenize("rm -rf ./dist")).toEqual(["rm", "-rf", "./dist"])
  })

  test("command with quoted args", () => {
    expect(BashSafety.tokenize("git commit -m 'message'")).toEqual(["git", "commit", "-m", "message"])
  })

  test("empty string", () => {
    expect(BashSafety.tokenize("")).toEqual([])
  })

  test("multiple spaces", () => {
    expect(BashSafety.tokenize("git   status")).toEqual(["git", "status"])
  })
})

describe("BashSafety.classify — edge cases", () => {
  test("git clean -n is safe (dry-run only)", () => {
    const result = classify("git clean -n")
    expect(result.level).toBe("safe")
  })

  test("git push --force to non-main branch is danger not blocked", () => {
    const result = classify("git push --force origin feature/test")
    expect(result.level).toBe("danger")
    expect(result.level).not.toBe("blocked")
  })

  test("git branch -d (lowercase) is danger", () => {
    const result = classify("git branch -d old-branch")
    expect(result.level).toBe("danger")
  })

  test("rm without flags is safe", () => {
    expect(classify("rm file.txt").level).toBe("safe")
  })

  test("rm -f single file is safe (no recursive)", () => {
    expect(classify("rm -f temp.log").level).toBe("safe")
  })

  test("git revert is safe", () => {
    expect(classify("git revert abc123").level).toBe("safe")
  })

  test("npm publish --dry-run is still danger", () => {
    const result = classify("npm publish --dry-run")
    expect(result.level).toBe("danger")
  })
})
