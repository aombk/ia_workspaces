/**
 * What every platform's window driver has to answer, and nothing more.
 *
 * Three verbs — list everything, list one process's windows, do something to a
 * window — because that is the whole of what the feature above needs, and every
 * verb past the whole of what is needed is one more thing to port three times.
 *
 * A handle is an opaque string. On Windows it is an `HWND` in decimal, on X11 a
 * window id, and on macOS a made-up address of the form `pid:title`, since
 * nothing there hands out a durable window identifier without private API. The
 * only rule is that a driver understands its own handles and nothing else reads
 * inside them.
 */

/** One top-level window, as a driver reports it. */
export interface ForeignWindow {
  /** Opaque, and only meaningful to the driver that produced it. */
  hwnd: string
  pid: number
  title: string
  /** The program, as the system names it — `Projucer.exe`, `Projucer`. */
  executable: string
  visible: boolean
  minimized: boolean
}

/** Where a window should be put, in physical screen pixels. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export type WindowAction =
  | { hwnd: string; action: 'show' | 'hide' | 'minimize' | 'restore' }
  | ({ hwnd: string; action: 'place' } & ScreenRect)

export interface WindowDriver {
  /** Whether this machine can do it at all. Every menu is gated on this. */
  readonly supported: boolean
  /**
   * Why not, in one line, when it cannot. Shown to the user rather than
   * swallowed: "nothing happens and nobody says why" is the failure that costs
   * an afternoon, and on two of the three platforms the reason is something the
   * user can actually fix.
   */
  readonly reason: string
  /**
   * Whether `place` wants logical pixels rather than physical ones.
   *
   * macOS works in points and applies the display's backing scale itself, so
   * multiplying by it here would put a window at twice the offset on a Retina
   * screen. Windows and X11 want real pixels. One flag rather than a coordinate
   * type, because it changes one multiplication in one place.
   */
  readonly logicalPixels: boolean
  /** Every visible top-level window on the machine, for the attach picker. */
  listAll(): Promise<ForeignWindow[]>
  /** The windows belonging to these processes. */
  windowsOf(pids: readonly number[]): Promise<ForeignWindow[]>
  /** Runs a batch, and answers which handles it managed. */
  apply(actions: readonly WindowAction[]): Promise<string[]>
  dispose(): void
}

/** The driver used where none of the real ones apply. */
export class NoWindowDriver implements WindowDriver {
  readonly supported = false
  readonly logicalPixels = false
  constructor(readonly reason: string) {}
  async listAll(): Promise<ForeignWindow[]> {
    return []
  }
  async windowsOf(): Promise<ForeignWindow[]> {
    return []
  }
  async apply(): Promise<string[]> {
    return []
  }
  dispose(): void {}
}
