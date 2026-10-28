export * as DesktopFiles from "./index"

import { execFile, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { BrowserWindow, clipboard, dialog, nativeImage, shell } from "electron"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import type { DirectoryPickerOptions, FilePickerOptions, SaveFilePickerOptions } from "../../shared/ipc-contract"
import { scoped } from "../native/logging"
import { nativeT } from "../native/translations"
import { assertAttachmentBudget, createPickedFileAuthorizations, readAttachment } from "./attachment-picker"
import { resolveExternalURL, resolveLocalFilePath } from "./external-url"

export type Interface = ReturnType<typeof make>

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopFiles") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return Service.of(make(fs, path))
  }),
)

function make(fs: FileSystem.FileSystem, path: Path.Path) {
  const pickedFiles = createPickedFileAuthorizations((file, maxBytes) =>
    readAttachment(file, maxBytes).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  )

  const saveDialog = Effect.fnUntraced(function* (defaultPath: string, format: "PDF" | "PNG" | "ZIP") {
    const result = yield* Effect.promise(() =>
      dialog.showSaveDialog({
        title: nativeT("desktop.dialog.saveFile"),
        defaultPath,
        filters: [{ name: format, extensions: [format.toLowerCase()] }],
      }),
    )

    if (result.canceled || !result.filePath) return null

    return result.filePath
  })

  // Renders artifact HTML in a hidden sandboxed window for export. The page loads from a temp
  // file: loadURL on a data: url caps out around 2MB, and artifacts with inline assets pass that.
  const renderPage = <A>(html: string, body: (window: BrowserWindow) => Effect.Effect<A>) =>
    Effect.gen(function* () {
      const source = path.join(tmpdir(), `opencode-artifact-${Date.now().toString(36)}.html`)
      yield* fs.writeFileString(source, html)

      try {
        const window = new BrowserWindow({
          show: false,
          width: 1280,
          height: 900,
          skipTaskbar: true,
          focusable: false,
          paintWhenInitiallyHidden: true,
          webPreferences: { sandbox: true, backgroundThrottling: false },
        })

        try {
          yield* Effect.promise(() => window.webContents.loadFile(source))
          // Webfont <link>s resolve after load; exports would otherwise capture fallback faces.
          yield* Effect.promise(() =>
            window.webContents.executeJavaScript("document.fonts.ready.then(() => true)").catch(() => true),
          )

          return yield* body(window)
        } finally {
          window.destroy()
        }
      } finally {
        yield* fs.remove(source).pipe(Effect.ignore)
      }
    })

  return {
    openDirectoryPicker: Effect.fn("DesktopFiles.openDirectoryPicker")(function* (options?: DirectoryPickerOptions) {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openDirectory", ...(options?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
          title: options?.title ?? nativeT("desktop.dialog.chooseFolder"),
          defaultPath: options?.defaultPath,
        }),
      )

      if (result.canceled) return null

      return options?.multiple ? result.filePaths : result.filePaths[0]
    }),
    openFilePicker: Effect.fn("DesktopFiles.openFilePicker")(function* (sender: number, options?: FilePickerOptions) {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openFile", ...(options?.multiple ? ["multiSelections" as const] : [])],
          title: options?.title ?? nativeT("desktop.dialog.chooseFile"),
          defaultPath: options?.defaultPath,
          filters: pickerFilters(options?.extensions),
        }),
      )

      if (result.canceled) return null

      const files = yield* Effect.forEach(
        result.filePaths,
        Effect.fnUntraced(function* (file) {
          const info = yield* fs.stat(file)

          return { path: file, name: path.basename(file), size: Number(info.size) }
        }),
        { concurrency: "unbounded" },
      )

      assertAttachmentBudget(files)

      return { token: pickedFiles.add(sender, result.filePaths), files }
    }),
    readPickedFile: pickedFiles.read,
    releasePickedFiles: pickedFiles.release,
    saveFile: Effect.fn("DesktopFiles.saveFile")(function* (options: SaveFilePickerOptions, content: string | Uint8Array) {
      const result = yield* Effect.promise(() =>
        dialog.showSaveDialog({
          title: options?.title ?? nativeT("desktop.dialog.saveFile"),
          defaultPath: options?.defaultPath,
        }),
      )

      if (result.canceled) return false

      if (!result.filePath) return false
      yield* fs.writeFile(result.filePath, content instanceof Uint8Array ? content : new TextEncoder().encode(content))

      return true
    }),
    printPdf: Effect.fn("DesktopFiles.printPdf")(function* (html: string, defaultPath: string) {
      const target = yield* saveDialog(defaultPath, "PDF")

      if (!target) return false

      const bytes = yield* renderPage(html, (window) =>
        Effect.promise(async () =>
          new Uint8Array(await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })),
        ),
      )

      yield* fs.writeFile(target, bytes)

      return true
    }),
    exportPng: Effect.fn("DesktopFiles.exportPng")(function* (
      html: string,
      defaultPath: string,
      width: number,
      height: number,
    ) {
      const target = yield* saveDialog(defaultPath, "PNG")

      if (!target) return false

      const bytes = yield* renderPage(html, (window) =>
        Effect.promise(async () => {
          // capturePage grabs the viewport only; grow it to the full document for a page-long shot.
          const pageHeight = await window.webContents.executeJavaScript(
            "Math.min(Math.max(document.documentElement.scrollHeight, 100), 16384)",
          )

          window.setContentSize(width, Math.round(pageHeight))

          await new Promise((resolve) => setTimeout(resolve, 150))

          return new Uint8Array((await window.webContents.capturePage()).toPNG())
        }),
      )

      yield* fs.writeFile(target, bytes)

      return true
    }),
    exportZip: Effect.fn("DesktopFiles.exportZip")(function* (html: string, defaultPath: string) {
      const target = yield* saveDialog(defaultPath, "ZIP")

      if (!target) return false

      const preview = yield* renderPage(html, (window) =>
        Effect.promise(async () => new Uint8Array((await window.webContents.capturePage()).toPNG())),
      )

      const bytes = yield* Effect.promise(async () => {
        const { BlobWriter, Uint8ArrayReader, ZipWriter } = await import("@zip.js/zip.js")
        const zip = new ZipWriter(new BlobWriter("application/zip"))
        await zip.add("index.html", new Uint8ArrayReader(new TextEncoder().encode(html)))
        await zip.add("preview.png", new Uint8ArrayReader(preview))
        const blob = await zip.close()

        return new Uint8Array(await blob.arrayBuffer())
      })

      yield* fs.writeFile(target, bytes)

      return true
    }),
    openPath: Effect.fn("DesktopFiles.openPath")(function* (target: string, application?: string) {
      if (!application) return yield* Effect.promise(() => shell.openPath(target))

      if (process.platform === "win32" && /^powershell(\.exe)?$/i.test(path.basename(application))) {
        const info = yield* fs.stat(target)
        const cwd = info.type === "Directory" ? target : path.dirname(target)

        // PowerShell takes its working directory rather than a path argument, and needs its own console window:
        // `start` opens one, and ignored stdio keeps the console from holding cmd's pipes open until PowerShell exits.
        return yield* Effect.tryPromise(() =>
          new Promise<void>((resolve, reject) => {
            spawn("cmd.exe", ["/d", "/c", "start", "", application, "-NoExit"], {
              cwd,
              stdio: "ignore",
              windowsHide: true,
            })
              .once("error", reject)
              .once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`start exited with code ${code}`))))
          }),
        )
      }

      yield* Effect.tryPromise(() =>
        new Promise<void>((resolve, reject) => {
          const command =
            process.platform === "darwin"
              ? { file: "open", arguments: ["-a", application, target] }
              : { file: application, arguments: [target] }

          execFile(command.file, command.arguments, (error) => (error ? reject(error) : resolve()))
        }),
      )
    }),
    revealPath: Effect.fn("DesktopFiles.revealPath")(function* (target: string) {
      const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))

      if (!exists) return false
      shell.showItemInFolder(target)

      return true
    }),
    readClipboardImage: Effect.fn("DesktopFiles.readClipboardImage")(function* () {
      const items = yield* Effect.promise(() => clipboard.read())

      const found = clipboardImageTypes
        .flatMap((mime) => items.filter((item) => item.types.includes(mime)).map((item) => ({ item, mime })))
        .at(0)

      if (!found) return null
      // getType() is typed as Blob | ClipboardBookmark; only the bookmark format yields the latter.
      const payload = yield* Effect.promise(async () => found.item.getType(found.mime))

      if (!(payload instanceof Blob)) return null
      const bytes = yield* Effect.promise(() => payload.arrayBuffer())
      // Re-encode through nativeImage so the renderer always receives PNG and the image dimensions.
      const image = nativeImage.createFromBuffer(Buffer.from(bytes))

      if (image.isEmpty()) return null
      const size = image.getSize()

      return { buffer: new Uint8Array(image.toPNG()), width: size.width, height: size.height }
    }),
    writeClipboardText: Effect.fn("DesktopFiles.writeClipboardText")(function* (text: string) {
      yield* Effect.promise(() => clipboard.writeText(text))
    }),
  }
}

// Chromium exposes copied bitmaps as image/png; JPEG only appears when an app placed one explicitly.
const clipboardImageTypes = ["image/png", "image/jpeg"]

export const openExternalURL = Effect.fn("DesktopFiles.openExternalURL")(function* (value: string) {
  const url = resolveExternalURL(value)

  if (!url) {
    yield* scoped("window", Effect.logWarning("blocked external target", { url: value }))

    return false
  }

  return yield* Effect.tryPromise(() => shell.openExternal(url)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      scoped("window", Effect.logError("failed to open external target", { url, error })).pipe(Effect.as(false)),
    ),
  )
})

export const openLocalFileURL = Effect.fn("DesktopFiles.openLocalFileURL")(function* (value: string) {
  const path = resolveLocalFilePath(value)

  if (!path) {
    yield* scoped("window", Effect.logWarning("blocked local file target", { url: value }))

    return
  }

  const error = yield* Effect.promise(() => shell.openPath(path))

  if (error) yield* scoped("window", Effect.logError("failed to open local file", { path, error }))
})

function pickerFilters(extensions?: string[]) {
  if (!extensions?.length) return undefined

  return [{ name: nativeT("desktop.dialog.files"), extensions }]
}
