import { CaptureMode } from '../types/console';

export const PHOTO_COMMAND = {
    single: 0x01,
    stop: 0x02,
    interval: 0x03,
    liveStream: 0x04,
    captureHiRes: 0x05,
} as const;

export interface PhotoPacketResult {
    data: Uint8Array;
    orientation: 0 | 1 | 2 | 3;
}

export function encodeSingleCapture(): Uint8Array {
    // Legacy single-byte commands also work on v2 firmware, so prefer them to
    // keep the web console compatible with glasses that have not been flashed.
    return new Uint8Array([0xff]);
}

export function encodeStopCapture(): Uint8Array {
    return new Uint8Array([0x00]);
}

export function encodeIntervalCapture(seconds: number): Uint8Array {
    const normalized = Math.max(5, Math.min(300, Math.round(seconds)));
    if (normalized <= 127) {
        return new Uint8Array([normalized]);
    }
    return new Uint8Array([PHOTO_COMMAND.interval, normalized & 0xff, (normalized >> 8) & 0xff]);
}

export function encodeLiveStream(
    active: boolean,
    framesize: number,
    quality: number,
    intervalMs: number,
): Uint8Array {
    const normalizedInterval = Math.max(500, Math.min(10000, Math.round(intervalMs)));
    return new Uint8Array([
        PHOTO_COMMAND.liveStream,
        active ? 1 : 0,
        framesize,
        quality,
        normalizedInterval & 0xff,
        (normalizedInterval >> 8) & 0xff,
    ]);
}

export function encodeCaptureHiRes(): Uint8Array {
    return new Uint8Array([PHOTO_COMMAND.captureHiRes]);
}

export function decodeCaptureStatus(data: Uint8Array): { mode: CaptureMode; intervalSeconds: number } | null {
    if (data.length < 3) {
        return null;
    }
    const intervalSeconds = data[1] | (data[2] << 8);
    if (data[0] === 0) {
        return { mode: 'stopped', intervalSeconds: 0 };
    }
    if (data[0] === 1) {
        return { mode: 'single', intervalSeconds: 0 };
    }
    if (data[0] === 2) {
        return { mode: 'interval', intervalSeconds };
    }
    if (data[0] === 3) {
        return { mode: 'live', intervalSeconds: 0 };
    }
    return null;
}

export class PhotoAssembler {
    private previousChunk = -1;
    private chunks: Uint8Array[] = [];
    private byteLength = 0;
    private orientation: 0 | 1 | 2 | 3;

    constructor(private readonly includesOrientation: boolean) {
        this.orientation = includesOrientation ? 0 : 2;
    }

    reset(): void {
        this.previousChunk = -1;
        this.chunks = [];
        this.byteLength = 0;
        this.orientation = this.includesOrientation ? 0 : 2;
    }

    push(id: number | null, incoming: Uint8Array): PhotoPacketResult | null {
        let data = incoming;
        if (id === null) {
            if (this.previousChunk < 0 || this.byteLength === 0) {
                this.reset();
                return null;
            }
            const result = new Uint8Array(this.byteLength);
            let offset = 0;
            for (const chunk of this.chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            const completed = { data: result, orientation: this.orientation };
            this.reset();
            return completed;
        }

        if (this.previousChunk === -1) {
            if (id !== 0) {
                return null;
            }
            this.previousChunk = 0;
            if (this.includesOrientation && data.length > 0) {
                const value = data[0];
                this.orientation = value <= 3 ? value as 0 | 1 | 2 | 3 : 0;
                data = data.slice(1);
            }
        } else if (id !== this.previousChunk + 1) {
            this.reset();
            return null;
        } else {
            this.previousChunk = id;
        }

        this.chunks.push(data);
        this.byteLength += data.length;
        return null;
    }
}
