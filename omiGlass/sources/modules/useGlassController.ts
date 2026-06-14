import * as React from 'react';
import { rotateImage } from './imaging';
import {
    decodeCaptureStatus,
    encodeIntervalCapture,
    encodeSingleCapture,
    encodeStopCapture,
    PhotoAssembler,
} from './photoProtocol';
import { CaptureState, DiagnosticEntry, FrameRecord } from '../types/console';

const OMI_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const PHOTO_DATA_UUID = '19b10005-e8f2-537e-4f6c-d104768a1214';
const PHOTO_CONTROL_UUID = '19b10006-e8f2-537e-4f6c-d104768a1214';

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

export function useGlassController({ device, onFrame }: GlassControllerOptions) {
    const [subscribed, setSubscribed] = React.useState(false);
    const [capture, setCapture] = React.useState<CaptureState>({ mode: 'stopped', intervalSeconds: 30, pending: false });
    const [info, setInfo] = React.useState<GlassInfo>({ firmware: '', hardware: '', serial: '', battery: null });
    const [diagnostics, setDiagnostics] = React.useState<DiagnosticEntry[]>([]);
    const controlRef = React.useRef<BluetoothRemoteGATTCharacteristic | null>(null);
    const onFrameRef = React.useRef(onFrame);
    onFrameRef.current = onFrame;

    const log = React.useCallback((level: DiagnosticEntry['level'], message: string) => {
        setDiagnostics(current => [
            { id: `${Date.now()}-${Math.random()}`, level, message, timestamp: Date.now() },
            ...current,
        ].slice(0, 80));
    }, []);

    React.useEffect(() => {
        if (!device) {
            setSubscribed(false);
            controlRef.current = null;
            return;
        }

        let disposed = false;
        let photoCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
        let controlCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
        let photoListener: EventListener | null = null;
        let controlListener: EventListener | null = null;
        let assembler: PhotoAssembler | null = null;

        void (async () => {
            try {
                let firmware = '0.0.0';
                let hardware = '';
                let serial = '';
                try {
                    const service = await device.getPrimaryService('device_information');
                    const firmwareValue = await (await service.getCharacteristic('firmware_revision_string')).readValue();
                    firmware = new TextDecoder().decode(firmwareValue);
                    const hardwareValue = await (await service.getCharacteristic('hardware_revision_string')).readValue();
                    hardware = new TextDecoder().decode(hardwareValue);
                    const serialValue = await (await service.getCharacteristic('serial_number_string')).readValue();
                    serial = new TextDecoder().decode(serialValue);
                } catch (error) {
                    log('warn', `设备信息读取不完整：${String(error)}`);
                }
                if (disposed) {
                    return;
                }
                setInfo(current => ({ ...current, firmware, hardware, serial }));
                assembler = new PhotoAssembler(compareVersions(firmware, '2.1.1') >= 0);

                try {
                    const batteryService = await device.getPrimaryService(0x180f);
                    const batteryValue = await (await batteryService.getCharacteristic(0x2a19)).readValue();
                    setInfo(current => ({ ...current, battery: batteryValue.getUint8(0) }));
                } catch (error) {
                    log('warn', `电量服务不可用：${String(error)}`);
                }

                const service = await device.getPrimaryService(OMI_SERVICE_UUID);
                photoCharacteristic = await service.getCharacteristic(PHOTO_DATA_UUID);
                controlCharacteristic = await service.getCharacteristic(PHOTO_CONTROL_UUID);
                controlRef.current = controlCharacteristic;

                photoListener = ((event: Event) => {
                    const startedAt = Date.now();
                    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
                    if (!value || !assembler) {
                        return;
                    }
                    const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
                    const completed = bytes[0] === 0xff && bytes[1] === 0xff
                        ? assembler.push(null, new Uint8Array())
                        : assembler.push(bytes[0] | (bytes[1] << 8), bytes.slice(2));
                    if (!completed) {
                        return;
                    }
                    const rotations = ['0', '90', '180', '270'] as const;
                    void rotateImage(completed.data, rotations[completed.orientation]).then(data => {
                        const timestamp = Date.now();
                        onFrameRef.current({
                            id: `frame-${timestamp}-${Math.random().toString(16).slice(2)}`,
                            timestamp,
                            data,
                            stages: frameStages(startedAt),
                        });
                        log('info', `收到画面 ${Math.round(data.length / 1024)} KB`);
                    }).catch(error => log('error', `画面旋转失败：${String(error)}`));
                }) as EventListener;
                photoCharacteristic.addEventListener('characteristicvaluechanged', photoListener);
                await photoCharacteristic.startNotifications();

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
                    await controlCharacteristic.startNotifications();
                    const currentStatus = decodeCaptureStatus(new Uint8Array((await controlCharacteristic.readValue()).buffer));
                    if (currentStatus) {
                        setCapture({ ...currentStatus, pending: false });
                    }
                } catch {
                    log('warn', '固件不支持采集状态通知，将使用本地状态。');
                }

                if (!disposed) {
                    setSubscribed(true);
                    log('info', '照片与采集状态通道已就绪。');
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
            controlRef.current = null;
            assembler?.reset();
            if (photoCharacteristic && photoListener) {
                photoCharacteristic.removeEventListener('characteristicvaluechanged', photoListener);
                void photoCharacteristic.stopNotifications().catch(() => undefined);
            }
            if (controlCharacteristic && controlListener) {
                controlCharacteristic.removeEventListener('characteristicvaluechanged', controlListener);
                void controlCharacteristic.stopNotifications().catch(() => undefined);
            }
        };
    }, [device, log]);

    const writeCaptureCommand = React.useCallback(async (
        command: Uint8Array,
        fallback: Pick<CaptureState, 'mode' | 'intervalSeconds'>,
    ) => {
        const characteristic = controlRef.current;
        if (!characteristic) {
            setCapture(current => ({ ...current, pending: false, error: '设备采集通道尚未就绪。' }));
            return;
        }
        setCapture(current => ({ ...current, pending: true, error: undefined }));
        try {
            log('info', `发送采集命令：${Array.from(command).map(value => value.toString(16).padStart(2, '0')).join(' ')}`);
            await characteristic.writeValue(command);
            setCapture({ ...fallback, pending: false });
            log('info', `采集模式切换为 ${fallback.mode}${fallback.mode === 'interval' ? ` / ${fallback.intervalSeconds}s` : ''}`);
        } catch (error) {
            setCapture(current => ({ ...current, pending: false, error: String(error) }));
            log('error', `采集命令失败：${String(error)}`);
        }
    }, [log]);

    return {
        subscribed,
        capture,
        info,
        diagnostics,
        takePhoto: () => writeCaptureCommand(encodeSingleCapture(), { mode: 'single', intervalSeconds: 0 }),
        startInterval: (seconds: number) => writeCaptureCommand(encodeIntervalCapture(seconds), {
            mode: 'interval',
            intervalSeconds: Math.max(5, Math.min(300, Math.round(seconds))),
        }),
        stopCapture: () => writeCaptureCommand(encodeStopCapture(), { mode: 'stopped', intervalSeconds: 0 }),
    };
}
