import { $ } from "bun"
import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import { existsSync } from "fs"
import { Filesystem } from "../../../../util/filesystem"

const isWSL = platform() === "linux" && /wsl|microsoft/i.test(release())

async function convertBmpToPng(bmpData: Buffer): Promise<Buffer | undefined> {
  const converter = Bun.which("ffmpeg") ? ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "image2pipe", "-c:v", "png", "pipe:1"]
    : Bun.which("magick") ? ["magick", "bmp:-", "png:-"]
    : Bun.which("convert") ? ["convert", "bmp:-", "png:-"]
    : undefined
  if (!converter) return undefined
  try {
    const proc = Bun.spawn(converter, { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    proc.stdin.write(bmpData)
    proc.stdin.end()
    const output = await new Response(proc.stdout).arrayBuffer()
    await proc.exited
    if (output.byteLength > 0) return Buffer.from(output)
  } catch {}
  return undefined
}

function wslgRuntimeDir(): string | undefined {
  if (!isWSL) return undefined
  const wslgDir = "/mnt/wslg/runtime-dir"
  if (existsSync(wslgDir + "/wayland-0")) return wslgDir
  return undefined
}

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export async function read(): Promise<Content | undefined> {
    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
      try {
        await $`osascript -e 'set imageData to the clipboard as "PNGf"' -e 'set fileRef to open for access POSIX file "${tmpfile}" with write permission' -e 'set eof fileRef to 0' -e 'write imageData to fileRef' -e 'close access fileRef'`
          .nothrow()
          .quiet()
        const buffer = await Filesystem.readBytes(tmpfile)
        return { data: buffer.toString("base64"), mime: "image/png" }
      } catch {
      } finally {
        await $`rm -f "${tmpfile}"`.nothrow().quiet()
      }
    }

    // PowerShell clipboard: only on native Windows (on WSL, processes can't access the Windows clipboard session)
    if (os === "win32") {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
      const base64 = await $`powershell.exe -NonInteractive -NoProfile -command "${script}"`.nothrow().text()
      if (base64) {
        const imageBuffer = Buffer.from(base64.trim(), "base64")
        if (imageBuffer.length > 0) {
          return { data: imageBuffer.toString("base64"), mime: "image/png" }
        }
      }
    }

    if (os === "linux") {
      const apiMimes = ["image/png", "image/jpeg", "image/webp", "image/gif"]
      const mimePriority = [...apiMimes, "image/bmp"]
      const wlPasteAvailable = process.env["WAYLAND_DISPLAY"] && Bun.which("wl-paste")
      if (wlPasteAvailable) {
        const runtimeDir = wslgRuntimeDir()
        const wlEnv = runtimeDir ? { ...process.env, XDG_RUNTIME_DIR: runtimeDir } : process.env
        const types = await $`wl-paste --list-types`.env(wlEnv).nothrow().quiet().text()
        if (types) {
          const available = types
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          for (const mime of mimePriority) {
            if (available.includes(mime)) {
              const data = await $`wl-paste -t ${mime}`.env(wlEnv).nothrow().quiet().arrayBuffer()
              if (data && data.byteLength > 0) {
                if (mime === "image/bmp") {
                  const converted = await convertBmpToPng(Buffer.from(data))
                  if (converted) return { data: converted.toString("base64"), mime: "image/png" }
                  continue
                }
                return { data: Buffer.from(data).toString("base64"), mime }
              }
            }
          }
        }
      } else if (Bun.which("xclip")) {
        const targets = await $`xclip -selection clipboard -t TARGETS -o`.nothrow().quiet().text()
        if (targets) {
          const available = targets
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          for (const mime of mimePriority) {
            if (available.includes(mime)) {
              const data = await $`xclip -selection clipboard -t ${mime} -o`.nothrow().quiet().arrayBuffer()
              if (data && data.byteLength > 0) {
                if (mime === "image/bmp") {
                  const converted = await convertBmpToPng(Buffer.from(data))
                  if (converted) return { data: converted.toString("base64"), mime: "image/png" }
                  continue
                }
                return { data: Buffer.from(data).toString("base64"), mime }
              }
            }
          }
        }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      return { data: text, mime: "text/plain" }
    }
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Bun.which("osascript")) {
      console.log("clipboard: using osascript")
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await $`osascript -e 'set the clipboard to "${escaped}"'`.nothrow().quiet()
      }
    }

    if (os === "linux") {
      if (process.env["WAYLAND_DISPLAY"] && Bun.which("wl-copy")) {
        console.log("clipboard: using wl-copy")
        const runtimeDir = wslgRuntimeDir()
        const env = runtimeDir ? { ...process.env, XDG_RUNTIME_DIR: runtimeDir } : undefined
        return async (text: string) => {
          const proc = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xclip")) {
        console.log("clipboard: using xclip")
        return async (text: string) => {
          const proc = Bun.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xsel")) {
        console.log("clipboard: using xsel")
        return async (text: string) => {
          const proc = Bun.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      console.log("clipboard: using powershell")
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Bun.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }

    console.log("clipboard: no native support")
    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    await getCopyMethod()(text)
  }
}
