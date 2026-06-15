export const OMI_SERVICE_UUID_V2 = '19b10020-e8f2-537e-4f6c-d104768a1214';
export const OMI_SERVICE_UUID_LEGACY = '19b10000-e8f2-537e-4f6c-d104768a1214';
export const OMI_SERVICE_UUIDS = [OMI_SERVICE_UUID_V2, OMI_SERVICE_UUID_LEGACY] as const;

export async function getOmiService(
    device: BluetoothRemoteGATTServer,
): Promise<BluetoothRemoteGATTService> {
    let lastError: unknown;
    for (const uuid of OMI_SERVICE_UUIDS) {
        try {
            return await device.getPrimaryService(uuid);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('未找到兼容的 OMI Glass GATT 服务。');
}
