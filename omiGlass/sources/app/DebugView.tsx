import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { configuredProviders, testProvider } from '../modules/providers';
import { useDebug } from '../modules/useDebug';
import { DiagnosticEntry, ModelSettings } from '../types/console';

interface DebugViewProps {
    device: BluetoothRemoteGATTServer | null;
    settings: ModelSettings;
    diagnostics: DiagnosticEntry[];
    onSettingsChange: (settings: ModelSettings) => void;
    onClearSessions: () => void;
    onClose: () => void;
}

const FRAME_SIZES = [
    ['96x96', 0], ['QQVGA', 1], ['QCIF', 2], ['HQVGA', 3], ['240x240', 4],
    ['QVGA', 5], ['CIF', 6], ['HVGA', 7], ['VGA', 8], ['SVGA', 9],
] as const;

function Field(props: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <TextInput value={props.value} onChangeText={props.onChange} style={styles.input} placeholderTextColor="#587074" />
        </View>
    );
}

function OptionRow<T extends string>(props: {
    label: string;
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (value: T) => void;
}) {
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <View style={styles.options}>
                {props.options.map(option => (
                    <Pressable
                        key={option.value}
                        onPress={() => props.onChange(option.value)}
                        style={[styles.option, props.value === option.value && styles.optionActive]}
                    >
                        <Text style={[styles.optionText, props.value === option.value && styles.optionTextActive]}>{option.label}</Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

function CameraControls({ device }: { device: BluetoothRemoteGATTServer }) {
    const camera = useDebug(device);
    const [quality, setQuality] = React.useState(12);
    const [brightness, setBrightness] = React.useState(0);
    const [contrast, setContrast] = React.useState(0);
    const [whiteBalance, setWhiteBalance] = React.useState(true);
    const [mirror, setMirror] = React.useState(false);

    const step = (value: number, delta: number, min: number, max: number, apply: (next: number) => void) => {
        const next = Math.max(min, Math.min(max, value + delta));
        apply(next);
        return next;
    };

    return (
        <View>
            <View style={styles.frameGrid}>
                {FRAME_SIZES.map(([label, value]) => (
                    <Pressable key={label} style={styles.frameOption} onPress={() => camera.setFramesize(value)}>
                        <Text style={styles.frameText}>{label}</Text>
                    </Pressable>
                ))}
            </View>
            <Stepper label="JPEG 质量" value={quality} onMinus={() => setQuality(value => step(value, -1, 10, 63, camera.setQuality))} onPlus={() => setQuality(value => step(value, 1, 10, 63, camera.setQuality))} />
            <Stepper label="亮度" value={brightness} onMinus={() => setBrightness(value => step(value, -1, -2, 2, camera.setBrightness))} onPlus={() => setBrightness(value => step(value, 1, -2, 2, camera.setBrightness))} />
            <Stepper label="对比度" value={contrast} onMinus={() => setContrast(value => step(value, -1, -2, 2, camera.setContrast))} onPlus={() => setContrast(value => step(value, 1, -2, 2, camera.setContrast))} />
            <Toggle label="自动白平衡" value={whiteBalance} onChange={value => { setWhiteBalance(value); camera.toggleWhitebal(value); }} />
            <Toggle label="水平镜像" value={mirror} onChange={value => { setMirror(value); camera.toggleHmirror(value); }} />
            <View style={styles.deviceCard}>
                <InfoLine label="固件" value={camera.firmwareVersion || '读取中'} />
                <InfoLine label="硬件" value={camera.hardwareVersion || '读取中'} />
                <InfoLine label="序列号" value={camera.serialNumber || '读取中'} />
                <InfoLine label="电量" value={camera.batteryLevel === null ? '未知' : `${camera.batteryLevel}%`} />
            </View>
        </View>
    );
}

function Stepper(props: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
    return (
        <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>{props.label}</Text>
            <View style={styles.stepper}>
                <Pressable style={styles.stepButton} onPress={props.onMinus}><Text style={styles.stepText}>-</Text></Pressable>
                <Text style={styles.stepValue}>{props.value}</Text>
                <Pressable style={styles.stepButton} onPress={props.onPlus}><Text style={styles.stepText}>+</Text></Pressable>
            </View>
        </View>
    );
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
    return (
        <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>{props.label}</Text>
            <Switch value={props.value} onValueChange={props.onChange} trackColor={{ false: '#24373a', true: '#0f5e62' }} thumbColor={props.value ? '#65f2e8' : '#809497'} />
        </View>
    );
}

function InfoLine(props: { label: string; value: string }) {
    return <View style={styles.infoLine}><Text style={styles.infoLabel}>{props.label}</Text><Text style={styles.infoValue}>{props.value}</Text></View>;
}

export const DebugView = React.memo((props: DebugViewProps) => {
    const [testing, setTesting] = React.useState<string | null>(null);
    const [testResult, setTestResult] = React.useState('');
    const update = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => {
        props.onSettingsChange({ ...props.settings, [key]: value });
    };
    const runTest = async (provider: 'openai' | 'groq' | 'ollama') => {
        setTesting(provider);
        setTestResult('');
        try {
            setTestResult(`${provider.toUpperCase()}：${await testProvider(provider, props.settings)}`);
        } catch (error) {
            setTestResult(String(error));
        } finally {
            setTesting(null);
        }
    };

    return (
        <Modal transparent animationType="fade" onRequestClose={props.onClose}>
            <View style={styles.overlay}>
                <Pressable style={styles.scrim} onPress={props.onClose} />
                <View style={styles.drawer}>
                    <View style={styles.header}>
                        <View><Text style={styles.kicker}>SYSTEM CONTROL</Text><Text style={styles.title}>高级控制台</Text></View>
                        <Pressable style={styles.close} onPress={props.onClose}><Text style={styles.closeText}>X</Text></Pressable>
                    </View>
                    <ScrollView contentContainerStyle={styles.content}>
                        <Text style={styles.sectionTitle}>模型流水线</Text>
                        <OptionRow label="处理模式" value={props.settings.mode} options={[{ value: 'staged', label: '分阶段' }, { value: 'direct', label: 'OpenAI 直连' }]} onChange={value => update('mode', value)} />
                        <OptionRow label="视觉模型" value={props.settings.visionProvider} options={[{ value: 'ollama', label: 'Ollama' }, { value: 'openai', label: 'OpenAI' }]} onChange={value => update('visionProvider', value)} />
                        <OptionRow label="推理模型" value={props.settings.reasoningProvider} options={[{ value: 'groq', label: 'Groq' }, { value: 'openai', label: 'OpenAI' }, { value: 'ollama', label: 'Ollama' }]} onChange={value => update('reasoningProvider', value)} />
                        <Field label="Ollama URL" value={props.settings.ollamaUrl} onChange={value => update('ollamaUrl', value)} />
                        <Field label="Ollama 视觉模型" value={props.settings.ollamaVisionModel} onChange={value => update('ollamaVisionModel', value)} />
                        <Field label="Ollama 推理模型" value={props.settings.ollamaReasoningModel} onChange={value => update('ollamaReasoningModel', value)} />
                        <Field label="OpenAI 模型" value={props.settings.openAIModel} onChange={value => update('openAIModel', value)} />
                        <Field label="Groq 模型" value={props.settings.groqModel} onChange={value => update('groqModel', value)} />
                        <View style={styles.providerRow}>
                            {(['openai', 'groq', 'ollama'] as const).map(provider => (
                                <Pressable key={provider} style={styles.testButton} onPress={() => runTest(provider)} disabled={testing !== null}>
                                    {testing === provider ? <ActivityIndicator color="#65f2e8" size="small" /> : <Text style={styles.testText}>{provider} {configuredProviders[provider] ? 'READY' : 'LOCAL'}</Text>}
                                </Pressable>
                            ))}
                        </View>
                        {testResult ? <Text style={styles.testResult}>{testResult}</Text> : null}
                        <Text style={styles.warning}>云端 Key 来自 EXPO_PUBLIC 环境变量，仅适用于本地开发，禁止公开部署。</Text>

                        <Text style={styles.sectionTitle}>相机与设备</Text>
                        {props.device ? <CameraControls device={props.device} /> : <Text style={styles.empty}>连接眼镜后可调整相机参数。</Text>}

                        <Text style={styles.sectionTitle}>诊断日志</Text>
                        <View style={styles.logs}>
                            {props.diagnostics.length === 0 ? <Text style={styles.empty}>暂无日志</Text> : props.diagnostics.map(entry => (
                                <View key={entry.id} style={styles.logLine}>
                                    <Text style={[styles.logLevel, entry.level === 'error' && styles.logError, entry.level === 'warn' && styles.logWarn]}>{entry.level.toUpperCase()}</Text>
                                    <Text style={styles.logTime}>{new Date(entry.timestamp).toLocaleTimeString('zh-CN')}</Text>
                                    <Text style={styles.logMessage}>{entry.message.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')}</Text>
                                </View>
                            ))}
                        </View>
                        <Pressable style={styles.dangerButton} onPress={props.onClearSessions}><Text style={styles.dangerText}>清空本地会话</Text></Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
});

const styles = StyleSheet.create({
    overlay: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1, 7, 8, 0.72)' },
    drawer: { width: 'min(520px, 94vw)' as never, height: '100%', backgroundColor: '#0a1517', borderLeftWidth: 1, borderLeftColor: '#214247' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 24, borderBottomWidth: 1, borderBottomColor: '#173034' },
    kicker: { color: '#49b8b3', fontSize: 10, letterSpacing: 2.4, fontFamily: 'Cascadia Mono' },
    title: { color: '#effcf9', fontSize: 24, fontWeight: '700', marginTop: 5, fontFamily: 'Bahnschrift' },
    close: { width: 36, height: 36, borderWidth: 1, borderColor: '#315257', alignItems: 'center', justifyContent: 'center' },
    closeText: { color: '#a8bfbe', fontFamily: 'Cascadia Mono' },
    content: { padding: 24, paddingBottom: 60 },
    sectionTitle: { color: '#65f2e8', fontSize: 12, letterSpacing: 1.8, fontWeight: '700', marginTop: 8, marginBottom: 16, fontFamily: 'Cascadia Mono' },
    field: { marginBottom: 15 }, label: { color: '#7e999b', fontSize: 11, marginBottom: 7, letterSpacing: 0.7 },
    input: { backgroundColor: '#0e2023', borderWidth: 1, borderColor: '#244247', color: '#e8f5f2', paddingHorizontal: 12, paddingVertical: 10, fontFamily: 'Cascadia Mono', fontSize: 12 },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    option: { paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#29484d', backgroundColor: '#0c1b1d' },
    optionActive: { backgroundColor: '#65f2e8', borderColor: '#65f2e8' }, optionText: { color: '#8ca4a5', fontSize: 11 }, optionTextActive: { color: '#061011', fontWeight: '700' },
    providerRow: { flexDirection: 'row', gap: 8, marginTop: 4 }, testButton: { flex: 1, minHeight: 38, borderWidth: 1, borderColor: '#315257', alignItems: 'center', justifyContent: 'center' }, testText: { color: '#b7cdca', fontSize: 9, fontFamily: 'Cascadia Mono' },
    testResult: { color: '#9cb7b4', backgroundColor: '#071012', padding: 12, marginTop: 10, fontFamily: 'Cascadia Mono', fontSize: 11 },
    warning: { color: '#e9b65c', backgroundColor: '#241d0f', borderLeftWidth: 2, borderLeftColor: '#e9b65c', padding: 12, marginTop: 12, fontSize: 11, lineHeight: 17 },
    frameGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 14 }, frameOption: { borderWidth: 1, borderColor: '#28484c', paddingHorizontal: 10, paddingVertical: 7 }, frameText: { color: '#a8bfbe', fontSize: 10, fontFamily: 'Cascadia Mono' },
    controlRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#172c30' }, controlLabel: { color: '#9eb5b3', fontSize: 12 },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 }, stepButton: { width: 28, height: 28, borderWidth: 1, borderColor: '#315257', alignItems: 'center', justifyContent: 'center' }, stepText: { color: '#65f2e8', fontSize: 16 }, stepValue: { color: '#eef8f6', width: 30, textAlign: 'center', fontFamily: 'Cascadia Mono' },
    deviceCard: { backgroundColor: '#071012', padding: 12, marginTop: 14 }, infoLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7 }, infoLabel: { color: '#607a7c', fontSize: 11 }, infoValue: { color: '#b8cdca', fontFamily: 'Cascadia Mono', fontSize: 11 },
    logs: { backgroundColor: '#061012', borderWidth: 1, borderColor: '#183237', padding: 10, maxHeight: 320 }, logLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 5 }, logLevel: { color: '#65f2e8', width: 38, fontSize: 8, fontFamily: 'Cascadia Mono' }, logWarn: { color: '#e9b65c' }, logError: { color: '#ff8075' }, logTime: { color: '#496568', width: 62, fontSize: 9, fontFamily: 'Cascadia Mono' }, logMessage: { color: '#8ca7a6', flex: 1, fontSize: 10, lineHeight: 15, fontFamily: 'Cascadia Mono' },
    empty: { color: '#60787a', fontSize: 12, paddingVertical: 16 }, dangerButton: { marginTop: 22, borderWidth: 1, borderColor: '#703d3b', padding: 12, alignItems: 'center' }, dangerText: { color: '#ff8d83', fontSize: 12, fontWeight: '700' },
});
