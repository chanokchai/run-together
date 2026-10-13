import { rm } from 'node:fs/promises';

const retryableCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function removeProfileWithRetry(directory, {
  remove = rm,
  wait = delay,
  maxAttempts = 6,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await remove(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === maxAttempts) throw error;
      await wait(Math.min(50 * (2 ** (attempt - 1)), 800));
    }
  }
}
