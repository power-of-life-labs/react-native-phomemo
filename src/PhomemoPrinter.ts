/**
 * Phomemo T02 client.
 *
 * The defining difference from the Niimbot driver: **nothing useful is
 * acknowledged.** The T02 does reply — `01 01` to every write — but it replies on
 * receipt, not on consumption, so there is nothing to correlate a page against
 * and nothing to throttle on. That has two uncomfortable consequences this class
 * exists to manage.
 *
 * 1. **We can outrun the printer and never know.** The transport gives
 *    link-level backpressure — `write()` resolves when the stack accepted the
 *    bytes — but says nothing about the printer's own buffer. BLE pushes tens of
 *    kB/s; a T02 head consumes about 2.4 kB/s. Overrun drops lines silently, and
 *    on solid artwork the only symptom is a shorter print. So writes are paced
 *    against the *measured* mechanical line rate with a leaky bucket.
 *
 *    This is not hypothetical: at the original estimate of 240 lines/s a 50 mm
 *    block printed 15–25 mm, varying between runs. The true rate is under 60.
 *
 * 2. **Finishing the last write is not finishing the print.** Several seconds of
 *    raster can still be draining from the printer's buffer. Resolving then
 *    closing truncates the label — and it looks exactly like dropped writes, so
 *    it is easy to misdiagnose. Hence the mandatory settle, and `close()`
 *    awaiting any job in flight.
 */

import { PrinterError } from 'react-native-thermal-ble';
import { hex } from 'react-native-thermal-ble';
import { toBitmap1, type Bitmap1, type SourceImage, type ToBitmapOptions } from 'react-native-thermal-ble';
import { chunk, delay as defaultDelay, type Transport } from 'react-native-thermal-ble';
import { escPosSegments, type EscPosEncodeOptions } from './encode';
import { feedDots, feedLines as feedLinesCommand, statusRequest } from './escpos';
import { T02, findPhomemoByName, type PhomemoModelMeta } from './models';

export interface PhomemoFlowControl {
  /**
   * How writes are throttled.
   *
   * - `'paced'` — leaky bucket against a measured mechanical line rate. The
   *   default, and on a T02 the only thing that works.
   * - `'ack'` — wait for the printer's per-write reply before writing again.
   *
   * **`'ack'` does not provide flow control on a T02, despite looking like it
   * should.** The printer answers `01 01` to every write, but it answers as soon
   * as the bytes are received rather than as they are consumed, so the gate opens
   * immediately and throttles nothing. Measured: a 400-line block that should be
   * 50 mm printed 15 mm ack-gated — indistinguishable from no throttling — versus
   * 49 mm when paced. Kept because the reply may mean something different on
   * another model, but do not reach for it expecting backpressure.
   */
  mode?: 'paced' | 'ack';
  /** How long to wait for a per-write reply in `'ack'` mode. Default 400 ms. */
  ackTimeoutMs?: number;
  /** Bytes per BLE write. Defaults to the link's limit, capped at 180. */
  writeSize?: number;
  /** Measured lines/s the head consumes. Default from the model. */
  linesPerSecond?: number;
  /**
   * Fraction of `linesPerSecond` actually used, as deliberate margin. Default 0.8.
   *
   * Without this the pacer runs at exactly the believed rate and has no headroom
   * at all, so any overestimate — or a printer that slows down when cold, low on
   * battery, or printing dense artwork — drops lines silently. Overrun is
   * unrecoverable and invisible; pacing slow merely prints slowly. The asymmetry
   * is the whole argument for spending 20% here.
   */
  safetyFactor?: number;
  /** Assumed printer buffer; how much head start to allow. Default from the model. */
  bufferBytes?: number;
  /** Extra delay after every write. Normally 0 — the pacer handles it. */
  minGapMs?: number;
  /** Injected clock, so the pacer is unit-testable without real time. */
  now?: () => number;
  /** Injected sleep, for the same reason. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PhomemoOpenOptions extends PhomemoFlowControl {
  /** Advertised BLE name — the only way to identify the model. */
  deviceName?: string | null;
  /** Force a model rather than inferring from the name. */
  model?: PhomemoModelMeta;
  /**
   * Ask for real-time status on connect (`DLE EOT`). Harmless if unsupported;
   * if the printer answers, it is the one route to true flow control.
   */
  probeStatus?: boolean;
  log?: (message: string) => void;
}

