import { CaptureMode } from '../types/console';

export const PHOTO_COMMAND = {
    single: 0x01,
    stop: 0x02,
    interval: 0x03,
    liveStream: 0x04,
    captureHiRes: 0x05,
} as const;

export const STREAM_COMMAND = {
    connectWifi: 0x06,
    disconnect: 0x07,
    scan: 0x08,
    setConfig: 0x09,
} as const;

export const STREAM_STATUS_BYTE = {
    idle: 0x00,
    connecting: 0x51,
    connected: 0x52,
    failed: 0x53,
    disconnected: 0x54,
} as const;

export const SCAN_MARKER = {
    result: 0x60,
    done: 0x61,
} as const;

export interface StreamStatus {
    status: number;
    ip: string;
}

export interface ScanEntry {
    ssid: string;
    rssi: number;
    connected?: boolean;
    source?: 'computer' | 'glass';
    band?: string;
    compatible?: boolean;
}

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

export function encodeStreamConnectWifi(ssid: string, password: string): Uint8Array {
    const ssidBytes = new TextEncoder().encode(ssid);
    const passBytes = new TextEncoder().encode(password);
    const buf = new Uint8Array(1 + 1 + ssidBytes.length + 1 + passBytes.length);
    buf[0] = STREAM_COMMAND.connectWifi;
    buf[1] = ssidBytes.length;
    buf.set(ssidBytes, 2);
    buf[2 + ssidBytes.length] = passBytes.length;
    buf.set(passBytes, 3 + ssidBytes.length);
    return buf;
}

export function encodeStreamDisconnect(): Uint8Array {
    return new Uint8Array([STREAM_COMMAND.disconnect]);
}

export function encodeScanNetworks(): Uint8Array {
    return new Uint8Array([STREAM_COMMAND.scan, 0x00, 0x00]);
}

export function encodeStreamSetConfig(framesize: number, quality: number): Uint8Array {
    return new Uint8Array([STREAM_COMMAND.setConfig, framesize, quality]);
}

export function decodeStreamStatus(data: Uint8Array): { status: number; ip: string } | null {
    if (data.length < 1) return null;
    const status = data[0];
    const rawIp = data.length > 1 ? new TextDecoder().decode(data.slice(1)) : '';
    // Firmware may notify a C string / fixed buffer for the IP address. Strip
    // trailing NUL bytes before using it in an <img src>, otherwise the browser
    // sees e.g. "http://192.168.1.68\u0000/stream" and never requests the stream.
    const ip = rawIp.split('\0')[0].trim();
    return { status, ip };
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

export function decodeScanResult(data: Uint8Array): ScanEntry | null {
    if (data.length < 3 || data[0] !== SCAN_MARKER.result) return null;
    const ssidLen = data[1];
    if (data.length < 3 + ssidLen) return null;
    const ssid = new TextDecoder().decode(data.slice(2, 2 + ssidLen));
    const rssi = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt8(2 + ssidLen);
    return { ssid, rssi, source: 'glass' };
}

export function isScanDone(data: Uint8Array): number | null {
    if (data.length >= 2 && data[0] === SCAN_MARKER.done) {
        return data[1];
    }
    return null;
}
