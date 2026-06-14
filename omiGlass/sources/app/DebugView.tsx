import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { configuredProviders, testProvider } from '../modules/providers';
import { CameraSettings, useDebug } from '../modules/useDebug';
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
    ['QVGA', 5], ['CIF', 6], ['HVGA', 7], ['VGA', 8], ['SVGA', 9], ['XGA', 10],
    ['HD', 11], ['SXGA', 12], ['UXGA', 13],
] as const;

const WB_MODES = [
    { value: 0, label: '自动' }, { value: 1, label: '晴天' }, { value: 2, label: '阴天' },
    { value: 3, label: '办公室' }, { value: 4, label: '家中' },
];

const EFFECTS = [
    { value: 0, label: '无' }, { value: 1, label: '负片' }, { value: 2, label: '灰度' },
    { value: 3, label: '红色调' }, { value: 4, label: '绿色调' }, { value: 5, label: '蓝色调' },
    { value: 6, label: '复古' },
];

const GAIN_CEILINGS = [2, 4, 8, 16, 32, 64, 128].map((label, value) => ({ value, label: `${label}x` }));

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

function NumberOptions(props: { label: string; value: number; options: Array<{ value: number; label: string }>; onChange: (value: number) => void }) {
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{props.label}</Text>
            <View style={styles.options}>
                {props.options.map(option => (
                    <Pressable key={option.value} onPress={() => props.onChange(option.value)} style={[styles.option, props.value === option.value && styles.optionActive]}>
                        <Text style={[styles.optionText, props.value === option.value && styles.optionTextActive]}>{option.label}</Text>
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

function ControlGroup(props: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <View style={styles.controlGroup}>
            <Text style={styles.groupTitle}>{props.title}</Text>
            {props.hint ? <Text style={styles.groupHint}>{props.hint}</Text> : null}
            {props.children}
        </View>
    );
}

function CameraControls({ device }: { device: BluetoothRemoteGATTServer | null }) {
    const camera = useDebug(device);
    const set = <K extends keyof CameraSettings>(key: K, value: CameraSettings[K]) => void camera.setSetting(key, value);

    return (
        <View>
            <Text style={styles.groupTitle}>快速预设</Text>
            <Text style={styles.groupHint}>单击即可批量应用一组参数。</Text>
            <View style={styles.quickPresetRow}>
                <Pressable style={styles.quickPreset} onPress={() => camera.applyAll({ ...camera.settings, quality: 8, contrast: 1 })} disabled={camera.pending}>
                    <Text style={styles.quickPresetEmoji}>🔍</Text>
                    <Text style={styles.quickPresetLabel}>更清晰</Text>
                    <Text style={styles.quickPresetHint}>q=8, 对比+1</Text>
                </Pressable>
                <Pressable style={styles.quickPreset} onPress={() => camera.applyAll({ ...camera.settings, aeLevel: -1, aecValue: 200 })} disabled={camera.pending}>
                    <Text style={styles.quickPresetEmoji}>🌞</Text>
                    <Text style={styles.quickPresetLabel}>室外</Text>
                    <Text style={styles.quickPresetHint}>曝光-1</Text>
                </Pressable>
                <Pressable style={styles.quickPreset} onPress={() => camera.applyAll({ ...camera.settings, aecValue: 350, gainCeiling: 2 })} disabled={camera.pending}>
                    <Text style={styles.quickPresetEmoji}>💡</Text>
                    <Text style={styles.quickPresetLabel}>室内</Text>
                    <Text style={styles.quickPresetHint}>增益 4x</Text>
                </Pressable>
                <Pressable style={styles.quickPreset} onPress={() => camera.applyAll({ ...camera.settings, saturation: -1, brightness: 1 })} disabled={camera.pending}>
                    <Text style={styles.quickPresetEmoji}>📄</Text>
                    <Text style={styles.quickPresetLabel}>文档</Text>
                    <Text style={styles.quickPresetHint}>去饱和</Text>
                </Pressable>
            </View>
            <View style={styles.presetRow}>
                <Pressable style={styles.presetPrimary} onPress={camera.applyAntiGreen} disabled={camera.pending}>
                    <Text style={styles.presetPrimaryText}>办公室去绿</Text>
                </Pressable>
                <Pressable style={styles.presetButton} onPress={() => camera.applyAll()} disabled={camera.pending}>
                    <Text style={styles.presetText}>应用全部</Text>
                </Pressable>
                <Pressable style={styles.presetButton} onPress={camera.resetDefaults} disabled={camera.pending}>
                    <Text style={styles.presetText}>恢复默认</Text>
                </Pressable>
            </View>
            <Text style={styles.cameraHelp}>{device ? '偏绿优先尝试“办公室去绿”，再在白平衡模式中切换办公室/家中。' : '当前未连接。参数修改会保存在浏览器，连接眼镜后点击“应用全部”。'}高级命令需要更新后的固件。</Text>
            {camera.pending ? <View style={styles.cameraStatus}><ActivityIndicator color="#65f2e8" size="small" /><Text style={styles.cameraStatusText}>正在写入相机配置...</Text></View> : null}
            {camera.error ? <Text style={styles.cameraError}>{camera.error}</Text> : null}
            {camera.lastAppliedAt ? <Text style={styles.cameraSuccess}>已应用：{new Date(camera.lastAppliedAt).toLocaleTimeString('zh-CN')}</Text> : null}

            <ControlGroup title="成像输出" hint="高分辨率会增加 BLE 传输时间和内存占用。">
                <NumberOptions label="分辨率" value={camera.settings.framesize} options={FRAME_SIZES.map(([label, value]) => ({ label, value }))} onChange={value => set('framesize', value)} />
                <NumericControl label="JPEG 质量（越低越清晰）" value={camera.settings.quality} min={10} max={63} step={1} onChange={value => set('quality', value)} />
                <NumericControl label="亮度" value={camera.settings.brightness} min={-2} max={2} step={1} onChange={value => set('brightness', value)} />
                <NumericControl label="对比度" value={camera.settings.contrast} min={-2} max={2} step={1} onChange={value => set('contrast', value)} />
                <NumericControl label="饱和度" value={camera.settings.saturation} min={-2} max={2} step={1} onChange={value => set('saturation', value)} />
                <NumberOptions label="特殊效果" value={camera.settings.specialEffect} options={EFFECTS} onChange={value => set('specialEffect', value)} />
            </ControlGroup>

            <ControlGroup title="白平衡 / 色偏" hint="偏绿通常与环境光源和白平衡模式不匹配有关。">
                <Toggle label="自动白平衡" value={camera.settings.whiteBalance} onChange={value => set('whiteBalance', value)} />
                <Toggle label="自动白平衡增益" value={camera.settings.awbGain} onChange={value => set('awbGain', value)} />
                <NumberOptions label="白平衡模式" value={camera.settings.wbMode} options={WB_MODES} onChange={value => set('wbMode', value)} />
            </ControlGroup>

            <ControlGroup title="曝光" hint="关闭自动曝光后，AEC 数值和曝光等级的影响更明显。">
                <Toggle label="自动曝光 AEC" value={camera.settings.autoExposure} onChange={value => set('autoExposure', value)} />
                <Toggle label="AEC2 DSP" value={camera.settings.aec2} onChange={value => set('aec2', value)} />
                <NumericControl label="曝光等级" value={camera.settings.aeLevel} min={-2} max={2} step={1} onChange={value => set('aeLevel', value)} />
                <NumericControl label="AEC 数值" value={camera.settings.aecValue} min={0} max={1200} step={25} onChange={value => set('aecValue', value)} />
            </ControlGroup>

            <ControlGroup title="增益" hint="关闭自动增益后，可用手动 AGC 增益控制亮度和噪点。">
                <Toggle label="自动增益 AGC" value={camera.settings.autoGain} onChange={value => set('autoGain', value)} />
                <NumericControl label="手动 AGC 增益" value={camera.settings.agcGain} min={0} max={30} step={1} onChange={value => set('agcGain', value)} />
                <NumberOptions label="增益上限" value={camera.settings.gainCeiling} options={GAIN_CEILINGS} onChange={value => set('gainCeiling', value)} />
            </ControlGroup>

            <ControlGroup title="图像处理">
                <Toggle label="坏点校正 BPC" value={camera.settings.bpc} onChange={value => set('bpc', value)} />
                <Toggle label="白点校正 WPC" value={camera.settings.wpc} onChange={value => set('wpc', value)} />
                <Toggle label="Raw Gamma" value={camera.settings.rawGma} onChange={value => set('rawGma', value)} />
                <Toggle label="镜头校正 LENC" value={camera.settings.lensCorrection} onChange={value => set('lensCorrection', value)} />
                <Toggle label="降采样 DCW" value={camera.settings.dcw} onChange={value => set('dcw', value)} />
                <Toggle label="测试彩条" value={camera.settings.colorbar} onChange={value => set('colorbar', value)} />
            </ControlGroup>

            <ControlGroup title="方向">
                <Toggle label="水平镜像" value={camera.settings.horizontalMirror} onChange={value => set('horizontalMirror', value)} />
                <Toggle label="垂直翻转" value={camera.settings.verticalFlip} onChange={value => set('verticalFlip', value)} />
            </ControlGroup>
            <View style={styles.deviceCard}>
                <InfoLine label="固件" value={camera.firmwareVersion || '读取中'} />
                <InfoLine label="硬件" value={camera.hardwareVersion || '读取中'} />
                <InfoLine label="序列号" value={camera.serialNumber || '读取中'} />
                <InfoLine label="电量" value={camera.batteryLevel === null ? '未知' : `${camera.batteryLevel}%`} />
            </View>
        </View>
    );
}

function NumericControl(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
    const [draft, setDraft] = React.useState(String(props.value));
    React.useEffect(() => setDraft(String(props.value)), [props.value]);
    const commit = (raw: string) => {
        const parsed = Number(raw);
        const next = Number.isFinite(parsed) ? Math.max(props.min, Math.min(props.max, parsed)) : props.value;
        setDraft(String(next));
        if (next !== props.value) props.onChange(next);
    };
    return (
        <View style={styles.controlRow}>
            <Text style={styles.controlLabel}>{props.label}</Text>
            <View style={styles.stepper}>
                <Pressable style={styles.stepButton} onPress={() => commit(String(props.value - props.step))}><Text style={styles.stepText}>-</Text></Pressable>
                <TextInput value={draft} onChangeText={setDraft} onEndEditing={() => commit(draft)} onSubmitEditing={() => commit(draft)} keyboardType="numbers-and-punctuation" style={styles.numberInput} />
                <Pressable style={styles.stepButton} onPress={() => commit(String(props.value + props.step))}><Text style={styles.stepText}>+</Text></Pressable>
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

                        <Text style={styles.sectionTitle}>完整相机配置</Text>
                        <CameraControls device={props.device} />

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
    quickPresetRow: { flexDirection: 'row', gap: 8, marginBottom: 14 }, quickPreset: { flex: 1, minHeight: 68, borderWidth: 1, borderColor: '#24474b', backgroundColor: '#0c1f22', alignItems: 'center', justifyContent: 'center', paddingVertical: 8 }, quickPresetEmoji: { fontSize: 18 }, quickPresetLabel: { color: '#d3e6e3', fontSize: 11, fontWeight: '700', marginTop: 4 }, quickPresetHint: { color: '#5f8284', fontSize: 8, marginTop: 2, fontFamily: 'Cascadia Mono' },
    presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
    presetPrimary: { minHeight: 38, paddingHorizontal: 14, backgroundColor: '#65f2e8', alignItems: 'center', justifyContent: 'center' },
    presetPrimaryText: { color: '#061011', fontSize: 11, fontWeight: '800' },
    presetButton: { minHeight: 38, paddingHorizontal: 14, borderWidth: 1, borderColor: '#315257', alignItems: 'center', justifyContent: 'center' },
    presetText: { color: '#b7cdca', fontSize: 11, fontWeight: '700' },
    cameraHelp: { color: '#789294', fontSize: 11, lineHeight: 17, marginBottom: 12 },
    cameraStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#0b2426', padding: 10, marginBottom: 10 },
    cameraStatusText: { color: '#9edbd6', fontSize: 11 },
    cameraError: { color: '#ff9389', backgroundColor: '#291414', borderLeftWidth: 2, borderLeftColor: '#ff6f65', padding: 10, marginBottom: 10, fontSize: 11 },
    cameraSuccess: { color: '#75d9a5', marginBottom: 10, fontSize: 10, fontFamily: 'Cascadia Mono' },
    controlGroup: { backgroundColor: '#09191b', borderWidth: 1, borderColor: '#1b373b', padding: 14, marginBottom: 12 },
    groupTitle: { color: '#d9f6f2', fontSize: 13, fontWeight: '700', letterSpacing: 0.6, marginBottom: 4 },
    groupHint: { color: '#658083', fontSize: 10, lineHeight: 15, marginBottom: 10 },
    controlRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#172c30' }, controlLabel: { color: '#9eb5b3', fontSize: 12 },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 }, stepButton: { width: 28, height: 28, borderWidth: 1, borderColor: '#315257', alignItems: 'center', justifyContent: 'center' }, stepText: { color: '#65f2e8', fontSize: 16 },
    numberInput: { width: 58, minHeight: 30, paddingHorizontal: 6, paddingVertical: 4, color: '#eef8f6', backgroundColor: '#071214', borderWidth: 1, borderColor: '#29484d', textAlign: 'center', fontFamily: 'Cascadia Mono', fontSize: 11 },
    deviceCard: { backgroundColor: '#071012', padding: 12, marginTop: 14 }, infoLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7 }, infoLabel: { color: '#607a7c', fontSize: 11 }, infoValue: { color: '#b8cdca', fontFamily: 'Cascadia Mono', fontSize: 11 },
    logs: { backgroundColor: '#061012', borderWidth: 1, borderColor: '#183237', padding: 10, maxHeight: 320 }, logLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 5 }, logLevel: { color: '#65f2e8', width: 38, fontSize: 8, fontFamily: 'Cascadia Mono' }, logWarn: { color: '#e9b65c' }, logError: { color: '#ff8075' }, logTime: { color: '#496568', width: 62, fontSize: 9, fontFamily: 'Cascadia Mono' }, logMessage: { color: '#8ca7a6', flex: 1, fontSize: 10, lineHeight: 15, fontFamily: 'Cascadia Mono' },
    empty: { color: '#60787a', fontSize: 12, paddingVertical: 16 }, dangerButton: { marginTop: 22, borderWidth: 1, borderColor: '#703d3b', padding: 12, alignItems: 'center' }, dangerText: { color: '#ff8d83', fontSize: 12, fontWeight: '700' },
});