export interface PhomemoPrintProgress {
  phase: 'encoding' | 'sending' | 'settling' | 'done';
  bytesSent: number;
  bytesTotal: number;
  /** Host-side only. The printer never reports its own progress. */
  percent: number;
}

export interface PhomemoPrintOptions extends EscPosEncodeOptions {
  onProgress?: (p: PhomemoPrintProgress) => void;
  /**
   * Extra settle time beyond the computed drain estimate. Default 500 ms.
   * Raise it if long labels come out truncated.
   */
  settleMarginMs?: number;
  /** Print the same bitmap N times. The host re-sends; the printer cannot repeat. */
  copies?: number;
}

/** What this printer can and cannot do, stated rather than implied. */
export interface PhomemoCapabilities {
  dpi: number;
  printheadPixels: number;
  /** False: the host must re-send the raster per copy. */
  supportsCopies: boolean;
  /** False: no density command in the ESC/POS core. */
  supportsDensity: boolean;
  /** False: this is the one that matters — dropped output is undetectable. */
  acknowledgesPages: boolean;
  /** False: progress is bytes-sent by the host, not printer state. */
  reportsProgress: boolean;
}

export class PhomemoPrinter {
  readonly vendor = 'phomemo';
  readonly model: PhomemoModelMeta;
  readonly capabilities: PhomemoCapabilities;

  private readonly transport: Transport;
  private readonly log: (message: string) => void;
  private readonly flow: Required<
    Pick<
      PhomemoFlowControl,
      | 'linesPerSecond'
      | 'bufferBytes'
      | 'minGapMs'
      | 'mode'
      | 'ackTimeoutMs'
      | 'safetyFactor'
    >
  > & { writeSize: number; now: () => number; sleep: (ms: number) => Promise<void> };

  /** Everything seen on the notify characteristic, for empirical discovery. */
  readonly notifications: Uint8Array[] = [];
  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly offData: () => void;

  /** Leaky-bucket credit, in bytes. */
  private credit: number;
  private lastWriteAt: number;

  /** The job in flight, so `close()` can wait for it. */
  private inFlight: Promise<void> | null = null;
  private closed = false;

  private constructor(transport: Transport, model: PhomemoModelMeta, opts: PhomemoOpenOptions) {
    this.transport = transport;
    this.model = model;
    this.log = opts.log ?? (() => {});

    const writeSize = Math.max(20, Math.min(opts.writeSize ?? transport.maxWriteSize, 180));
    this.flow = {
      writeSize,
      linesPerSecond: opts.linesPerSecond ?? model.linesPerSecond,
      bufferBytes: opts.bufferBytes ?? model.bufferBytes,
      minGapMs: opts.minGapMs ?? 0,
      mode: opts.mode ?? 'paced',
      ackTimeoutMs: opts.ackTimeoutMs ?? 400,
      safetyFactor: Math.max(0.1, Math.min(1, opts.safetyFactor ?? 0.8)),
      now: opts.now ?? (() => Date.now()),
      sleep: opts.sleep ?? defaultDelay,
    };
    // The head start is discounted too: it is sent as fast as BLE allows, so
    // claiming the whole buffer assumes the buffer figure is exact.
    this.credit = this.flow.bufferBytes * this.flow.safetyFactor;
    this.lastWriteAt = this.flow.now();

    this.capabilities = {
      dpi: model.dpi,
      printheadPixels: model.printheadPixels,
      supportsCopies: false,
      supportsDensity: false,
      acknowledgesPages: false,
      reportsProgress: false,
    };

    // Record everything the printer volunteers. We do not yet know what it sends
    // — paper-out and cover-open are plausible — so capture first, interpret later.
    this.offData = transport.onData((bytes) => {
      this.notifications.push(bytes);
      // Log the CONTENT, not just the length: these bytes are undocumented, and
      // whether they are acknowledgements, buffer credit or status is exactly
      // what we are trying to find out.
      this.log(`<- notify ${hex(bytes)}`);
      for (const l of this.notifyListeners) l(bytes);
    });
  }

