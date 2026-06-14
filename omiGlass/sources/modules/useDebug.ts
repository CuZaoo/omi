import * as React from 'react';

const CAMERA_CONTROL_UUID = '19b10007-e8f2-537e-4f6c-d104768a1214';
const OMI_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const CAMERA_SETTINGS_KEY = 'openglass:cameraSettings';

export const CAMERA_COMMAND = {
    framesize: 0x01,
    quality: 0x02,
    brightness: 0x03,
    contrast: 0x04,
    saturation: 0x05,
    aeLevel: 0x06,
    aecValue: 0x07,
    gainCeiling: 0x08,
    whiteBalance: 0x09,
    awbGain: 0x0a,
    horizontalMirror: 0x0b,
    verticalFlip: 0x0c,
    autoExposure: 0x0d,
    autoGain: 0x0e,
    wbMode: 0x0f,
    agcGain: 0x10,
    aec2: 0x11,
    specialEffect: 0x12,
    bpc: 0x13,
    wpc: 0x14,
    rawGma: 0x15,
    lensCorrection: 0x16,
    dcw: 0x17,
    colorbar: 0x18,
} as const;

export interface CameraSettings {
    framesize: number;
    quality: number;
    brightness: number;
    contrast: number;
    saturation: number;
    aeLevel: number;
    aecValue: number;
    gainCeiling: number;
    whiteBalance: boolean;
    awbGain: boolean;
    wbMode: number;
    autoExposure: boolean;
    aec2: boolean;
    autoGain: boolean;
    agcGain: number;
    specialEffect: number;
    bpc: boolean;
    wpc: boolean;
    rawGma: boolean;
    lensCorrection: boolean;
    dcw: boolean;
    horizontalMirror: boolean;
    verticalFlip: boolean;
    colorbar: boolean;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
    framesize: 8,
    quality: 12,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    aeLevel: 0,
    aecValue: 300,
    gainCeiling: 0,
    whiteBalance: true,
    awbGain: true,
    wbMode: 0,
    autoExposure: true,
    aec2: false,
    autoGain: true,
    agcGain: 0,
    specialEffect: 0,
    bpc: false,
    wpc: true,
    rawGma: true,
    lensCorrection: true,
    dcw: true,
    horizontalMirror: false,
    verticalFlip: false,
    colorbar: false,
};

export const ANTI_GREEN_CAMERA_SETTINGS: CameraSettings = {
    ...DEFAULT_CAMERA_SETTINGS,
    wbMode: 3,
    saturation: -1,
};

type CameraSettingKey = keyof CameraSettings;

function boolByte(value: boolean): number {
    return value ? 1 : 0;
}

function int8Byte(value: number): number {
    return value & 0xff;
}

export function encodeCameraSetting(key: CameraSettingKey, value: CameraSettings[CameraSettingKey]): Uint8Array {
    const command = CAMERA_COMMAND[key];
    if (key === 'aecValue') {
        const numeric = value as number;
        return new Uint8Array([command, numeric & 0xff, (numeric >> 8) & 0xff]);
    }
    if (key === 'brightness' || key === 'contrast' || key === 'saturation' || key === 'aeLevel') {
        return new Uint8Array([command, int8Byte(value as number)]);
    }
    return new Uint8Array([command, typeof value === 'boolean' ? boolByte(value) : value as number]);
}

export function loadCameraSettings(): CameraSettings {
    try {
        return { ...DEFAULT_CAMERA_SETTINGS, ...JSON.parse(localStorage.getItem(CAMERA_SETTINGS_KEY) || '{}') };
    } catch {
        return DEFAULT_CAMERA_SETTINGS;
    }
}

function persistCameraSettings(settings: CameraSettings): void {
    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify(settings));
}

