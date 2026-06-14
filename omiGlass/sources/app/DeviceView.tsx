import * as React from 'react';
import {
    ActivityIndicator,
    Image,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    useWindowDimensions,
    View,
} from 'react-native';
import { DeviceController } from '../modules/useDevice';
import { useGlassController } from '../modules/useGlassController';
import {
    configuredProviders,
    canEnqueueAnalysis,
    DEFAULT_MODEL_SETTINGS,
    describeFrame,
    directVisionQuestion,
    reasonFromDescription,
} from '../modules/providers';
import { clearSessions, createSession, loadLatestSession, MAX_SESSION_FRAMES, saveSession } from '../modules/sessionStorage';
import { ChatMessage, FrameRecord, ModelSettings, PipelineStage, SessionRecord } from '../types/console';
import { toBase64, toBase64Image } from '../utils/base64';
import { DebugView } from './DebugView';

type WorkspaceTab = 'vision' | 'frames' | 'assistant';

const SETTINGS_KEY = 'openglass:modelSettings';
const AUTO_ANALYZE_KEY = 'openglass:autoAnalyze';
const CAPTURE_INTERVAL_KEY = 'openglass:captureInterval';
const MAX_ANALYSIS_QUEUE = 3;

const STAGE_LABELS: Record<PipelineStage['name'], string> = {
    ble: 'BLE',
    assemble: '重组',
    persist: '保存',
    vision: '视觉',
    reasoning: '推理',
};

const STATUS_LABELS: Record<DeviceController['status'], string> = {
    idle: '未连接',
    restoring: '恢复中',
    connecting: '连接中',
    connected: '已连接',
    reconnecting: '重连中',
    error: '连接异常',
    unsupported: '不支持 BLE',
};