  static async open(
    transport: Transport,
    opts: PhomemoOpenOptions = {},
  ): Promise<PhomemoPrinter> {
    // There is no identify command, so the advertised name is the only signal.
    const model = opts.model ?? findPhomemoByName(opts.deviceName) ?? T02;
    const printer = new PhomemoPrinter(transport, model, opts);

    if (opts.probeStatus !== false) {
      // Spec-defined, but unknown whether this firmware answers. If it does, we
      // gain genuine flow control; if not, nothing is lost.
      try {
        await transport.write(statusRequest(1));
        await printer.flow.sleep(300);
        printer.log(
          printer.notifications.length > 0
            ? `status probe: printer answered (${printer.notifications.length} frame(s))`
            : 'status probe: no answer — printing stays fire-and-forget',
        );
      } catch {
        printer.log('status probe: write rejected; continuing');
      }
    }

    return printer;
  }

  /** Whether the printer replied to anything at all. Discovery aid. */
  get answeredStatus(): boolean {
    return this.notifications.length > 0;
  }

  onNotify(listener: (bytes: Uint8Array) => void): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  /**
   * Pace one write against the assumed mechanical line rate.
   *
   * Credit accrues at the head's consumption rate and is capped at the printer's
   * buffer, so a burst is allowed up to the buffer size and then throttled to the
   * drain rate — which is what a printer with no flow control needs.
   */
  private async send(bytes: Uint8Array): Promise<void> {
    return this.flow.mode === 'ack' ? this.ackGated(bytes) : this.paced(bytes);
  }

  /**
   * Write, then wait for the printer to say something before writing again.
   *
   * The T02 answers every write on its notify characteristic. Whatever that reply
   * formally means, using it as a gate makes the host follow the printer's actual
   * pace instead of a guessed constant — which is the failure that truncates a
   * print with no error anywhere.
   *
   * The listener is registered BEFORE the write: the reply can arrive while the
   * write promise is still settling, and a listener attached afterwards would miss
   * it and stall until the timeout on every single write.
   */
  private async ackGated(bytes: Uint8Array): Promise<void> {
    let acknowledge!: () => void;
    const replied = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const off = this.onNotify(() => acknowledge());
    try {
      await this.transport.write(bytes);
      // Timeout rather than hang: a firmware that does not reply must still print.
      await Promise.race([replied, this.flow.sleep(this.flow.ackTimeoutMs)]);
    } finally {
      off();
    }
    if (this.flow.minGapMs > 0) await this.flow.sleep(this.flow.minGapMs);
  }

  private async paced(bytes: Uint8Array): Promise<void> {
    const drainBytesPerSecond =
      this.flow.linesPerSecond * this.model.bytesPerLine * this.flow.safetyFactor;

    const accrue = () => {
      const now = this.flow.now();
      const elapsedSeconds = Math.max(0, (now - this.lastWriteAt) / 1000);
      this.credit = Math.min(
        this.flow.bufferBytes,
        this.credit + elapsedSeconds * drainBytesPerSecond,
      );
      this.lastWriteAt = now;
    };

    accrue();
    if (this.credit < bytes.length) {
      const deficit = bytes.length - this.credit;
      await this.flow.sleep(Math.ceil((deficit / drainBytesPerSecond) * 1000));
      accrue();
    }
    this.credit -= bytes.length;

    await this.transport.write(bytes);
    if (this.flow.minGapMs > 0) await this.flow.sleep(this.flow.minGapMs);
  }