export function useDebug(device: BluetoothRemoteGATTServer | null) {
    const [firmwareVersion, setFirmwareVersion] = React.useState('');
    const [hardwareVersion, setHardwareVersion] = React.useState('');
    const [serialNumber, setSerialNumber] = React.useState('');
    const [batteryLevel, setBatteryLevel] = React.useState<number | null>(null);
    const [settings, setSettingsState] = React.useState<CameraSettings>(loadCameraSettings);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [lastAppliedAt, setLastAppliedAt] = React.useState<number | null>(null);
    const characteristicRef = React.useRef<BluetoothRemoteGATTCharacteristic | null>(null);

    React.useEffect(() => {
        if (!device) {
            characteristicRef.current = null;
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const service = await device.getPrimaryService(OMI_SERVICE_UUID);
                characteristicRef.current = await service.getCharacteristic(CAMERA_CONTROL_UUID);
            } catch (characteristicError) {
                if (!cancelled) {
                    setError(`相机控制通道不可用：${String(characteristicError)}`);
                }
            }
            try {
                const infoService = await device.getPrimaryService('device_information');
                const firmware = await (await infoService.getCharacteristic('firmware_revision_string')).readValue();
                const hardware = await (await infoService.getCharacteristic('hardware_revision_string')).readValue();
                const serial = await (await infoService.getCharacteristic('serial_number_string')).readValue();
                if (!cancelled) {
                    setFirmwareVersion(new TextDecoder().decode(firmware));
                    setHardwareVersion(new TextDecoder().decode(hardware));
                    setSerialNumber(new TextDecoder().decode(serial));
                }
            } catch (infoError) {
                if (!cancelled) {
                    setError(`设备信息读取失败：${String(infoError)}`);
                }
            }
        })();
        return () => {
            cancelled = true;
            characteristicRef.current = null;
        };
    }, [device]);

    React.useEffect(() => {
        if (!device) {
            setBatteryLevel(null);
            return;
        }
        let interval: ReturnType<typeof setInterval> | undefined;
        void (async () => {
            try {
                const batteryService = await device.getPrimaryService(0x180f);
                const batteryCharacteristic = await batteryService.getCharacteristic(0x2a19);
                const readBattery = async () => {
                    const value = await batteryCharacteristic.readValue();
                    setBatteryLevel(value.getUint8(0));
                };
                await readBattery();
                interval = setInterval(() => void readBattery().catch(() => undefined), 30000);
            } catch {
                setBatteryLevel(null);
            }
        })();
        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [device]);

    const writeSetting = React.useCallback(async (key: CameraSettingKey, value: CameraSettings[CameraSettingKey]) => {
        const characteristic = characteristicRef.current;
        if (!characteristic) {
            throw new Error('相机控制通道尚未就绪');
        }
        await characteristic.writeValue(encodeCameraSetting(key, value));
    }, []);

    const setSetting = React.useCallback(async <K extends CameraSettingKey>(key: K, value: CameraSettings[K]) => {
        setSettingsState(current => {
            const next = { ...current, [key]: value };
            persistCameraSettings(next);
            return next;
        });
        if (!device) {
            setError(null);
            return;
        }
        setPending(true);
        setError(null);
        try {
            await writeSetting(key, value);
            setLastAppliedAt(Date.now());
        } catch (settingError) {
            setError(String(settingError));
        } finally {
            setPending(false);
        }
    }, [device, writeSetting]);

    const applyAll = React.useCallback(async (next: CameraSettings = settings) => {
        setSettingsState(next);
        persistCameraSettings(next);
        if (!device) {
            setError('参数已保存在本机；连接眼镜后点击“应用全部”。');
            return;
        }
        setPending(true);
        setError(null);
        try {
            for (const key of Object.keys(next) as CameraSettingKey[]) {
                await writeSetting(key, next[key]);
            }
            setLastAppliedAt(Date.now());
        } catch (applyError) {
            setError(String(applyError));
        } finally {
            setPending(false);
        }
    }, [device, settings, writeSetting]);

    return {
        firmwareVersion,
        hardwareVersion,
        serialNumber,
        batteryLevel,
        settings,
        pending,
        error,
        lastAppliedAt,
        setSetting,
        applyAll,
        applyAntiGreen: () => applyAll(ANTI_GREEN_CAMERA_SETTINGS),
        resetDefaults: () => applyAll(DEFAULT_CAMERA_SETTINGS),
    };
}
