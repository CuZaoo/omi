import * as React from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Switch, ActivityIndicator } from 'react-native';
import { Theme } from './components/theme';
import { useDebug, testOpenAI, testGroq, testOllama, testLocalLLM, sendPrompt } from '../modules/useDebug';

type TabName = 'camera' | 'llm' | 'info';

const FRAMESIZE_OPTIONS = [
  { label: '96x96', value: 0 },
  { label: 'QQVGA', value: 1 },
  { label: 'QCIF', value: 2 },
  { label: 'HQVGA', value: 3 },
  { label: '240x240', value: 4 },
  { label: 'QVGA', value: 5 },
  { label: 'CIF', value: 6 },
  { label: 'HVGA', value: 7 },
  { label: 'VGA', value: 8 },
  { label: 'SVGA', value: 9 },
  { label: 'XGA', value: 10 },
];

function TabBar({ active, onSelect }: { active: TabName; onSelect: (t: TabName) => void }) {
  const tabs: { key: TabName; label: string }[] = [
    { key: 'camera', label: 'Camera' },
    { key: 'llm', label: 'LLM' },
    { key: 'info', label: 'Info' },
  ];
  return (
    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#333' }}>
      {tabs.map(t => (
        <Pressable
          key={t.key}
          onPress={() => onSelect(t.key)}
          style={{
            flex: 1, paddingVertical: 12, alignItems: 'center',
            borderBottomWidth: 2, borderBottomColor: active === t.key ? '#fff' : 'transparent',
          }}
        >
          <Text style={{ color: active === t.key ? '#fff' : '#666', fontSize: 14, fontWeight: '600' }}>
            {t.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function SliderControl({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>{label}: {value}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          onPress={() => onChange(Math.max(min, value - (step ?? 1)))}
          style={{ width: 36, height: 36, backgroundColor: '#333', borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: '#fff', fontSize: 18 }}>-</Text>
        </Pressable>
        <View style={{ flex: 1, height: 4, backgroundColor: '#333', marginHorizontal: 8, borderRadius: 2 }}>
          <View style={{
            width: `${((value - min) / (max - min)) * 100}%`, height: '100%',
            backgroundColor: '#fff', borderRadius: 2,
          }} />
        </View>
        <Pressable
          onPress={() => onChange(Math.min(max, value + (step ?? 1)))}
          style={{ width: 36, height: 36, backgroundColor: '#333', borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ color: '#fff', fontSize: 18 }}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ToggleControl({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <Text style={{ color: '#aaa', fontSize: 14 }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: '#333', true: '#666' }} thumbColor={value ? '#fff' : '#888'} />
    </View>
  );
}

function CameraTab({ device }: { device: BluetoothRemoteGATTServer }) {
  const ctrl = useDebug(device);

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 12 }}>Frame Size</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
        {FRAMESIZE_OPTIONS.map(o => (
          <Pressable
            key={o.value}
            onPress={() => ctrl.setFramesize(o.value)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, marginRight: 8,
              backgroundColor: '#222', borderRadius: 8,
              borderWidth: 1, borderColor: '#444',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 12 }}>{o.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <SliderControl label="JPEG Quality (lower=better)" value={12} min={10} max={63} step={1} onChange={ctrl.setQuality} />
      <SliderControl label="Brightness" value={0} min={-2} max={2} step={1} onChange={ctrl.setBrightness} />
      <SliderControl label="Contrast" value={0} min={-2} max={2} step={1} onChange={ctrl.setContrast} />
      <SliderControl label="Saturation" value={0} min={-2} max={2} step={1} onChange={ctrl.setSaturation} />
      <SliderControl label="AE Level" value={0} min={-2} max={2} step={1} onChange={ctrl.setAeLevel} />
      <SliderControl label="AEC Value" value={300} min={0} max={1200} step={50} onChange={ctrl.setAecValue} />
      <SliderControl label="Gain Ceiling" value={2} min={0} max={6} step={1} onChange={ctrl.setGainceiling} />

      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 12 }}>Toggles</Text>
      <ToggleControl label="Auto White Balance" value={true} onChange={ctrl.toggleWhitebal} />
      <ToggleControl label="AWB Gain" value={true} onChange={ctrl.toggleAwbGain} />
      <ToggleControl label="Auto Exposure (AEC)" value={true} onChange={ctrl.toggleAec} />
      <ToggleControl label="Auto Gain (AGC)" value={true} onChange={ctrl.toggleAgc} />
      <ToggleControl label="Horizontal Mirror" value={false} onChange={ctrl.toggleHmirror} />
      <ToggleControl label="Vertical Flip" value={false} onChange={ctrl.toggleVflip} />

      <Pressable
        onPress={ctrl.takeSinglePhoto}
        style={{
          marginTop: 16, backgroundColor: '#fff', paddingVertical: 14, borderRadius: 12, alignItems: 'center',
        }}
      >
        <Text style={{ color: '#000', fontSize: 16, fontWeight: '700' }}>Take Single Photo</Text>
      </Pressable>
    </ScrollView>
  );
}

function LLMTab() {
  const [selectedProvider, setSelectedProvider] = React.useState<'openai' | 'groq' | 'ollama' | 'local'>('openai');
  const [prompt, setPrompt] = React.useState('');
  const [response, setResponse] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [localUrl, setLocalUrl] = React.useState('');
  const [testResult, setTestResult] = React.useState('');

  const providers = ['openai', 'groq', 'ollama', 'local'] as const;

  const runTest = async () => {
    setTestResult('Testing...');
    let result: string;
    switch (selectedProvider) {
      case 'openai': result = await testOpenAI(); break;
      case 'groq': result = await testGroq(); break;
      case 'ollama': result = await testOllama(); break;
      case 'local': result = await testLocalLLM(localUrl || 'http://localhost:8001'); break;
    }
    setTestResult(result);
  };

  const sendPromptHandler = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setResponse('');
    const result = await sendPrompt(selectedProvider, prompt);
    setResponse(result);
    setLoading(false);
  };

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: '#fff', fontSize: 14, marginBottom: 8 }}>Provider</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 16 }}>
        {providers.map(p => (
          <Pressable
            key={p}
            onPress={() => setSelectedProvider(p)}
            style={{
              paddingHorizontal: 16, paddingVertical: 8, marginRight: 8, marginBottom: 8,
              backgroundColor: selectedProvider === p ? '#fff' : '#222',
              borderRadius: 8,
            }}
          >
            <Text style={{ color: selectedProvider === p ? '#000' : '#fff', fontSize: 13, fontWeight: '600' }}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>

      {selectedProvider === 'local' && (
        <View style={{ marginBottom: 16 }}>
          <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Local LLM URL</Text>
          <TextInput
            value={localUrl}
            onChangeText={setLocalUrl}
            placeholder="http://localhost:8001"
            placeholderTextColor="#555"
            style={{
              backgroundColor: '#222', color: '#fff', padding: 10, borderRadius: 8,
              borderWidth: 1, borderColor: '#444', fontSize: 14,
            }}
          />
        </View>
      )}

      <Pressable
        onPress={runTest}
        style={{
          backgroundColor: '#333', paddingVertical: 10, borderRadius: 8, alignItems: 'center', marginBottom: 16,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 14 }}>Test Connection</Text>
      </Pressable>

      {testResult ? (
        <View style={{ backgroundColor: '#1a1a1a', padding: 10, borderRadius: 8, marginBottom: 16 }}>
          <Text style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Test Result:</Text>
          <Text style={{ color: '#fff', fontSize: 13 }}>{testResult}</Text>
        </View>
      ) : null}

      <Text style={{ color: '#fff', fontSize: 14, marginBottom: 8 }}>Custom Prompt</Text>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder="Enter a test prompt..."
        placeholderTextColor="#555"
        multiline
        style={{
          backgroundColor: '#222', color: '#fff', padding: 10, borderRadius: 8,
          borderWidth: 1, borderColor: '#444', fontSize: 14, minHeight: 80, textAlignVertical: 'top',
        }}
      />

      <Pressable
        onPress={sendPromptHandler}
        disabled={loading}
        style={{
          marginTop: 8, backgroundColor: '#fff', paddingVertical: 12, borderRadius: 8, alignItems: 'center',
          opacity: loading ? 0.5 : 1,
        }}
      >
        {loading ? (
          <ActivityIndicator color="#000" size="small" />
        ) : (
          <Text style={{ color: '#000', fontSize: 14, fontWeight: '600' }}>Send</Text>
        )}
      </Pressable>

      {response ? (
        <View style={{ backgroundColor: '#1a1a1a', padding: 10, borderRadius: 8, marginTop: 12, marginBottom: 24 }}>
          <Text style={{ color: '#8f8', fontSize: 11, marginBottom: 4 }}>Raw Response:</Text>
          <Text style={{ color: '#ccc', fontSize: 11, fontFamily: 'monospace' }}>{response}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function InfoTab({ device }: { device: BluetoothRemoteGATTServer }) {
  const ctrl = useDebug(device);

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 }}>Device Information</Text>

      <InfoRow label="Firmware" value={ctrl.firmwareVersion || 'Unknown'} />
      <InfoRow label="Hardware" value={ctrl.hardwareVersion || 'Unknown'} />
      <InfoRow label="Serial" value={ctrl.serialNumber || 'Unknown'} />
      <InfoRow label="Battery" value={ctrl.batteryLevel !== null ? `${ctrl.batteryLevel}%` : 'Unknown'} />

      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 24, marginBottom: 12 }}>API Keys</Text>
      <InfoRow label="OpenAI" value={maskKey(process.env.EXPO_PUBLIC_OPENAI_API_KEY)} />
      <InfoRow label="Groq" value={maskKey(process.env.EXPO_PUBLIC_GROQ_API_KEY)} />
      <InfoRow label="Ollama URL" value={process.env.EXPO_PUBLIC_OLLAMA_API_URL || 'Not set'} />
    </ScrollView>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#222' }}>
      <Text style={{ color: '#aaa', fontSize: 13 }}>{label}</Text>
      <Text style={{ color: '#fff', fontSize: 13 }}>{value}</Text>
    </View>
  );
}

function maskKey(key?: string): string {
  if (!key || key.length < 8) return 'Not set';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export const DebugView = React.memo((props: { device: BluetoothRemoteGATTServer; onClose: () => void }) => {
  const [tab, setTab] = React.useState<TabName>('camera');

  return (
    <View style={{ flex: 1, backgroundColor: Theme.background }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>Debug</Text>
        <Pressable onPress={props.onClose} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 22 }}>✕</Text>
        </Pressable>
      </View>
      <TabBar active={tab} onSelect={setTab} />
      {tab === 'camera' && <CameraTab device={props.device} />}
      {tab === 'llm' && <LLMTab />}
      {tab === 'info' && <InfoTab device={props.device} />}
    </View>
  );
});