  /** Print a packed bitmap. */
  async printBitmap(bitmap: Bitmap1, opts: PhomemoPrintOptions = {}): Promise<void> {
    if (this.closed) {
      throw new PrinterError('NOT_CONNECTED', 'Printer has been closed');
    }
    const job = this.run(bitmap, opts);
    this.inFlight = job;
    try {
      await job;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(bitmap: Bitmap1, opts: PhomemoPrintOptions): Promise<void> {
    const copies = Math.max(1, opts.copies ?? 1);
    const encodeOptions: EscPosEncodeOptions = {
      bytesPerLine: opts.bytesPerLine ?? this.model.bytesPerLine,
      maxBlockLines: opts.maxBlockLines ?? this.model.maxBlockLines,
      vendorFraming: opts.vendorFraming ?? this.model.vendorFraming,
      feedDots: opts.feedDots,
      fit: opts.fit,
    };

    const report = (phase: PhomemoPrintProgress['phase'], sent: number, total: number) =>
      opts.onProgress?.({
        phase,
        bytesSent: sent,
        bytesTotal: total,
        percent: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0,
      });

    // Raster size is content-independent, so the total is known up front.
    const bytesPerCopy =
      (opts.bytesPerLine ?? this.model.bytesPerLine) * bitmap.height + 64; // + framing
    const total = bytesPerCopy * copies;
    report('encoding', 0, total);

    let sent = 0;
    for (let copy = 0; copy < copies; copy++) {
      for (const segment of escPosSegments(bitmap, encodeOptions)) {
        for (const part of chunk(segment, this.flow.writeSize)) {
          await this.send(part);
          sent += part.length;
          report('sending', sent, total);
        }
      }
    }

    // The printer is still consuming its buffer. Resolving now — and especially
    // closing now — would truncate the label, and would look exactly like
    // dropped writes.
    const drainMs = (bitmap.height * copies) / this.flow.linesPerSecond * 1000;
    const settle = Math.ceil(drainMs + (opts.settleMarginMs ?? 500));
    this.log(`sent ${sent} bytes; settling ${settle} ms for the head to drain`);
    report('settling', sent, total);
    await this.flow.sleep(settle);

    report('done', total, total);
  }

  /** Convert pixels and print. */
  async printImage(
    image: SourceImage,
    opts: PhomemoPrintOptions & ToBitmapOptions = {},
  ): Promise<void> {
    return this.printBitmap(toBitmap1(image, opts), opts);
  }

  /** Print several bitmaps back to back within one connection. */
  async printBatch(bitmaps: readonly Bitmap1[], opts: PhomemoPrintOptions = {}): Promise<void> {
    for (const bitmap of bitmaps) await this.printBitmap(bitmap, opts);
  }

  /**
   * Advance the paper by n dots using `ESC J`.
   *
   * Note: a real T02 moved no paper for this command. Prefer {@link feedLines}
   * unless you are specifically comparing the two.
   */
  async feed(dots: number): Promise<void> {
    let remaining = Math.max(0, dots);
    while (remaining > 0) {
      const step = Math.min(255, remaining);
      await this.send(feedDots(step));
      remaining -= step;
    }
  }

  /** Advance the paper by n lines using `ESC d`, the documented Phomemo feed. */
  async feedLines(lines: number): Promise<void> {
    let remaining = Math.max(0, lines);
    while (remaining > 0) {
      const step = Math.min(255, remaining);
      await this.send(feedLinesCommand(step));
      remaining -= step;
    }
  }

  /** No status command is known to work, so this is honest about it. */
  async getStatus(): Promise<null> {
    return null;
  }

  /** Waits for any job in flight, so closing cannot truncate a print. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // The job's own caller sees the error; closing must still proceed.
      }
    }
    this.offData();
    this.notifyListeners.clear();
    await this.transport.close();
  }
}
