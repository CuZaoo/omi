import { FrameRecord, SessionRecord } from '../types/console';

const DATABASE_NAME = 'omi-glass-lab';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const MAX_SESSIONS = 10;
export const MAX_SESSION_FRAMES = 200;

type StoredFrame = Omit<FrameRecord, 'data'> & { data: Blob };
type StoredSession = Omit<SessionRecord, 'frames'> & { frames: StoredFrame[] };

export function retainRecentSessions<T extends { updatedAt: number }>(sessions: T[], limit = MAX_SESSIONS): T[] {
    return [...sessions].sort((first, second) => second.updatedAt - first.updatedAt).slice(0, limit);
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(SESSION_STORE)) {
                const store = database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
                store.createIndex('updatedAt', 'updatedAt');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function serializeSession(session: SessionRecord): Promise<StoredSession> {
    return {
        ...session,
        frames: session.frames.slice(-MAX_SESSION_FRAMES).map(frame => ({
            ...frame,
            data: new Blob([frame.data], { type: 'image/jpeg' }),
        })),
    };
}

async function deserializeSession(session: StoredSession): Promise<SessionRecord> {
    return {
        ...session,
        frames: await Promise.all(session.frames.map(async frame => ({
            ...frame,
            data: new Uint8Array(await frame.data.arrayBuffer()),
        }))),
    };
}

async function trimOldSessions(database: IDBDatabase): Promise<void> {
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    const store = transaction.objectStore(SESSION_STORE);
    const sessions = await requestResult(store.getAll() as IDBRequest<StoredSession[]>);
    const retained = new Set(retainRecentSessions(sessions).map(session => session.id));
    for (const session of sessions.filter(item => !retained.has(item.id))) {
        store.delete(session.id);
    }
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

export async function saveSession(session: SessionRecord): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).put(await serializeSession(session));
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    await trimOldSessions(database);
    database.close();
}

export async function loadLatestSession(): Promise<SessionRecord | null> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const sessions = await requestResult(transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<StoredSession[]>);
    database.close();
    if (sessions.length === 0) {
        return null;
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return deserializeSession(sessions[0]);
}

export async function clearSessions(): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).clear();
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

export async function deleteSession(id: string): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    database.close();
}

export function createSession(): SessionRecord {
    const now = Date.now();
    return {
        id: `session-${now}`,
        title: new Date(now).toLocaleString('zh-CN'),
        createdAt: now,
        updatedAt: now,
        frames: [],
        messages: [],
    };
}
