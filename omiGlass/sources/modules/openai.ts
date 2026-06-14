import axios from 'axios';
import { keys } from '../keys';

let audioContext: AudioContext | null = null;

export async function startAudio(): Promise<void> {
    if (!audioContext) {
        audioContext = new AudioContext();
    }
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
}

export async function textToSpeech(text: string): Promise<ArrayBuffer | null> {
    if (!keys.openai || !text.trim()) {
        return null;
    }
    await startAudio();
    const response = await axios.post('https://api.openai.com/v1/audio/speech', {
        input: text,
        voice: 'nova',
        model: 'tts-1',
    }, {
        headers: { Authorization: `Bearer ${keys.openai}`, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 60000,
    });
    const decoded = await audioContext!.decodeAudioData(response.data);
    const source = audioContext!.createBufferSource();
    source.buffer = decoded;
    source.connect(audioContext!.destination);
    source.start();
    return response.data;
}

export async function gptRequest(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!keys.openai) {
        throw new Error('未配置 OpenAI API Key');
    }
    const response = await axios.post('https://api.openai.com/v1/responses', {
        model: 'gpt-4.1-mini',
        input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    }, {
        headers: { Authorization: `Bearer ${keys.openai}`, 'Content-Type': 'application/json' },
        timeout: 60000,
    });
    if (typeof response.data?.output_text === 'string') {
        return response.data.output_text.trim();
    }
    const text = response.data?.output?.flatMap((item: any) => item.content || [])
        .filter((item: any) => item.type === 'output_text')
        .map((item: any) => item.text)
        .join('\n')
        .trim();
    if (!text) {
        throw new Error('OpenAI 返回了空结果');
    }
    return text;
}
