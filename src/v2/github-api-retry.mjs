const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientFetchFailure(error) {
  return error instanceof TypeError &&
    /\bfetch failed\b/i.test(String(error.message ?? ''));
}

export async function withTransientFetchRetry(
  operation,
  {
    label = 'GitHub fetch',
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleepFn = sleep,
    warn = (message) => console.warn(message)
  } = {}
) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive integer');
  }

  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError('baseDelayMs must be a non-negative number');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFetchFailure(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = baseDelayMs * (2 ** (attempt - 1));

      warn(
        `::warning::${label}: transient fetch failed on attempt ` +
        `${attempt}/${maxAttempts}; retrying in ${delayMs}ms`
      );

      await sleepFn(delayMs);
    }
  }

  throw new Error(`${label}: retry loop exhausted unexpectedly`);
}
