import { BleManager, type State, type Subscription } from "react-native-ble-plx"

// The HeyPocket PKT01 GATT map (pocket-libre PROTOCOL.md, firmware 1.8). Commands and
// MCU& replies share the meta characteristic (write without response + notify); the MP3
// byte stream arrives on the data characteristic while a transfer or recording is active.
const SERVICE = "001120a0-2233-4455-6677-889912345678"
const AUDIO = "001120a1-2233-4455-6677-889912345678"
const META = "001120a3-2233-4455-6677-889912345678"

const NAME_PREFIX = "PKT01_"

export class PocketDevice {
  private manager?: BleManager
  private subs: Subscription[] = []
  private disconnectWatcher?: Subscription
  private lineHandlers = new Set<(line: string) => void>()
  private audioHandlers = new Set<(bytes: Uint8Array) => void>()

  private constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  /** Every PKT01 recorder currently advertising. Names dedupe by peripheral id. */
  static async scan(timeoutMs = 12_000): Promise<{ id: string; name: string }[]> {
    const manager = new BleManager()
    let scanError: Error | undefined
    try {
      await poweredOn(manager)
      const found = new Map<string, string>()
      await manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
          scanError = error
          return
        }
        if (device?.name?.startsWith(NAME_PREFIX)) found.set(device.id, device.name)
      })
      await sleep(timeoutMs)
      if (scanError) throw scanError
      return [...found].map(([id, name]) => ({ id, name }))
    } finally {
      await manager.stopDeviceScan().catch(() => {})
      await manager.destroy().catch(() => {})
    }
  }

  static async connect(id: string, name: string, timeoutMs = 20_000): Promise<PocketDevice> {
    const manager = new BleManager()
    const device = new PocketDevice(id, name)
    device.manager = manager
    try {
      await poweredOn(manager)
      const peripheral = await withTimeout(manager.connectToDevice(id), timeoutMs, "timed out connecting to the recorder")
      await manager.discoverAllServicesAndCharacteristicsForDevice(id)
      device.subs = [
        manager.monitorCharacteristicForDevice(id, SERVICE, META, (error, characteristic) => {
          if (error || !characteristic?.value) return
          for (const line of decodeText(characteristic.value).split("\n")) if (line) device.emitLine(line)
        }),
        manager.monitorCharacteristicForDevice(id, SERVICE, AUDIO, (error, characteristic) => {
          if (error || !characteristic?.value) return
          const bytes = base64ToBytes(characteristic.value)
          for (const handler of device.audioHandlers) handler(bytes)
        }),
      ]
      // The device serves one connection at a time; anything else that grabs it mid-session
      // (the vendor app in the background) must surface as a dropped pull, not a hang.
      device.disconnectWatcher = peripheral.onDisconnected((error) => {
        if (error) device.emitLine(`MCU&DISCONNECT&${error.errorCode}`)
      })
      return device
    } catch (error) {
      await device.close().catch(() => {})
      throw error
    }
  }

  /** Write an APP& command; the meta characteristic takes writes without response. */
  async command(text: string) {
    if (!this.manager) throw new Error(`${this.name}: connection closed`)
    await this.manager.writeCharacteristicWithoutResponseForDevice(this.id, SERVICE, META, btoa(text))
  }

  onLine(handler: (line: string) => void) {
    this.lineHandlers.add(handler)
    return () => this.lineHandlers.delete(handler)
  }

  onAudio(handler: (bytes: Uint8Array) => void) {
    this.audioHandlers.add(handler)
    return () => this.audioHandlers.delete(handler)
  }

  private emitLine(line: string) {
    for (const handler of this.lineHandlers) handler(line)
  }

  async close() {
    for (const sub of this.subs) sub.remove()
    this.subs = []
    this.disconnectWatcher?.remove()
    this.disconnectWatcher = undefined
    await this.manager?.cancelDeviceConnection(this.id).catch(() => {})
    await this.manager?.destroy().catch(() => {})
    this.manager = undefined
  }
}

// iOS reports Bluetooth state changes asynchronously and the system permission prompt lands
// in there; scanning anything before PoweredOn fails silently on some firmware builds.
function poweredOn(manager: BleManager) {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      // The current state can be emitted synchronously, before the subscription handle exists.
      let sub: Subscription | undefined
      const settled = (fn: () => void) => {
        sub?.remove()
        fn()
      }
      sub = manager.onStateChange((state: State) => {
        if (state === "PoweredOn") settled(resolve)
        if (state === "Unsupported" || state === "Unauthorized")
          settled(() => reject(new Error(`Bluetooth unavailable (${state}) — enable it for OpenCode Mobile`)))
        if (state === "PoweredOff") settled(() => reject(new Error("Bluetooth is off — turn it on")))
      }, true)
    }),
    10_000,
    "Bluetooth state never came up — check the Bluetooth toggle",
  )
}

// No Buffer polyfill on Hermes; atob (bundled with RN) plus TextDecoder covers both payloads.
function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeText(base64: string) {
  const text = new TextDecoder().decode(base64ToBytes(base64))
  return text.replace(/\0/g, "").replace(/[\r\n]+$/, "")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
