import * as React from 'react';
import { getOmiService } from './bluetoothProtocol';
import { runGattOperation, writeGattValue } from './gattQueue';
import { rotateImage } from './imaging';
import { scanLocalWifi } from './localWifi';
import {
    decodeCaptureStatus,
    decodeScanResult,
    decodeStreamStatus,
    encodeIntervalCapture,
    encodeLiveStream,
    encodeCaptureHiRes,
    encodeScanNetworks,
    encodeSingleCapture,
    encodeStopCapture,
    encodeStreamConnectWifi,
    encodeStreamDisconnect,
    encodeStreamSetConfig,
    isScanDone,
    PhotoAssembler,
    ScanEntry,
    StreamStatus,
} from './photoProtocol';
import { CaptureState, DiagnosticEntry, FrameRecord } from '../types/console';

const PHOTO_DATA_UUID = '19b10005-e8f2-537e-4f6c-d104768a1214';
const PHOTO_CONTROL_UUID = '19b10006-e8f2-537e-4f6c-d104768a1214';
const STREAM_STATUS_UUID = '19b10008-e8f2-537e-4f6c-d104768a1214';

export interface GlassInfo {
    firmware: string;
    hardware: string;
    serial: string;
    battery: number | null;
}

interface GlassControllerOptions {
    device: BluetoothRemoteGATTServer | null;
    onFrame: (frame: FrameRecord) => void;
}

