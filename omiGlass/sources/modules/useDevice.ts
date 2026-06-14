import * as React from 'react';
import { DeviceStatus } from '../types/console';

const DEVICE_STORAGE_KEY = 'openglassDeviceId';
export const RECONNECT_DELAYS = [1000, 2000, 4000];
const OMI_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';

type BluetoothWithDevices = Bluetooth & {
    getDevices?: () => Promise<BluetoothDevice[]>;
};

export interface DeviceController {
    device: BluetoothRemoteGATTServer | null;
    bluetoothDevice: BluetoothDevice | null;
    status: DeviceStatus;
    error: string | null;
    connect: () => Promise<void>;
    reconnect: () => Promise<void>;
    disconnect: () => void;
}

export function findStoredDevice(devices: BluetoothDevice[], storedId: string | null): BluetoothDevice | null {
    if (!storedId) {
        return null;
    }
    return devices.find(device => device.id === storedId) || null;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function useDevice(): DeviceController {
    const [device, setDevice] = React.useState<BluetoothRemoteGATTServer | null>(null);
    const [bluetoothDevice, setBluetoothDevice] = React.useState<BluetoothDevice | null>(null);
    const [status, setStatus] = React.useState<DeviceStatus>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const deviceRef = React.useRef<BluetoothDevice | null>(null);
    const manualDisconnectRef = React.useRef(false);
    const reconnectGenerationRef = React.useRef(0);

    const attachDevice = React.useCallback((candidate: BluetoothDevice) => {
        deviceRef.current = candidate;
        setBluetoothDevice(candidate);
        candidate.ongattserverdisconnected = () => {
            setDevice(null);
            if (manualDisconnectRef.current) {
                manualDisconnectRef.current = false;
                setStatus('idle');
                return;
            }

            const generation = ++reconnectGenerationRef.current;
            void (async () => {
                setStatus('reconnecting');
                for (const delay of RECONNECT_DELAYS) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    if (generation !== reconnectGenerationRef.current) {
                        return;
                    }
                    try {
                        const gatt = await candidate.gatt?.connect();
                        if (gatt?.connected) {
                            setDevice(gatt);
                            setError(null);
                            setStatus('connected');
                            return;
                        }
                    } catch (reconnectError) {
                        setError(errorMessage(reconnectError));
                    }
                }
                setStatus('error');
                setError('设备自动重连失败，请手动重试。');
            })();
        };
    }, []);

    const connectCandidate = React.useCallback(async (candidate: BluetoothDevice, nextStatus: DeviceStatus) => {
        manualDisconnectRef.current = false;
        setStatus(nextStatus);
        setError(null);
        attachDevice(candidate);
        const gatt = await candidate.gatt?.connect();
        if (!gatt) {
            throw new Error('设备未提供可用的 GATT 服务。');
        }
        localStorage.setItem(DEVICE_STORAGE_KEY, candidate.id);
        setDevice(gatt);
        setStatus('connected');
    }, [attachDevice]);

    React.useEffect(() => {
        if (!navigator.bluetooth) {
            setStatus('unsupported');
            setError('当前浏览器不支持 Web Bluetooth，请使用桌面版 Chromium。');
            return;
        }

        const bluetooth = navigator.bluetooth as BluetoothWithDevices;
        const storedId = localStorage.getItem(DEVICE_STORAGE_KEY);
        if (!storedId || !bluetooth.getDevices) {
            setStatus('idle');
            return;
        }

        let cancelled = false;
        void (async () => {
            try {
                setStatus('restoring');
                const devices = await bluetooth.getDevices!();
                const candidate = findStoredDevice(devices, storedId);
                if (!candidate || cancelled) {
                    setStatus('idle');
                    return;
                }
                await connectCandidate(candidate, 'restoring');
            } catch (restoreError) {
                if (!cancelled) {
                    setStatus('error');
                    setError(`恢复设备失败：${errorMessage(restoreError)}`);
                }
            }
        })();

        return () => {
            cancelled = true;
            reconnectGenerationRef.current += 1;
        };
    }, [connectCandidate]);

    const connect = React.useCallback(async () => {
        if (!navigator.bluetooth) {
            setStatus('unsupported');
            return;
        }
        try {
            const candidate = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'OMI Glass' }],
                optionalServices: [OMI_SERVICE_UUID, 'device_information', 0x180f],
            });
            await connectCandidate(candidate, 'connecting');
        } catch (connectError) {
            const message = errorMessage(connectError);
            if (message.toLowerCase().includes('cancel')) {
                setStatus('idle');
                return;
            }
            setStatus('error');
            setError(`连接失败：${message}`);
        }
    }, [connectCandidate]);

    const reconnect = React.useCallback(async () => {
        const candidate = deviceRef.current;
        if (!candidate) {
            await connect();
            return;
        }
        try {
            reconnectGenerationRef.current += 1;
            await connectCandidate(candidate, 'reconnecting');
        } catch (reconnectError) {
            setStatus('error');
            setError(`重连失败：${errorMessage(reconnectError)}`);
        }
    }, [connect, connectCandidate]);

    const disconnect = React.useCallback(() => {
        reconnectGenerationRef.current += 1;
        manualDisconnectRef.current = true;
        deviceRef.current?.gatt?.disconnect();
        setDevice(null);
        setStatus('idle');
        setError(null);
    }, []);

    return { device, bluetoothDevice, status, error, connect, reconnect, disconnect };
}
