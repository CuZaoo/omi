import axios from 'axios';
import { keys } from '../keys';
import { ModelSettings } from '../types/console';
import { toBase64, toBase64Image } from '../utils/base64';

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
    mode: 'staged',
    visionProvider: 'ollama',
    reasoningProvider: 'groq',
    ollamaUrl: keys.ollama || 'http://localhost:11434/api/chat',
    ollamaVisionModel: 'moondream:1.8b-v2-fp16',
    ollamaReasoningModel: 'llama3',
    openAIModel: 'gpt-4.1-mini',
    groqModel: 'llama-3.3-70b-versatile',
};

export interface PipelineResult {
    description: string;
    answer: string;
}

export function responseText(data: any): string {
    if (typeof data?.output_text === 'string') {
        return data.output_text.trim();
    }
    const texts = data?.output?.flatMap((item: any) => item.content ?? [])
        .filter((item: any) => item.type === 'output_text')
        .map((item: any) => item.text) ?? [];
    return texts.join('\n').trim();
}

function readableError(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const detail = error.response?.data?.error?.message ?? error.response?.data?.message;
        return detail ? String(detail) : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

async function openAIResponse(input: unknown[], model: string): Promise<string> {
    if (!keys.openai) {
        throw new Error('未配置 OpenAI API Key');
    }
    try {
        const response = await axios.post('https://api.openai.com/v1/responses', {
            model,
            input,
        }, {
            headers: { Authorization: `Bearer ${keys.openai}`, 'Content-Type': 'application/json' },
            timeout: 60000,
        });
        const text = responseText(response.data);
        if (!text) {
            throw new Error('OpenAI 返回了空结果');
        }
        return text;
    } catch (error) {
        throw new Error(`OpenAI：${readableError(error)}`);
    }
}

async function ollamaChat(settings: ModelSettings, model: string, prompt: string, image?: Uint8Array): Promise<string> {
    if (!settings.ollamaUrl) {
        throw new Error('未配置 Ollama 地址');
    }
    try {
        const response = await axios.post(settings.ollamaUrl, {
            model,
            stream: false,
            messages: [{ role: 'user', content: prompt, images: image ? [toBase64(image)] : undefined }],
        }, { timeout: 60000 });
        const text = response.data?.message?.content?.trim();
        if (!text) {
            throw new Error('Ollama 返回了空结果');
        }
        return text;
    } catch (error) {
        throw new Error(`Ollama：${readableError(error)}`);
    }
}

async function groqChat(settings: ModelSettings, system: string, prompt: string): Promise<string> {
    if (!keys.groq) {
        throw new Error('未配置 Groq API Key');
    }
    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: settings.groqModel,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }, {
            headers: { Authorization: `Bearer ${keys.groq}`, 'Content-Type': 'application/json' },
            timeout: 60000,
        });
        const text = response.data?.choices?.[0]?.message?.content?.trim();
        if (!text) {
            throw new Error('Groq 返回了空结果');
        }
        return text;
    } catch (error) {
        throw new Error(`Groq：${readableError(error)}`);
    }
}

export async function describeFrame(image: Uint8Array, settings: ModelSettings): Promise<string> {
    const prompt = '用中文准确描述智能眼镜画面中的人物、动作、物体、文字和环境。只描述可确认的事实。';
    if (settings.visionProvider === 'ollama') {
        return ollamaChat(settings, settings.ollamaVisionModel, prompt, image);
    }
    return openAIResponse([{
        role: 'user',
        content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: toBase64Image(image), detail: 'auto' },
        ],
    }], settings.openAIModel);
}

export async function reasonFromDescription(description: string, question: string, settings: ModelSettings): Promise<string> {
    const system = '你是智能眼镜助手。仅根据提供的画面描述回答，信息不足时明确说明，不要编造。';
    const prompt = `画面描述：\n${description}\n\n用户问题：${question || '概括当前画面中最重要的信息。'}`;
    if (settings.reasoningProvider === 'groq') {
        return groqChat(settings, system, prompt);
    }
    if (settings.reasoningProvider === 'ollama') {
        return ollamaChat(settings, settings.ollamaReasoningModel, `${system}\n\n${prompt}`);
    }
    return openAIResponse([{ role: 'system', content: system }, { role: 'user', content: prompt }], settings.openAIModel);
}

export async function directVisionQuestion(image: Uint8Array, question: string, settings: ModelSettings): Promise<string> {
    return openAIResponse([{
        role: 'user',
        content: [
            { type: 'input_text', text: question || '用中文概括当前画面中最重要的信息。' },
            { type: 'input_image', image_url: toBase64Image(image), detail: 'auto' },
        ],
    }], settings.openAIModel);
}

export async function testProvider(provider: 'openai' | 'groq' | 'ollama', settings: ModelSettings): Promise<string> {
    if (provider === 'openai') {
        return openAIResponse([{ role: 'user', content: '只回复 OK' }], settings.openAIModel);
    }
    if (provider === 'groq') {
        return groqChat(settings, '只回复 OK', '连接测试');
    }
    return ollamaChat(settings, settings.ollamaReasoningModel, '只回复 OK');
}

export const configuredProviders = {
    openai: Boolean(keys.openai),
    groq: Boolean(keys.groq),
    ollama: Boolean(keys.ollama),
};

export function canEnqueueAnalysis(queueDepth: number, maximum = 3): boolean {
    return queueDepth < maximum;
}
