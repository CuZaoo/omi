const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function currentSsid(output) {
    const match = output.match(/^\s*SSID\s*:\s*(.+?)\s*$/im);
    return match ? match[1].trim() : '';
}

function visibleNetworks(output, connectedSsid) {
    const networks = [];
    let current = null;

    for (const line of output.split(/\r?\n/)) {
        const ssidMatch = line.match(/^\s*SSID\s+\d+\s*:\s*(.*?)\s*$/i);
        if (ssidMatch) {
            if (current?.ssid) networks.push(current);
            current = { ssid: ssidMatch[1].trim(), signal: 0, bands: new Set() };
            continue;
        }
        const signalMatch = line.match(/^\s*(?:Signal|信号)\s*:\s*(\d+)%/i);
        if (current && signalMatch) {
            current.signal = Math.max(current.signal, Number(signalMatch[1]));
        }
        const bandMatch = line.match(/^\s*(?:Band|波段)\s*:\s*(.+?)\s*$/i);
        if (current && bandMatch) {
            current.bands.add(bandMatch[1].trim());
        }
    }
    if (current?.ssid) networks.push(current);

    return networks
        .filter(network => network.ssid)
        .map(network => {
            const bands = [...network.bands];
            return {
                ssid: network.ssid,
                signal: network.signal,
                rssi: Math.round(-100 + network.signal / 2),
                band: bands.join(' / '),
                compatible: bands.length === 0 || bands.some(band => band.includes('2.4')),
                connected: network.ssid === connectedSsid,
            };
        })
        .sort((left, right) => Number(right.connected) - Number(left.connected) || right.signal - left.signal);
}

async function scanWindowsWifi() {
    const [{ stdout: interfaceOutput }, { stdout: networkOutput }] = await Promise.all([
        execFileAsync('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', windowsHide: true }),
        execFileAsync('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], { encoding: 'utf8', windowsHide: true }),
    ]);
    const connectedSsid = currentSsid(interfaceOutput);
    return { currentSsid: connectedSsid, networks: visibleNetworks(networkOutput, connectedSsid) };
}

module.exports = { currentSsid, visibleNetworks, scanWindowsWifi };
