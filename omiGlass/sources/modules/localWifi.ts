import { ScanEntry } from './photoProtocol';

interface LocalWifiResponse {
    currentSsid?: string;
    networks?: Array<{
        ssid?: string;
        rssi?: number;
        signal?: number;
        connected?: boolean;
        band?: string;
        compatible?: boolean;
    }>;
    unsupported?: boolean;
    error?: string;
}

export interface LocalWifiScan {
    currentSsid: string;
    networks: ScanEntry[];
}

export function normalizeLocalWifiScan(payload: LocalWifiResponse): LocalWifiScan {
    const currentSsid = payload.currentSsid?.trim() || '';
    const networks = (payload.networks || [])
        .filter(network => Boolean(network.ssid?.trim()))
        .map(network => ({
            ssid: network.ssid!.trim(),
            rssi: Number.isFinite(network.rssi) ? network.rssi! : Math.round(-100 + (network.signal || 0) / 2),
            connected: Boolean(network.connected) || network.ssid?.trim() === currentSsid,
            source: 'computer' as const,
            band: network.band || '',
            compatible: network.compatible !== false,
        }))
        .sort((left, right) => Number(right.connected) - Number(left.connected) || right.rssi - left.rssi);
    return { currentSsid, networks };
}

export async function scanLocalWifi(): Promise<LocalWifiScan> {
    const response = await fetch('/api/local-wifi', { cache: 'no-store' });
    const payload = await response.json() as LocalWifiResponse;
    if (!response.ok) {
        throw new Error(payload.error || `本机 WiFi 扫描失败 (${response.status})`);
    }
    if (payload.unsupported) {
        throw new Error('当前开发服务器不支持读取系统 WiFi 列表');
    }
    return normalizeLocalWifiScan(payload);
}
