const queues = new WeakMap<BluetoothRemoteGATTServer, Promise<void>>();

function settleDelay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 40));
}

export function runGattOperation<T>(
    device: BluetoothRemoteGATTServer,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = queues.get(device) || Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
        if (!device.connected) {
            throw new Error('GATT 连接已断开。');
        }
        try {
            return await operation();
        } finally {
            await settleDelay();
        }
    });
    queues.set(device, result.then(() => undefined, () => undefined));
    return result;
}

export function writeGattValue(
    device: BluetoothRemoteGATTServer,
    characteristic: BluetoothRemoteGATTCharacteristic,
    value: BufferSource,
): Promise<void> {
    return runGattOperation(device, () => {
        if (characteristic.writeValueWithResponse) {
            return characteristic.writeValueWithResponse(value);
        }
        return characteristic.writeValue(value);
    });
}
