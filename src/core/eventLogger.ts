import { db, type EventLogItem } from '../db/db';

export async function logEvent(type: string, payload?: any): Promise<void> {
  try {
    const item: EventLogItem = {
      type,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
      timestamp: Date.now(),
    };
    await db.eventLogs.add(item);
  } catch (err) {
    console.warn('Failed to log event to Dexie:', err);
  }
}

export async function getRecentEvents(limit = 100): Promise<EventLogItem[]> {
  try {
    return await db.eventLogs.orderBy('timestamp').reverse().limit(limit).toArray();
  } catch {
    return [];
  }
}

export async function clearEventLogs(): Promise<void> {
  await db.eventLogs.clear();
}
