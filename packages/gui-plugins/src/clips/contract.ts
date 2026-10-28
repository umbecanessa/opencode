import { Schema } from "effect"
import { Contract } from "@opencode/plugin/gui"

/** A file pinned to the clips tray. A clip is a live reference, not a copy: it follows the file and dies with it. */
export const Clip = Schema.Struct({
  /** The row's identity. */
  id: Schema.String,
  /** The host key (`ServerRef.id`) of the server that serves the file. */
  server: Schema.String,
  /** The workspace directory the file belongs to. */
  directory: Schema.String,
  /** The file's path, as the session that pinned it reported it. */
  path: Schema.String,
  /** When the clip was added, in epoch milliseconds. */
  time: Schema.Number,
})

/** A file pinned to the clips tray. */
export type Clip = Schema.Schema.Type<typeof Clip>

/** The tray's stored content. */
export const ClipList = Schema.Struct({
  /** The clips, newest first. */
  items: Schema.Array(Clip),
})

/** The tray's stored content. */
export type ClipList = Schema.Schema.Type<typeof ClipList>

/** The clips tray, provided by the clips plugin. */
export interface ClipsTray {
  /**
   * Pins a file to the tray, newest first. Pinning a file that is already clipped updates its position and time
   * instead of adding a second row. The tray holds a bounded list; the oldest clips past the cap drop off.
   *
   * @param clip - The file to pin: the server that serves it, its workspace directory, and its path.
   */
  add(clip: {
    /** The host key (`ServerRef.id`) of the server that serves the file. */
    readonly server: string
    /** The workspace directory the file belongs to. */
    readonly directory: string
    /** The file's path, as the session reporting it. */
    readonly path: string
  }): void
  /**
   * Removes a clip from the tray. Removing an id the tray does not list does nothing.
   *
   * @param id - The clip's id.
   */
  remove(id: string): void
}

/** The clips plugin provides this. */
export const ClipsTray = Contract.define<ClipsTray, "clips.tray">("clips.tray")
