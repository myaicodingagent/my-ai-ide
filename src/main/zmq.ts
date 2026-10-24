import { EventEmitter } from 'events'
import { Socket, connect as tcpConnect } from 'net'

// Just enough of ZeroMQ's wire protocol (ZMTP 3.0, no security) to be the client of a Jupyter kernel: DEALER sockets
// (shell, control, stdin) and a SUB socket (iopub), over TCP. Written here so the app needs no native module.

export type ZType = 'DEALER' | 'SUB'

const FLAG_MORE = 1
const FLAG_LONG = 2
const FLAG_COMMAND = 4

function greeting(): Buffer {
  const g = Buffer.alloc(64)
  g[0] = 0xff
  g[9] = 0x7f
  g[10] = 3 // version 3.0
  g[11] = 0
  g.write('NULL', 12, 'ascii') // the mechanism, padded with zeros to 20 bytes; the next byte (as-server) stays 0
  return g
}

function property(name: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), uint32(value.length), value])
}

function readyCommand(type: ZType, identity?: Buffer): Buffer {
  const name = Buffer.from('READY')
  const body = Buffer.concat([Buffer.from([name.length]), name, property('Socket-Type', Buffer.from(type)), ...(identity ? [property('Identity', identity)] : [])])
  return Buffer.concat([Buffer.from([FLAG_COMMAND, body.length]), body])
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function frame(body: Buffer, more: boolean): Buffer {
  const flags = (more ? FLAG_MORE : 0) | (body.length > 255 ? FLAG_LONG : 0)
  if (body.length <= 255) return Buffer.concat([Buffer.from([flags, body.length]), body])
  const len = Buffer.alloc(8)
  len.writeBigUInt64BE(BigInt(body.length))
  return Buffer.concat([Buffer.from([flags]), len, body])
}

export class ZSocket extends EventEmitter {
  private sock: Socket | null = null
  private buf = Buffer.alloc(0)
  private stage: 'greeting' | 'frames' = 'greeting'
  private parts: Buffer[] = []
  private ready = false
  private closed = false
  private onReady: (() => void) | null = null

  constructor(
    private readonly type: ZType,
    private readonly host: string,
    private readonly port: number,
    private readonly identity?: Buffer // a DEALER's name: the kernel addresses its answers on the stdin socket by the shell socket's
  ) {
    super()
  }

  /** Connects and completes the handshake; keeps trying while the kernel is still starting. Rejects after `timeoutMs`. */
  connect(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        if (this.closed) return reject(new Error('closed'))
        const sock = tcpConnect(this.port, this.host)
        this.sock = sock
        this.buf = Buffer.alloc(0)
        this.stage = 'greeting'
        this.parts = []
        this.ready = false
        let settled = false
        const retry = (): void => {
          if (settled) return
          settled = true
          sock.destroy()
          if (Date.now() > deadline) reject(new Error(`Could not connect to the kernel on port ${this.port}.`))
          else setTimeout(attempt, 150)
        }
        this.onReady = () => {
          if (settled) return
          settled = true
          resolve()
        }
        sock.setNoDelay(true)
        sock.on('connect', () => sock.write(greeting()))
        sock.on('data', (b) => this.feed(b))
        sock.on('error', () => {
          if (!this.ready) retry()
        })
        sock.on('close', () => {
          if (!this.ready) retry()
          else if (!this.closed) this.emit('close')
        })
      }
      attempt()
    })
  }

  private feed(b: Buffer): void {
    this.buf = Buffer.concat([this.buf, b])
    for (;;) {
      if (this.stage === 'greeting') {
        if (this.buf.length < 64) return
        if (this.buf[0] !== 0xff || this.buf[9] !== 0x7f || this.buf[10] < 3) {
          this.sock?.destroy()
          return
        }
        this.buf = this.buf.subarray(64)
        this.stage = 'frames'
        this.sock?.write(readyCommand(this.type, this.identity))
        continue
      }
      if (this.buf.length < 2) return
      const flags = this.buf[0]
      let size: number
      let head: number
      if (flags & FLAG_LONG) {
        if (this.buf.length < 9) return
        size = Number(this.buf.readBigUInt64BE(1))
        head = 9
      } else {
        size = this.buf[1]
        head = 2
      }
      if (this.buf.length < head + size) return
      const body = Buffer.from(this.buf.subarray(head, head + size))
      this.buf = this.buf.subarray(head + size)
      if (flags & FLAG_COMMAND) {
        const nameLen = body[0]
        const name = body.subarray(1, 1 + nameLen).toString('ascii')
        if (name === 'READY' && !this.ready) {
          this.ready = true
          // A subscriber says what it wants to hear: a message that starts with 1, then the prefix (empty = everything).
          if (this.type === 'SUB') this.sock?.write(frame(Buffer.from([1]), false))
          this.onReady?.()
        }
        continue
      }
      this.parts.push(body)
      if (!(flags & FLAG_MORE)) {
        const msg = this.parts
        this.parts = []
        this.emit('message', msg)
      }
    }
  }

  send(parts: Buffer[]): void {
    if (!this.sock || !this.ready) throw new Error('The kernel connection is not open.')
    this.sock.write(Buffer.concat(parts.map((p, i) => frame(p, i < parts.length - 1))))
  }

  close(): void {
    this.closed = true
    try {
      this.sock?.destroy()
    } catch {
      // already closed
    }
  }
}