function loadSettings(): ModelSettings {
    try {
        return { ...DEFAULT_MODEL_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return DEFAULT_MODEL_SETTINGS;
    }
}

function updateStage(frame: FrameRecord, name: PipelineStage['name'], patch: Partial<PipelineStage>): FrameRecord {
    return {
        ...frame,
        stages: frame.stages.map(stage => stage.name === name ? { ...stage, ...patch } : stage),
    };
}

function elapsed(startedAt: number): number {
    return Math.max(0, Date.now() - startedAt);
}

function IconButton(props: { label: string; onPress: () => void }) {
    return <Pressable onPress={props.onPress} style={styles.iconButton}><Text style={styles.iconButtonText}>{props.label}</Text></Pressable>;
}

function StageStrip({ stages }: { stages: PipelineStage[] }) {
    return (
        <View style={styles.stageStrip}>
            {stages.map((stage, index) => (
                <React.Fragment key={stage.name}>
                    <View style={styles.stageItem}>
                        <View style={[
                            styles.stageDot,
                            stage.status === 'success' && styles.stageSuccess,
                            stage.status === 'running' && styles.stageRunning,
                            stage.status === 'error' && styles.stageError,
                            stage.status === 'skipped' && styles.stageSkipped,
                        ]} />
                        <Text style={styles.stageText}>{STAGE_LABELS[stage.name]}</Text>
                        {stage.durationMs !== undefined ? <Text style={styles.stageTime}>{stage.durationMs}ms</Text> : null}
                    </View>
                    {index < stages.length - 1 ? <View style={styles.stageLine} /> : null}
                </React.Fragment>
            ))}
        </View>
    );
}

export const DeviceView = React.memo(({ deviceController }: { deviceController: DeviceController }) => {
    const { width } = useWindowDimensions();
    const compact = width < 980;
    const phone = width < 620;
    const [activeTab, setActiveTab] = React.useState<WorkspaceTab>('vision');
    const [showDebug, setShowDebug] = React.useState(false);
    const [settings, setSettings] = React.useState<ModelSettings>(loadSettings);
    const [autoAnalyze, setAutoAnalyze] = React.useState(() => localStorage.getItem(AUTO_ANALYZE_KEY) === 'true');
    const [captureInterval, setCaptureInterval] = React.useState(() => Number(localStorage.getItem(CAPTURE_INTERVAL_KEY) || 30));
    const [session, setSession] = React.useState<SessionRecord>(() => createSession());
    const [selectedFrameId, setSelectedFrameId] = React.useState<string | null>(null);
    const [question, setQuestion] = React.useState('');
    const [restoringSession, setRestoringSession] = React.useState(true);
    const sessionRef = React.useRef(session);
    const autoAnalyzeRef = React.useRef(autoAnalyze);
    const settingsRef = React.useRef(settings);
    const analysisChainRef = React.useRef(Promise.resolve());
    const queuedAnalysisRef = React.useRef(0);
    const enqueueAnalysisRef = React.useRef<(frameId: string, prompt?: string, chat?: boolean) => void>(() => undefined);

    sessionRef.current = session;
    autoAnalyzeRef.current = autoAnalyze;
    settingsRef.current = settings;

    const replaceSession = React.useCallback((next: SessionRecord) => {
        sessionRef.current = next;
        setSession(next);
    }, []);

    const mutateSession = React.useCallback((mutator: (current: SessionRecord) => SessionRecord) => {
        const next = mutator(sessionRef.current);
        next.updatedAt = Date.now();
        replaceSession(next);
        return next;
    }, [replaceSession]);

    const mutateFrame = React.useCallback((frameId: string, mutator: (frame: FrameRecord) => FrameRecord) => {
        mutateSession(current => ({
            ...current,
            frames: current.frames.map(frame => frame.id === frameId ? mutator(frame) : frame),
        }));
    }, [mutateSession]);

    const onFrame = React.useCallback((frame: FrameRecord) => {
        const next = {
            ...sessionRef.current,
            updatedAt: Date.now(),
            frames: [...sessionRef.current.frames, frame].slice(-MAX_SESSION_FRAMES),
        };
        replaceSession(next);
        setSelectedFrameId(frame.id);
        void saveSession(next).then(() => {
            mutateFrame(frame.id, current => updateStage(current, 'persist', {
                status: 'success',
                durationMs: elapsed(current.stages.find(stage => stage.name === 'persist')?.startedAt || Date.now()),
            }));
        }).catch(error => {
            mutateFrame(frame.id, current => updateStage(current, 'persist', { status: 'error', error: String(error) }));
        });
        if (autoAnalyzeRef.current) {
            enqueueAnalysisRef.current(frame.id);
        }
    }, [mutateFrame, replaceSession]);

    const glass = useGlassController({ device: deviceController.device, onFrame });

    React.useEffect(() => {
        void loadLatestSession().then(restored => {
            if (restored) {
                replaceSession(restored);
                setSelectedFrameId(restored.frames[restored.frames.length - 1]?.id || null);
            }
        }).finally(() => setRestoringSession(false));
    }, [replaceSession]);

    React.useEffect(() => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        settingsRef.current = settings;
    }, [settings]);

    React.useEffect(() => {
        localStorage.setItem(AUTO_ANALYZE_KEY, String(autoAnalyze));
        autoAnalyzeRef.current = autoAnalyze;
    }, [autoAnalyze]);

    React.useEffect(() => {
        localStorage.setItem(CAPTURE_INTERVAL_KEY, String(captureInterval));
    }, [captureInterval]);

    React.useEffect(() => {
        if (restoringSession) {
            return;
        }
        const timeout = setTimeout(() => void saveSession(sessionRef.current), 500);
        return () => clearTimeout(timeout);
    }, [session, restoringSession]);

    const runAnalysis = React.useCallback(async (frameId: string, prompt = '', addToChat = false): Promise<void> => {
        const frame = sessionRef.current.frames.find(item => item.id === frameId);
        if (!frame) {
            return;
        }
        const currentSettings = settingsRef.current;
        const fallbackPrompt = prompt || '概括当前画面中最重要的信息。';
        try {
            let answer = '';
            if (currentSettings.mode === 'direct') {
                mutateFrame(frameId, current => updateStage(
                    updateStage(current, 'vision', { status: 'skipped', error: '直连模式' }),
                    'reasoning',
                    { status: 'running', startedAt: Date.now(), error: undefined },
                ));
                const startedAt = Date.now();
                answer = await directVisionQuestion(frame.data, fallbackPrompt, currentSettings);
                mutateFrame(frameId, current => ({
                    ...updateStage(current, 'reasoning', { status: 'success', durationMs: elapsed(startedAt) }),
                    answer,
                }));
            } else {
                const visionStartedAt = Date.now();
                mutateFrame(frameId, current => updateStage(current, 'vision', { status: 'running', startedAt: visionStartedAt, error: undefined }));
                const description = await describeFrame(frame.data, currentSettings);
                mutateFrame(frameId, current => ({
                    ...updateStage(current, 'vision', { status: 'success', durationMs: elapsed(visionStartedAt) }),
                    description,
                }));
                const reasoningStartedAt = Date.now();
                mutateFrame(frameId, current => updateStage(current, 'reasoning', { status: 'running', startedAt: reasoningStartedAt, error: undefined }));
                answer = await reasonFromDescription(description, fallbackPrompt, currentSettings);
                mutateFrame(frameId, current => ({
                    ...updateStage(current, 'reasoning', { status: 'success', durationMs: elapsed(reasoningStartedAt) }),
                    answer,
                }));
            }
            if (addToChat) {
                const assistant: ChatMessage = { id: `assistant-${Date.now()}`, role: 'assistant', content: answer, timestamp: Date.now() };
                mutateSession(current => ({ ...current, messages: [...current.messages, assistant] }));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            mutateFrame(frameId, current => {
                const running = current.stages.find(stage => stage.status === 'running');
                return running ? updateStage(current, running.name, { status: 'error', error: message }) : current;
            });
            if (addToChat) {
                mutateSession(current => ({
                    ...current,
                    messages: [...current.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: `处理失败：${message}`, timestamp: Date.now() }],
                }));
            }
        }
    }, [mutateFrame, mutateSession]);

    const enqueueAnalysis = React.useCallback((frameId: string, prompt = '', addToChat = false) => {
        if (!canEnqueueAnalysis(queuedAnalysisRef.current, MAX_ANALYSIS_QUEUE)) {
            mutateFrame(frameId, current => updateStage(
                updateStage(current, 'vision', { status: 'skipped', error: '分析队列已满' }),
                'reasoning',
                { status: 'skipped', error: '分析队列已满' },
            ));
            return;
        }
        queuedAnalysisRef.current += 1;
        analysisChainRef.current = analysisChainRef.current
            .then(() => runAnalysis(frameId, prompt, addToChat))
            .finally(() => { queuedAnalysisRef.current -= 1; });
    }, [mutateFrame, runAnalysis]);
    enqueueAnalysisRef.current = enqueueAnalysis;

    const selectedFrame = session.frames.find(frame => frame.id === selectedFrameId) || session.frames[session.frames.length - 1];

    const sendQuestion = React.useCallback(() => {
        const trimmed = question.trim();
        if (!trimmed || !selectedFrame) {
            return;
        }
        mutateSession(current => ({
            ...current,
            messages: [...current.messages, { id: `user-${Date.now()}`, role: 'user', content: trimmed, timestamp: Date.now() }],
        }));
        setQuestion('');
        enqueueAnalysis(selectedFrame.id, trimmed, true);
    }, [enqueueAnalysis, mutateSession, question, selectedFrame]);

    const resetSession = React.useCallback(async () => {
        await clearSessions();
        const next = createSession();
        replaceSession(next);
        setSelectedFrameId(null);
    }, [replaceSession]);

    const exportSession = React.useCallback(() => {
        const payload = {
            ...sessionRef.current,
            frames: sessionRef.current.frames.map(frame => ({ ...frame, data: toBase64(frame.data) })),
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${sessionRef.current.id}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, []);

    const statusBusy = ['restoring', 'connecting', 'reconnecting'].includes(deviceController.status);
    const connectionAction = deviceController.status === 'connected'
        ? deviceController.disconnect
        : deviceController.status === 'error'
            ? deviceController.reconnect
            : deviceController.connect;
    const connectionLabel = deviceController.status === 'connected' ? '断开设备' : deviceController.status === 'error' ? '重新连接' : '连接眼镜';

    const visionPanel = (
        <View style={styles.panel}>
            <View style={styles.panelHeader}>
                <View><Text style={styles.panelIndex}>01 / OPTICAL FEED</Text><Text style={styles.panelTitle}>实时视野</Text></View>
                <Text style={styles.panelMeta}>{session.frames.length} 帧</Text>
            </View>
            <View style={styles.preview}>
                {selectedFrame ? (
                    <Image source={{ uri: toBase64Image(selectedFrame.data) }} style={styles.previewImage} resizeMode="contain" />
                ) : (
                    <View style={styles.previewEmpty}>
                        <View style={styles.reticle}><View style={styles.reticleInner} /></View>
                        <Text style={styles.emptyTitle}>{deviceController.status === 'connected' ? '等待第一帧' : '光学链路未连接'}</Text>
                        <Text style={styles.emptyText}>工作区始终可用。连接 OMI Glass 后即可接收画面。</Text>
                    </View>
                )}
                <View style={styles.previewHud}>
                    <Text style={styles.hudText}>{glass.subscribed ? 'PHOTO CHANNEL LIVE' : 'PHOTO CHANNEL STANDBY'}</Text>
                    <Text style={styles.hudText}>{selectedFrame ? new Date(selectedFrame.timestamp).toLocaleTimeString('zh-CN') : '--:--:--'}</Text>
                </View>
            </View>
            <View style={styles.captureSection}>
                <View style={styles.captureTop}>
                    <View>
                        <Text style={styles.controlEyebrow}>CAPTURE CONTROL</Text>
                        <Text style={styles.captureMode}>{glass.capture.mode === 'interval' ? `自动 / ${glass.capture.intervalSeconds}s` : glass.capture.mode === 'single' ? '单次拍摄' : '已停止'}</Text>
                    </View>
                    {glass.capture.pending ? <ActivityIndicator color="#65f2e8" /> : <View style={[styles.modeLight, glass.capture.mode === 'interval' && styles.modeLightActive]} />}
                </View>
                <View style={styles.intervalRow}>
                    {[5, 30, 60, 300].map(value => (
                        <Pressable key={value} onPress={() => setCaptureInterval(value)} style={[styles.intervalButton, captureInterval === value && styles.intervalActive]}>
                            <Text style={[styles.intervalText, captureInterval === value && styles.intervalTextActive]}>{value}s</Text>
                        </Pressable>
                    ))}
                </View>
                <View style={styles.captureActions}>
                    <Pressable disabled={!glass.subscribed || glass.capture.pending} onPress={glass.takePhoto} style={[styles.primaryButton, (!glass.subscribed || glass.capture.pending) && styles.buttonDisabled]}><Text style={styles.primaryButtonText}>拍摄一帧</Text></Pressable>
                    <Pressable disabled={!glass.subscribed || glass.capture.pending} onPress={() => glass.startInterval(captureInterval)} style={[styles.secondaryButton, (!glass.subscribed || glass.capture.pending) && styles.buttonDisabled]}><Text style={styles.secondaryButtonText}>启动自动</Text></Pressable>
                    <Pressable disabled={!glass.subscribed || glass.capture.pending} onPress={glass.stopCapture} style={[styles.stopButton, (!glass.subscribed || glass.capture.pending) && styles.buttonDisabled]}><Text style={styles.stopButtonText}>停止</Text></Pressable>
                </View>
                {glass.capture.error ? <Text style={styles.inlineError}>{glass.capture.error}</Text> : null}
            </View>
        </View>
    );

    const framesPanel = (
        <View style={styles.panel}>
            <View style={styles.panelHeader}>
                <View><Text style={styles.panelIndex}>02 / PIPELINE</Text><Text style={styles.panelTitle}>帧与流水线</Text></View>
                <View style={styles.autoRow}><Text style={styles.autoLabel}>自动分析</Text><Switch value={autoAnalyze} onValueChange={setAutoAnalyze} trackColor={{ false: '#24373a', true: '#0f5e62' }} thumbColor={autoAnalyze ? '#65f2e8' : '#819597'} /></View>
            </View>
            <ScrollView style={styles.frameScroll} contentContainerStyle={styles.frameList}>
                {session.frames.length === 0 ? (
                    <View style={styles.listEmpty}><Text style={styles.emptyTitle}>暂无帧记录</Text><Text style={styles.emptyText}>接收后的图片会在此展示每个处理阶段。</Text></View>
                ) : session.frames.slice().reverse().map((frame, reverseIndex) => (
                    <Pressable key={frame.id} onPress={() => setSelectedFrameId(frame.id)} style={[styles.frameCard, selectedFrame?.id === frame.id && styles.frameCardActive]}>
                        <Image source={{ uri: toBase64Image(frame.data) }} style={styles.thumbnail} />
                        <View style={styles.frameBody}>
                            <View style={styles.frameHeading}><Text style={styles.frameNumber}>FRAME {String(session.frames.length - reverseIndex).padStart(3, '0')}</Text><Text style={styles.frameTimestamp}>{new Date(frame.timestamp).toLocaleTimeString('zh-CN')}</Text></View>
                            <StageStrip stages={frame.stages} />
                            {frame.description ? <Text style={styles.frameDescription} numberOfLines={2}>{frame.description}</Text> : null}
                            {frame.stages.some(stage => stage.status === 'error') ? <Text style={styles.inlineError}>{frame.stages.find(stage => stage.error)?.error}</Text> : null}
                        </View>
                    </Pressable>
                ))}
            </ScrollView>
            <View style={styles.listFooter}>
                <Pressable disabled={!selectedFrame} onPress={() => selectedFrame && enqueueAnalysis(selectedFrame.id)} style={[styles.primaryButton, !selectedFrame && styles.buttonDisabled]}><Text style={styles.primaryButtonText}>分析所选帧</Text></Pressable>
                <IconButton label="导出" onPress={exportSession} />
            </View>
        </View>
    );

    const assistantPanel = (
        <View style={styles.panel}>
            <View style={styles.panelHeader}>
                <View><Text style={styles.panelIndex}>03 / INTELLIGENCE</Text><Text style={styles.panelTitle}>AI 助手</Text></View>
                <View style={styles.modelBadge}><Text style={styles.modelBadgeText}>{settings.mode === 'direct' ? 'DIRECT' : 'STAGED'}</Text></View>
            </View>
            <View style={styles.contextCard}>
                <Text style={styles.controlEyebrow}>ACTIVE CONTEXT</Text>
                <Text style={styles.contextTitle}>{selectedFrame ? new Date(selectedFrame.timestamp).toLocaleString('zh-CN') : '尚未选择画面'}</Text>
                <Text style={styles.contextDescription} numberOfLines={4}>{selectedFrame?.description || selectedFrame?.answer || '分析画面后，这里会展示模型可见的上下文。'}</Text>
            </View>
            <ScrollView style={styles.chatScroll} contentContainerStyle={styles.chatContent}>
                {session.messages.length === 0 ? (
                    <View style={styles.chatIntro}><Text style={styles.emptyTitle}>询问你看到的世界</Text><Text style={styles.emptyText}>选择一帧后提问。回答只使用当前画面或其视觉描述。</Text></View>
                ) : session.messages.map(message => (
                    <View key={message.id} style={[styles.message, message.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
                        <Text style={styles.messageRole}>{message.role === 'user' ? 'YOU' : 'OMI VISION'}</Text>
                        <Text style={styles.messageText}>{message.content}</Text>
                    </View>
                ))}
            </ScrollView>
            <View style={styles.composer}>
                <TextInput
                    value={question}
                    onChangeText={setQuestion}
                    onSubmitEditing={sendQuestion}
                    placeholder="关于所选画面提问..."
                    placeholderTextColor="#587174"
                    multiline
                    style={styles.questionInput}
                />
                <Pressable disabled={!selectedFrame || !question.trim()} onPress={sendQuestion} style={[styles.sendButton, (!selectedFrame || !question.trim()) && styles.buttonDisabled]}><Text style={styles.sendText}>发送</Text></Pressable>
            </View>
        </View>
    );

    return (
        <View style={styles.root}>
            <View style={styles.ambientTop} /><View style={styles.ambientBottom} />
            <View style={[styles.header, phone && styles.headerPhone]}>
                <View style={styles.brand}>
                    <View style={styles.brandMark}><View style={styles.brandCore} /></View>
                    <View>{phone ? null : <Text style={styles.brandKicker}>OMI GLASS SYSTEM</Text>}<Text style={[styles.brandTitle, phone && styles.brandTitlePhone]}>光学实验室</Text></View>
                </View>
                <View style={styles.headerRight}>
                    {phone ? null : <View style={styles.statusBlock}>
                        <View style={[styles.statusDot, deviceController.status === 'connected' && styles.statusConnected, deviceController.status === 'error' && styles.statusError]} />
                        <View><Text style={styles.statusTitle}>{STATUS_LABELS[deviceController.status]}</Text><Text style={styles.statusSubtitle}>{deviceController.bluetoothDevice?.name || 'OMI Glass'}</Text></View>
                    </View>}
                    <Pressable disabled={statusBusy || deviceController.status === 'unsupported'} onPress={connectionAction} style={[styles.connectButton, deviceController.status === 'connected' && styles.disconnectButton, statusBusy && styles.buttonDisabled]}>
                        {statusBusy ? <ActivityIndicator color="#071012" size="small" /> : <Text style={[styles.connectText, deviceController.status === 'connected' && styles.disconnectText]}>{connectionLabel}</Text>}
                    </Pressable>
                    <IconButton label="设置" onPress={() => setShowDebug(true)} />
                </View>
            </View>
            {deviceController.error ? <View style={styles.errorBanner}><Text style={styles.errorBannerText}>{deviceController.error}</Text></View> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.telemetryBar} contentContainerStyle={styles.telemetryContent}>
                <Text style={styles.telemetry}>BLE {deviceController.status === 'connected' ? 'ONLINE' : 'OFFLINE'}</Text>
                <Text style={styles.telemetry}>BAT {glass.info.battery === null ? '--' : `${glass.info.battery}%`}</Text>
                <Text style={styles.telemetry}>FW {glass.info.firmware || '--'}</Text>
                <Text style={styles.telemetry}>QUEUE {queuedAnalysisRef.current}/{MAX_ANALYSIS_QUEUE}</Text>
                <Text style={styles.telemetry}>OPENAI {configuredProviders.openai ? 'SET' : 'EMPTY'}</Text>
                <Text style={styles.telemetry}>GROQ {configuredProviders.groq ? 'SET' : 'EMPTY'}</Text>
            </ScrollView>
            {compact ? (
                <>
                    <View style={styles.tabs}>
                        {([['vision', '实时视野'], ['frames', '流水线'], ['assistant', 'AI 助手']] as Array<[WorkspaceTab, string]>).map(([key, label]) => (
                            <Pressable key={key} onPress={() => setActiveTab(key)} style={[styles.tab, activeTab === key && styles.tabActive]}><Text style={[styles.tabText, activeTab === key && styles.tabTextActive]}>{label}</Text></Pressable>
                        ))}
                    </View>
                    <View style={styles.compactWorkspace}>{activeTab === 'vision' ? visionPanel : activeTab === 'frames' ? framesPanel : assistantPanel}</View>
                </>
            ) : (
                <View style={styles.workspace}>{visionPanel}{framesPanel}{assistantPanel}</View>
            )}
            <View style={styles.footer}>
                <Text style={styles.footerText}>{restoringSession ? '正在恢复本地会话...' : `会话 ${session.title} / ${session.frames.length}/${MAX_SESSION_FRAMES} 帧`}</Text>
                <Pressable onPress={resetSession}><Text style={styles.footerAction}>新建会话</Text></Pressable>
            </View>
            {showDebug ? (
                <DebugView
                    device={deviceController.device}
                    settings={settings}
                    diagnostics={glass.diagnostics}
                    onSettingsChange={setSettings}
                    onClearSessions={resetSession}
                    onClose={() => setShowDebug(false)}
                />
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#071012', overflow: 'hidden' },
    ambientTop: { position: 'absolute', width: 600, height: 600, borderRadius: 300, top: -420, right: -100, backgroundColor: 'rgba(22, 157, 157, 0.13)' },
    ambientBottom: { position: 'absolute', width: 480, height: 480, borderRadius: 240, bottom: -380, left: -100, backgroundColor: 'rgba(202, 139, 47, 0.08)' },
    header: { minHeight: 84, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#193337', backgroundColor: 'rgba(7,16,18,0.96)' },
    headerPhone: { minHeight: 72, paddingHorizontal: 10 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 13 }, brandMark: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: '#65f2e8', alignItems: 'center', justifyContent: 'center' }, brandCore: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#65f2e8' },
    brandKicker: { color: '#4f9c9a', fontSize: 9, letterSpacing: 2.2, fontFamily: 'Cascadia Mono' }, brandTitle: { color: '#edf9f7', fontSize: 22, fontWeight: '700', letterSpacing: 1, fontFamily: 'Bahnschrift', marginTop: 3 },
    brandTitlePhone: { fontSize: 17, marginTop: 0 },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 }, statusBlock: { flexDirection: 'row', alignItems: 'center', gap: 9, marginRight: 6 }, statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#64777a' }, statusConnected: { backgroundColor: '#65f2e8' }, statusError: { backgroundColor: '#ff7c70' }, statusTitle: { color: '#cbdad8', fontSize: 11, fontWeight: '700' }, statusSubtitle: { color: '#557174', fontSize: 9, marginTop: 2, fontFamily: 'Cascadia Mono' },
    connectButton: { minWidth: 108, height: 38, paddingHorizontal: 15, backgroundColor: '#65f2e8', alignItems: 'center', justifyContent: 'center' }, disconnectButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#38575b' }, connectText: { color: '#061012', fontSize: 11, fontWeight: '800' }, disconnectText: { color: '#b6c9c7' }, iconButton: { height: 38, minWidth: 52, paddingHorizontal: 12, borderWidth: 1, borderColor: '#315055', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a1719' }, iconButtonText: { color: '#9fb5b3', fontSize: 10, fontWeight: '700' }, buttonDisabled: { opacity: 0.4 },
    errorBanner: { backgroundColor: '#301b18', borderBottomWidth: 1, borderBottomColor: '#73423d', paddingHorizontal: 24, paddingVertical: 8 }, errorBannerText: { color: '#ff9a90', fontSize: 11 },
    telemetryBar: { minHeight: 30, maxHeight: 30, borderBottomWidth: 1, borderBottomColor: '#14282b', backgroundColor: '#081416' }, telemetryContent: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 22, paddingHorizontal: 24 }, telemetry: { color: '#527174', fontSize: 9, letterSpacing: 0.8, fontFamily: 'Cascadia Mono' },
    workspace: { flex: 1, flexDirection: 'row', padding: 12, gap: 10, minHeight: 0 }, compactWorkspace: { flex: 1, padding: 10, minHeight: 0 },
    panel: { flex: 1, minWidth: 0, minHeight: 0, borderWidth: 1, borderColor: '#19363a', backgroundColor: 'rgba(9, 23, 25, 0.94)' }, panelHeader: { minHeight: 68, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#183236' }, panelIndex: { color: '#3f8585', fontSize: 8, letterSpacing: 1.7, fontFamily: 'Cascadia Mono' }, panelTitle: { color: '#dfecea', fontSize: 16, fontWeight: '700', marginTop: 5, fontFamily: 'Bahnschrift' }, panelMeta: { color: '#597679', fontFamily: 'Cascadia Mono', fontSize: 10 },
    preview: { flex: 1, minHeight: 250, backgroundColor: '#03090a', position: 'relative', overflow: 'hidden' }, previewImage: { width: '100%', height: '100%' }, previewEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }, reticle: { width: 104, height: 104, borderRadius: 52, borderWidth: 1, borderColor: '#22585b', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }, reticleInner: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: '#65f2e8' }, emptyTitle: { color: '#adc2c0', fontSize: 14, fontWeight: '700', textAlign: 'center' }, emptyText: { color: '#587275', fontSize: 11, lineHeight: 17, textAlign: 'center', maxWidth: 290, marginTop: 7 }, previewHud: { position: 'absolute', left: 10, right: 10, top: 10, flexDirection: 'row', justifyContent: 'space-between' }, hudText: { color: '#67c9c4', fontSize: 8, letterSpacing: 1, fontFamily: 'Cascadia Mono', backgroundColor: 'rgba(2,10,11,0.7)', padding: 5 },
    captureSection: { padding: 15, borderTopWidth: 1, borderTopColor: '#173135' }, captureTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, controlEyebrow: { color: '#4c8585', fontSize: 8, letterSpacing: 1.4, fontFamily: 'Cascadia Mono' }, captureMode: { color: '#c9d8d6', fontSize: 13, fontWeight: '700', marginTop: 4 }, modeLight: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#42585a' }, modeLightActive: { backgroundColor: '#65f2e8' }, intervalRow: { flexDirection: 'row', gap: 6, marginBottom: 10 }, intervalButton: { flex: 1, borderWidth: 1, borderColor: '#28484c', paddingVertical: 7, alignItems: 'center' }, intervalActive: { borderColor: '#65f2e8', backgroundColor: '#102e30' }, intervalText: { color: '#708a8c', fontSize: 9, fontFamily: 'Cascadia Mono' }, intervalTextActive: { color: '#65f2e8' }, captureActions: { flexDirection: 'row', gap: 7 }, primaryButton: { minHeight: 38, flex: 1, backgroundColor: '#65f2e8', paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' }, primaryButtonText: { color: '#061112', fontSize: 10, fontWeight: '800' }, secondaryButton: { minHeight: 38, flex: 1, borderWidth: 1, borderColor: '#3f7577', alignItems: 'center', justifyContent: 'center' }, secondaryButtonText: { color: '#a7c5c2', fontSize: 10, fontWeight: '700' }, stopButton: { minHeight: 38, paddingHorizontal: 15, borderWidth: 1, borderColor: '#77504a', alignItems: 'center', justifyContent: 'center' }, stopButtonText: { color: '#e8a79e', fontSize: 10, fontWeight: '700' }, inlineError: { color: '#ff8f84', fontSize: 9, marginTop: 7, fontFamily: 'Cascadia Mono' },
    autoRow: { flexDirection: 'row', alignItems: 'center', gap: 7 }, autoLabel: { color: '#799294', fontSize: 9 }, frameScroll: { flex: 1, minHeight: 0 }, frameList: { padding: 10, gap: 8 }, listEmpty: { minHeight: 250, alignItems: 'center', justifyContent: 'center', padding: 25 }, frameCard: { flexDirection: 'row', minHeight: 94, padding: 8, borderWidth: 1, borderColor: '#183236', backgroundColor: '#091719' }, frameCardActive: { borderColor: '#4db9b5', backgroundColor: '#0c2224' }, thumbnail: { width: 78, height: 78, backgroundColor: '#030808' }, frameBody: { flex: 1, minWidth: 0, paddingLeft: 10 }, frameHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, frameNumber: { color: '#73c8c3', fontSize: 8, letterSpacing: 1.1, fontFamily: 'Cascadia Mono' }, frameTimestamp: { color: '#526c6e', fontSize: 8, fontFamily: 'Cascadia Mono' }, stageStrip: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 9 }, stageItem: { alignItems: 'center', width: 35 }, stageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#354b4d' }, stageSuccess: { backgroundColor: '#65f2e8' }, stageRunning: { backgroundColor: '#e9b65c' }, stageError: { backgroundColor: '#ff786d' }, stageSkipped: { backgroundColor: '#667779' }, stageText: { color: '#698184', fontSize: 7, marginTop: 3 }, stageTime: { color: '#3e5d60', fontSize: 6, fontFamily: 'Cascadia Mono' }, stageLine: { flex: 1, height: 1, backgroundColor: '#294145', marginTop: 3 }, frameDescription: { color: '#809b99', fontSize: 9, lineHeight: 13, marginTop: 7 }, listFooter: { minHeight: 58, padding: 10, flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: '#173135' },
    modelBadge: { borderWidth: 1, borderColor: '#35575a', paddingHorizontal: 8, paddingVertical: 5 }, modelBadgeText: { color: '#65f2e8', fontSize: 8, letterSpacing: 1, fontFamily: 'Cascadia Mono' }, contextCard: { margin: 10, padding: 12, borderLeftWidth: 2, borderLeftColor: '#e9b65c', backgroundColor: '#17170f' }, contextTitle: { color: '#d6d7bf', fontSize: 11, fontWeight: '700', marginTop: 5 }, contextDescription: { color: '#8f927c', fontSize: 10, lineHeight: 15, marginTop: 6 }, chatScroll: { flex: 1, minHeight: 0 }, chatContent: { padding: 10, gap: 9 }, chatIntro: { minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: 24 }, message: { padding: 11, maxWidth: '92%' }, userMessage: { alignSelf: 'flex-end', backgroundColor: '#153a3c', borderRightWidth: 2, borderRightColor: '#65f2e8' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#111f21', borderLeftWidth: 2, borderLeftColor: '#e9b65c' }, messageRole: { color: '#568487', fontSize: 7, letterSpacing: 1, fontFamily: 'Cascadia Mono', marginBottom: 5 }, messageText: { color: '#c6d4d2', fontSize: 11, lineHeight: 17 }, composer: { minHeight: 78, padding: 10, flexDirection: 'row', gap: 8, borderTopWidth: 1, borderTopColor: '#173135' }, questionInput: { flex: 1, minHeight: 54, maxHeight: 100, backgroundColor: '#071113', borderWidth: 1, borderColor: '#274448', color: '#d9e7e5', padding: 10, textAlignVertical: 'top', fontSize: 11 }, sendButton: { width: 58, backgroundColor: '#e9b65c', alignItems: 'center', justifyContent: 'center' }, sendText: { color: '#171207', fontSize: 10, fontWeight: '800' },
    tabs: { flexDirection: 'row', paddingHorizontal: 10, paddingTop: 10, gap: 6 }, tab: { flex: 1, height: 38, borderWidth: 1, borderColor: '#244347', alignItems: 'center', justifyContent: 'center' }, tabActive: { backgroundColor: '#65f2e8', borderColor: '#65f2e8' }, tabText: { color: '#789294', fontSize: 10, fontWeight: '700' }, tabTextActive: { color: '#061112' },
    footer: { minHeight: 30, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#152d30', backgroundColor: '#071012' }, footerText: { color: '#405f62', fontSize: 8, fontFamily: 'Cascadia Mono' }, footerAction: { color: '#5fb8b4', fontSize: 9, fontWeight: '700' },
});
