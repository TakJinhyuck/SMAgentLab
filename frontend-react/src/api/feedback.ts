import { apiFetch } from './client';
import type { FeedbackPayload } from '../types';

export async function postFeedback(payload: FeedbackPayload): Promise<void> {
  try {
    await apiFetch<void>('/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('postFeedback error:', err);
    throw err;
  }
}
