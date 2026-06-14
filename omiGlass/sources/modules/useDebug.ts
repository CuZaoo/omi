import * as React from 'react';
import axios from 'axios';
import { keys } from '../keys';

const CAMERA_CONTROL_UUID = '19b10007-e8f2-537e-4f6c-d104768a1214';

// Camera control command bytes (must match firmware config.h)
const CMD = {
  SET_FRAMESIZE: 0x01,
  SET_QUALITY: 0x02,
  SET_BRIGHTNESS: 0x03,
  SET_CONTRAST: 0x04,
  SET_SATURATION: 0x05,
  SET_AE_LEVEL: 0x06,
  SET_AEC_VALUE: 0x07,
  SET_GAINCEILING: 0x08,
  SET_WHITEBAL: 0x09,
  SET_AWB_GAIN: 0x0A,
  SET_HMIRROR: 0x0B,
  SET_VFLIP: 0x0C,
  SET_AEC: 0x0D,
  SET_AGC: 0x0E,
};

async function writeCameraCommand(device: BluetoothRemoteGATTServer, cmd: number, ...params: number[]) {
  try {
    const service = await device.getPrimaryService('19B10000-E8F2-537E-4F6C-D104768A1214'.toLowerCase());
    const char = await service.getCharacteristic(CAMERA_CONTROL_UUID);
    await char.writeValue(new Uint8Array([cmd, ...params]));
  } catch (e) {
    console.error('Camera command failed:', cmd, e);
  }
}

export function useDebug(device: BluetoothRemoteGATTServer) {
  const [firmwareVersion, setFirmwareVersion] = React.useState('');
  const [hardwareVersion, setHardwareVersion] = React.useState('');
  const [serialNumber, setSerialNumber] = React.useState('');
  const [batteryLevel, setBatteryLevel] = React.useState<number | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const infoService = await device.getPrimaryService('device_information');
        const fw = await infoService.getCharacteristic('firmware_revision_string');
        setFirmwareVersion(new TextDecoder().decode(await fw.readValue()));
        const hw = await infoService.getCharacteristic('hardware_revision_string');
        setHardwareVersion(new TextDecoder().decode(await hw.readValue()));
        const sn = await infoService.getCharacteristic('serial_number_string');
        setSerialNumber(new TextDecoder().decode(await sn.readValue()));
      } catch (e) {
        console.error('Failed to read device info', e);
      }
    })();
  }, [device]);

  React.useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    (async () => {
      try {
        const batteryService = await device.getPrimaryService(0x180f);
        const batteryChar = await batteryService.getCharacteristic(0x2a19);
        const readBattery = async () => {
          try {
            const v = await batteryChar.readValue();
            setBatteryLevel(v.getUint8(0));
          } catch { }
        };
        await readBattery();
        interval = setInterval(readBattery, 30000);
      } catch (e) {
        console.error('Battery service not available', e);
      }
    })();
    return () => clearInterval(interval);
  }, [device]);

  const setFramesize = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_FRAMESIZE, v), [device]);
  const setQuality = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_QUALITY, v), [device]);
  const setBrightness = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_BRIGHTNESS, v + 128), [device]);
  const setContrast = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_CONTRAST, v + 128), [device]);
  const setSaturation = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_SATURATION, v + 128), [device]);
  const setAeLevel = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_AE_LEVEL, v + 128), [device]);
  const setAecValue = React.useCallback((v: number) => {
    writeCameraCommand(device, CMD.SET_AEC_VALUE, v & 0xFF, (v >> 8) & 0xFF);
  }, [device]);
  const setGainceiling = React.useCallback((v: number) => writeCameraCommand(device, CMD.SET_GAINCEILING, v), [device]);
  const toggleWhitebal = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_WHITEBAL, on ? 1 : 0), [device]);
  const toggleAwbGain = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_AWB_GAIN, on ? 1 : 0), [device]);
  const toggleHmirror = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_HMIRROR, on ? 1 : 0), [device]);
  const toggleVflip = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_VFLIP, on ? 1 : 0), [device]);
  const toggleAec = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_AEC, on ? 1 : 0), [device]);
  const toggleAgc = React.useCallback((on: boolean) => writeCameraCommand(device, CMD.SET_AGC, on ? 1 : 0), [device]);

  const takeSinglePhoto = React.useCallback(async () => {
    try {
      const service = await device.getPrimaryService('19B10000-E8F2-537E-4F6C-D104768A1214'.toLowerCase());
      const controlChar = await service.getCharacteristic('19b10006-e8f2-537e-4f6c-d104768a1214');
      await controlChar.writeValue(new Uint8Array([0xFF]));
    } catch (e) {
      console.error('Failed to trigger photo', e);
    }
  }, [device]);

  return {
    firmwareVersion, hardwareVersion, serialNumber, batteryLevel,
    setFramesize, setQuality, setBrightness, setContrast, setSaturation,
    setAeLevel, setAecValue, setGainceiling,
    toggleWhitebal, toggleAwbGain, toggleHmirror, toggleVflip, toggleAec, toggleAgc,
    takeSinglePhoto,
  };
}

export async function testOpenAI(): Promise<string> {
  if (!keys.openai) return 'No API key configured';
  try {
    const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply with just the word OK' }],
    }, {
      headers: { Authorization: `Bearer ${keys.openai}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return resp.data.choices[0].message.content;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function testGroq(): Promise<string> {
  if (!keys.groq) return 'No API key configured';
  try {
    const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-70b-8192',
      messages: [{ role: 'user', content: 'Reply with just the word OK' }],
    }, {
      headers: { Authorization: `Bearer ${keys.groq}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return resp.data.choices[0].message.content;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function testOllama(): Promise<string> {
  if (!keys.ollama) return 'No Ollama URL configured';
  try {
    const resp = await axios.post(keys.ollama, {
      model: 'llama3',
      messages: [{ role: 'user', content: 'Reply with just the word OK' }],
      stream: false,
    }, { timeout: 10000 });
    return resp.data.message?.content ?? JSON.stringify(resp.data);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function testLocalLLM(baseUrl: string): Promise<string> {
  if (!baseUrl) return 'No URL provided';
  try {
    const resp = await axios.post(`${baseUrl}/v1/chat/completions`, {
      model: 'local',
      messages: [{ role: 'user', content: 'Reply with just the word OK' }],
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return resp.data.choices?.[0]?.message?.content ?? JSON.stringify(resp.data);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function sendPrompt(provider: string, prompt: string): Promise<string> {
  switch (provider) {
    case 'openai': {
      if (!keys.openai) return 'No API key';
      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      }, {
        headers: { Authorization: `Bearer ${keys.openai}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      return JSON.stringify(resp.data, null, 2);
    }
    case 'groq': {
      if (!keys.groq) return 'No API key';
      const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama3-70b-8192',
        messages: [{ role: 'user', content: prompt }],
      }, {
        headers: { Authorization: `Bearer ${keys.groq}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      return JSON.stringify(resp.data, null, 2);
    }
    case 'ollama': {
      if (!keys.ollama) return 'No URL';
      const resp = await axios.post(keys.ollama, {
        model: 'llama3',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }, { timeout: 30000 });
      return JSON.stringify(resp.data, null, 2);
    }
    default:
      return 'Unknown provider';
  }
}
