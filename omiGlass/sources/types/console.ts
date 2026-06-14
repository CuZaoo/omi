export type DeviceStatus =
    | 'idle'
    | 'restoring'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'error'
    | 'unsupported';

export type CaptureMode = 'stopped' | 'single' | 'interval';

export type StageStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export type PipelineStageName = 'ble' | 'assemble' | 'persist' | 'vision' | 'reasoning';

export interface PipelineStage {
    name: PipelineStageName;
    status: StageStatus;
    startedAt?: number;
    durationMs?: number;
    error?: string;
}

export interface FrameRecord {
    id: string;
    timestamp: number;
    data: Uint8Array;
    description?: string;
    answer?: string;
    stages: PipelineStage[];
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export interface SessionRecord {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    frames: FrameRecord[];
    messages: ChatMessage[];
}

export interface CaptureState {
    mode: CaptureMode;
    intervalSeconds: number;
    pending: boolean;
    error?: string;
}

export type VisionProvider = 'ollama' | 'openai';
export type ReasoningProvider = 'groq' | 'openai' | 'ollama';
export type PipelineMode = 'staged' | 'direct';

export interface ModelSettings {
    mode: PipelineMode;
    visionProvider: VisionProvider;
    reasoningProvider: ReasoningProvider;
    ollamaUrl: string;
    ollamaVisionModel: string;
    ollamaReasoningModel: string;
    openAIModel: string;
    groqModel: string;
}

export interface DiagnosticEntry {
    id: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    timestamp: number;
}