function compareVersions(first: string, second: string): number {
    const left = first.split('.').map(Number);
    const right = second.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] || 0) - (right[index] || 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function frameStages(startedAt: number): FrameRecord['stages'] {
    return [
        { name: 'ble', status: 'success', startedAt, durationMs: 0 },
        { name: 'assemble', status: 'success', startedAt, durationMs: Date.now() - startedAt },
        { name: 'persist', status: 'running', startedAt: Date.now() },
        { name: 'vision', status: 'pending' },
        { name: 'reasoning', status: 'pending' },
    ];
}

async function startNotificationsWithRetry(
    device: BluetoothRemoteGATTServer,
    characteristic: BluetoothRemoteGATTCharacteristic,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await runGattOperation(device, () => characteristic.startNotifications());
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw lastError;
}

export function useGlassController({ device, onFrame }: GlassControllerOptions) {
    const [subscribed, setSubscribed] = React.useState(false);
    const [capture, setCapture] = React.useState<CaptureState>({ mode: 'stopped', intervalSeconds: 30, pending: false });
    const [info, setInfo] = React.useState<GlassInfo>({ firmware: '', hardware: '', serial: '', battery: null });
    const [diagnostics, setDiagnostics] = React.useState<DiagnosticEntry[]>([]);
    const [stream, setStream] = React.useState<StreamStatus>({ status: 0, ip: '' });
    const [scanResults, setScanResults] = React.useState<ScanEntry[]>([]);
    const [scanning, setScanning] = React.useState(false);
    const [scanError, setScanError] = React.useState('');
    const [currentWifiSsid, setCurrentWifiSsid] = React.useState('');
    const [captureReady, setCaptureReady] = React.useState(false);
    const controlRef = React.useRef<BluetoothRemoteGATTCharacteristic | null>(null);
    const onFrameRef = React.useRef(onFrame);
    onFrameRef.current = onFrame;
    const captureCommandSentAt = React.useRef(0);
    const transferStartedAt = React.useRef(0);
    const transferChunks = React.useRef(0);
    const transferBytes = React.useRef(0);

    const log = React.useCallback((level: DiagnosticEntry['level'], message: string) => {
        setDiagnostics(current => [
            { id: `${Date.now()}-${Math.random()}`, level, message, timestamp: Date.now() },
            ...current,
        ].slice(0, 80));
    }, []);

    React.useEffect(() => {
        if (!device) {
            setSubscribed(false);
            setCaptureReady(false);
            controlRef.current = null;
            return;
        }

        let disposed = false;
        let photoCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
        let controlCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
        let photoListener: EventListener | null = null;
        let controlListener: EventListener | null = null;
        let streamCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
        let streamListener: EventListener | null = null;
        let assembler: PhotoAssembler | null = null;

        void (async () => {
            try {
                if (disposed) {
                    return;
                }
                setInfo(current => ({ ...current, firmware: '2.3.2', hardware: 'ESP32-S3-v1.0', serial: '' }));
                assembler = new PhotoAssembler(true);

                try {
                    const batteryService = await runGattOperation(device, () => device.getPrimaryService(0x180f));
                    const batteryCharacteristic = await runGattOperation(device, () => batteryService.getCharacteristic(0x2a19));
                    const batteryValue = await runGattOperation(device, () => batteryCharacteristic.readValue());
                    setInfo(current => ({ ...current, battery: batteryValue.getUint8(0) }));
                } catch (error) {
                    log('warn', `电量服务不可用：${String(error)}`);
                }
                if (disposed) {
                    return;
                }

                const service = await getOmiService(device);
                const discoveredCharacteristics = await runGattOperation(device, () => service.getCharacteristics());
                if (disposed) {
                    return;
                }
                log('info', `[DIAG] GATT TABLE: ${discoveredCharacteristics.map(item => item.uuid).join(', ')}`);

                try {
                    photoCharacteristic = await runGattOperation(device, () => service.getCharacteristic(PHOTO_DATA_UUID));
                    log('info', '[DIAG] PHOTO_DATA (19b10005) FOUND');
                } catch (e) {
                    log('error', `[DIAG] PHOTO_DATA (19b10005) NOT FOUND: ${e}`);
                }

                try {
                    controlCharacteristic = await runGattOperation(device, () => service.getCharacteristic(PHOTO_CONTROL_UUID));
                    log('info', '[DIAG] PHOTO_CONTROL (19b10006) FOUND');
                } catch (e) {
                    log('warn', `[DIAG] PHOTO_CONTROL (19b10006) NOT FOUND: ${e}`);
                    log('warn', '眼镜控制特征未注册，当前连接不能执行拍摄或 WiFi 写入命令。');
                }
                controlRef.current = controlCharacteristic;
                setCaptureReady(Boolean(controlCharacteristic));

                if (photoCharacteristic) {
                    photoListener = ((event: Event) => {
                    const now = Date.now();
                    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
                    if (!value || !assembler) {
                        return;
                    }
                    const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
                    const isEnd = bytes[0] === 0xff && bytes[1] === 0xff;
                    if (!isEnd) {
                        const frameIndex = bytes[0] | (bytes[1] << 8);
                        if (transferStartedAt.current === 0) {
                            transferStartedAt.current = now;
                            const cmdDelay = captureCommandSentAt.current > 0 ? now - captureCommandSentAt.current : 0;
                            log('info', `首包到达 ${cmdDelay}ms | chunk=${frameIndex} size=${bytes.length}`);
                        }
                        transferChunks.current += 1;
                        transferBytes.current += bytes.length;
                    }
                    const completed = isEnd
                        ? assembler.push(null, new Uint8Array())
                        : assembler.push(bytes[0] | (bytes[1] << 8), bytes.slice(2));
                    if (!completed) {
                        return;
                    }
                    const transferDuration = transferStartedAt.current > 0 ? now - transferStartedAt.current : 0;
                    const totalDuration = captureCommandSentAt.current > 0 ? now - captureCommandSentAt.current : 0;
                    log('info', `传输完成 ${transferDuration}ms | ${transferChunks.current} chunks | ${Math.round(transferBytes.current / 1024)} KB | 总耗时 ${totalDuration}ms`);
                    transferStartedAt.current = 0;
                    transferChunks.current = 0;
                    transferBytes.current = 0;
                    captureCommandSentAt.current = 0;
                    const rotations = ['0', '90', '180', '270'] as const;
                    const hdr = completed.data;
                    log('info', `[DIAG] photo seq? size=${completed.data.byteLength} hdr=${Array.from(hdr.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
                    void rotateImage(completed.data, rotations[completed.orientation]).then(data => {
                        const timestamp = Date.now();
                        onFrameRef.current({
                            id: `frame-${timestamp}-${Math.random().toString(16).slice(2)}`,
                            timestamp,
                            data,
                            stages: frameStages(now),
                        });
                        log('info', `收到画面 ${Math.round(data.length / 1024)} KB`);
                    }).catch(error => log('error', `画面旋转失败：${String(error)}`));
                    }) as EventListener;
                    photoCharacteristic.addEventListener('characteristicvaluechanged', photoListener);
                    try {
                        await startNotificationsWithRetry(device, photoCharacteristic);
                        setSubscribed(true);
                        log('info', '照片通知通道已就绪。');
                    } catch (error) {
                        photoCharacteristic.removeEventListener('characteristicvaluechanged', photoListener);
                        photoListener = null;
                        log('error', `照片通知订阅失败：${String(error)}`);
                    }
                }

                if (controlCharacteristic) {
                    controlListener = ((event: Event) => {
                        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
                        if (!value) {
                            return;
                        }
                        const status = decodeCaptureStatus(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
                        if (status) {
                            setCapture({ ...status, pending: false });
                        }
                    }) as EventListener;
                    controlCharacteristic.addEventListener('characteristicvaluechanged', controlListener);
                    try {
                        await startNotificationsWithRetry(device, controlCharacteristic);
                        const currentValue = await runGattOperation(device, () => controlCharacteristic!.readValue());
                        const currentStatus = decodeCaptureStatus(new Uint8Array(currentValue.buffer));
                        if (currentStatus) {
                            setCapture({ ...currentStatus, pending: false });
                        }
                    } catch {
                        log('warn', '固件不支持采集状态通知，将使用本地状态。');
                    }
                }

                // Subscribe to stream status
                try {
                    streamCharacteristic = await runGattOperation(device, () => service.getCharacteristic(STREAM_STATUS_UUID));
                    log('info', '[DIAG] STREAM_STATUS (19b10008) FOUND');
                    streamListener = ((event: Event) => {
                        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
                        if (!value) return;
                        const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
                        // Check scan result
                        const scanEntry = decodeScanResult(bytes);
                        if (scanEntry) {
                            setScanResults(prev => {
                                if (prev.some(e => e.ssid === scanEntry.ssid)) return prev;
                                return [...prev, scanEntry];
                            });
                            return;
                        }
                        // Check scan done
                        const scanCount = isScanDone(bytes);
                        if (scanCount !== null) {
                            setScanning(false);
                            log('info', `WiFi 扫描完成，发现 ${scanCount} 个网络`);
                            return;
                        }
                        // Default: status update
                        const s = decodeStreamStatus(bytes);
                        if (s) {
                            setStream(s);
                            if (s.status === 0x52 && s.ip) {
                                log('info', `WiFi 视频流已就绪: http://${s.ip}/stream`);
                            } else if (s.status === 0x53) {
                                log('error', 'WiFi 连接失败');
                            }
                        }
                    }) as EventListener;
                    streamCharacteristic.addEventListener('characteristicvaluechanged', streamListener);
                    await startNotificationsWithRetry(device, streamCharacteristic);
                    // Also try to read current state
                    try {
                        const initialValue = await runGattOperation(device, () => streamCharacteristic!.readValue());
                        const initial = decodeStreamStatus(new Uint8Array(initialValue.buffer));
                        if (initial) setStream(initial);
                    } catch { /* ignore */ }
                } catch (e) {
                    log('warn', `[DIAG] STREAM_STATUS (19b10008) NOT FOUND: ${e}`);
                }

            } catch (error) {
                if (!disposed) {
                    setSubscribed(false);
                    log('error', `订阅设备失败：${String(error)}`);
                }
            }
        })();

        return () => {
            disposed = true;
            setSubscribed(false);
            setCaptureReady(false);
            controlRef.current = null;
            assembler?.reset();
            if (photoCharacteristic && photoListener) {
                photoCharacteristic.removeEventListener('characteristicvaluechanged', photoListener);
                void runGattOperation(device, () => photoCharacteristic!.stopNotifications()).catch(() => undefined);
            }
            if (controlCharacteristic && controlListener) {
                controlCharacteristic.removeEventListener('characteristicvaluechanged', controlListener);
                void runGattOperation(device, () => controlCharacteristic!.stopNotifications()).catch(() => undefined);
            }
            if (streamCharacteristic && streamListener) {
                streamCharacteristic.removeEventListener('characteristicvaluechanged', streamListener);
                void runGattOperation(device, () => streamCharacteristic!.stopNotifications()).catch(() => undefined);
            }
        };
    }, [device, log]);

    const writeCaptureCommand = React.useCallback(async (
        command: Uint8Array,
        fallback: Pick<CaptureState, 'mode' | 'intervalSeconds'>,
    ) => {
        const characteristic = controlRef.current;
        if (!device || !characteristic) {
            setCapture(current => ({ ...current, pending: false, error: '设备采集通道尚未就绪。' }));
            return;
        }
        setCapture(current => ({ ...current, pending: true, error: undefined }));
        try {
            captureCommandSentAt.current = Date.now();
            log('info', `发送采集命令：${Array.from(command).map(value => value.toString(16).padStart(2, '0')).join(' ')}`);
            await writeGattValue(device, characteristic, command);
            setCapture({ ...fallback, pending: false });
            log('info', `采集模式切换为 ${fallback.mode}${fallback.mode === 'interval' ? ` / ${fallback.intervalSeconds}s` : ''}`);
        } catch (error) {
            setCapture(current => ({ ...current, pending: false, error: String(error) }));
            log('error', `采集命令失败：${String(error)}`);
        }
    }, [device, log]);

    const toggleLiveStream = React.useCallback((
        active: boolean,
        framesize = 5,
        quality = 15,
        intervalMs = 1500,
    ) => {
        const command = encodeLiveStream(active, framesize, quality, intervalMs);
        const fallback: Pick<CaptureState, 'mode' | 'intervalSeconds'> = active
            ? { mode: 'live', intervalSeconds: 0 }
            : { mode: 'stopped', intervalSeconds: 0 };
        writeCaptureCommand(command, fallback);
        log('info', `Live stream ${active ? 'started' : 'stopped'} (${framesize}, q=${quality}, ${intervalMs}ms)`);
    }, [writeCaptureCommand, log]);

    const captureHiRes = React.useCallback(() => {
        writeCaptureCommand(encodeCaptureHiRes(), { mode: 'single', intervalSeconds: 0 });
        log('info', 'Hi-res capture requested');
    }, [writeCaptureCommand, log]);

    const connectWifi = React.useCallback(async (ssid: string, password: string) => {
        const characteristic = controlRef.current;
        if (!device || !characteristic) {
            log('error', 'WiFi 写入失败：眼镜缺少 PHOTO_CONTROL (19b10006)，请更新固件后重新连接。');
            return;
        }
        try {
            log('info', `WiFi: 正在连接 ${ssid}...`);
            const cmd = encodeStreamConnectWifi(ssid, password);
            if (cmd.byteLength > 509) {
                throw new Error('WiFi 凭据超过 BLE 写入上限。');
            }
            await writeGattValue(device, characteristic, cmd);
            setStream({ status: 0x51, ip: '' });
        } catch (error) {
            log('error', `WiFi 连接命令发送失败: ${String(error)}`);
        }
    }, [device, log]);

    const disconnectWifi = React.useCallback(async () => {
        const characteristic = controlRef.current;
        if (!device || !characteristic) return;
        try {
            await writeGattValue(device, characteristic, encodeStreamDisconnect());
            setStream({ status: 0, ip: '' });
            log('info', 'WiFi: 断开连接');
        } catch (error) {
            log('error', `WiFi 断开命令发送失败: ${String(error)}`);
        }
    }, [device, log]);

    const scanNetworks = React.useCallback(async () => {
        setScanResults([]);
        setScanError('');
        setScanning(true);
        try {
            const local = await scanLocalWifi();
            setCurrentWifiSsid(local.currentSsid);
            setScanResults(local.networks);
            setScanning(false);
            log('info', `本机 WiFi 扫描完成，发现 ${local.networks.length} 个网络${local.currentSsid ? `；当前连接 ${local.currentSsid}` : ''}`);
            return;
        } catch (localError) {
            log('warn', `本机 WiFi 扫描不可用：${String(localError)}`);
        }

        const characteristic = controlRef.current;
        if (!device || !characteristic) {
            const message = '无法扫描：本机扫描服务不可用，且眼镜固件缺少 PHOTO_CONTROL (19b10006)。';
            setScanError(message);
            setScanning(false);
            log('error', message);
            return;
        }
        try {
            await writeGattValue(device, characteristic, encodeScanNetworks());
            log('info', '已通过眼镜发起 WiFi 扫描');
        } catch (error) {
            const message = `眼镜 WiFi 扫描命令发送失败：${String(error)}`;
            setScanError(message);
            log('error', message);
            setScanning(false);
        }
        setTimeout(() => setScanning(false), 15000);
    }, [device, log]);

    const setWifiStreamConfig = React.useCallback(async (framesize: number, quality: number) => {
        const characteristic = controlRef.current;
        if (!device || !characteristic) return;
        try {
            await writeGattValue(device, characteristic, encodeStreamSetConfig(framesize, quality));
            log('info', `WiFi 流画质已设置: framesize=${framesize} quality=${quality}`);
        } catch (error) {
            log('error', `WiFi 流画质设置失败: ${String(error)}`);
        }
    }, [device, log]);

    return {
        subscribed,
        captureReady,
        capture,
        info,
        diagnostics,
        stream,
        takePhoto: () => {
            if (capture.pending) return;
            writeCaptureCommand(encodeSingleCapture(), { mode: 'single', intervalSeconds: 0 });
        },
        startInterval: (seconds: number) => writeCaptureCommand(encodeIntervalCapture(seconds), {
            mode: 'interval',
            intervalSeconds: Math.max(1, Math.min(300, Math.round(seconds))),
        }),
        stopCapture: () => writeCaptureCommand(encodeStopCapture(), { mode: 'stopped', intervalSeconds: 0 }),
        toggleLiveStream,
        captureHiRes,
        connectWifi,
        disconnectWifi,
        scanNetworks,
        setWifiStreamConfig,
        scanResults,
        scanning,
        scanError,
        currentWifiSsid,
    };
}
