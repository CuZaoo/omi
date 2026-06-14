import { PhotoAssembler, decodeCaptureStatus, encodeIntervalCapture, encodeSingleCapture, encodeStopCapture } from '../sources/modules/photoProtocol';
import { canEnqueueAnalysis, responseText } from '../sources/modules/providers';
import { retainRecentSessions } from '../sources/modules/sessionStorage';
import { RECONNECT_DELAYS, findStoredDevice } from '../sources/modules/useDevice';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function equal(actual: unknown, expected: unknown, message: string): void {
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

equal(Array.from(encodeSingleCapture()), [0xff], 'legacy-compatible single capture command');
equal(Array.from(encodeStopCapture()), [0], 'legacy-compatible stop capture command');
equal(Array.from(encodeIntervalCapture(30)), [30], 'legacy-compatible interval command');
equal(Array.from(encodeIntervalCapture(300)), [3, 44, 1], '300 second interval command');
equal(decodeCaptureStatus(new Uint8Array([2, 30, 0])), { mode: 'interval', intervalSeconds: 30 }, 'capture status');

const assembler = new PhotoAssembler(true);
assert(assembler.push(0, new Uint8Array([2, 10, 11])) === null, 'first packet should not complete');
assert(assembler.push(1, new Uint8Array([12, 13])) === null, 'second packet should not complete');
const completed = assembler.push(null, new Uint8Array());
assert(completed, 'terminator should complete frame');
equal(Array.from(completed.data), [10, 11, 12, 13], 'assembled frame bytes');
equal(completed.orientation, 2, 'assembled orientation');
const legacyAssembler = new PhotoAssembler(false);
legacyAssembler.push(0, new Uint8Array([20, 21]));
const legacyFrame = legacyAssembler.push(null, new Uint8Array());
equal(legacyFrame?.orientation, 2, 'legacy firmware rotation');

equal(RECONNECT_DELAYS, [1000, 2000, 4000], 'reconnect backoff');
const devices = [{ id: 'first' }, { id: 'target' }] as BluetoothDevice[];
equal(findStoredDevice(devices, 'target')?.id, 'target', 'stored device restoration');
assert(findStoredDevice(devices, 'missing') === null, 'missing stored device');

assert(canEnqueueAnalysis(2, 3), 'queue should accept third item');
assert(!canEnqueueAnalysis(3, 3), 'queue should reject overflow');
equal(responseText({ output_text: ' OK ' }), 'OK', 'Responses API output_text');
equal(responseText({ output: [{ content: [{ type: 'output_text', text: 'vision result' }] }] }), 'vision result', 'Responses API content');

const retained = retainRecentSessions(Array.from({ length: 12 }, (_, index) => ({ id: index, updatedAt: index })));
equal(retained.map(item => item.id), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2], 'session retention');

console.log('omiGlass console assertions passed');
