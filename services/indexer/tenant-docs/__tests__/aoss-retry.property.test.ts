import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';

vi.mock('../../../agents/shared/aoss-signed-client.js', () => ({ signedAossFetch: vi.fn() }));

import { signedAossFetch } from '../../../agents/shared/aoss-signed-client.js';
import { aossWriteWithRetry } from '../handler';

const fetchMock = vi.mocked(signedAossFetch);

const RETRYABLE = [403, 404, 429, 500, 502, 503, 599];
const nonRetryableArb = fc
  .integer({ min: 400, max: 499 })
  .filter((s) => s !== 403 && s !== 404 && s !== 429);

describe('aossWriteWithRetry (property-based)', () => {
  afterEach(() => vi.useRealTimers());

  it('any 2xx response resolves on the first attempt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 200, max: 299 }), async (status) => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ status, body: 'ok' });
        await expect(aossWriteWithRetry('https://x', 'idx', {})).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('any non-retryable client error fails immediately without retries', async () => {
    await fc.assert(
      fc.asyncProperty(nonRetryableArb, async (status) => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ status, body: 'err' });
        await expect(aossWriteWithRetry('https://x', 'idx', {})).rejects.toThrow(
          `status=${status}`,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('persistent retryable errors retry more than once before giving up', async () => {
    vi.useFakeTimers();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...RETRYABLE), async (status) => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({ status, body: 'err' });
        const p = aossWriteWithRetry('https://x', 'idx', {});
        const settled = expect(p).rejects.toThrow(/timed out|failed/);
        await vi.advanceTimersByTimeAsync(60_000);
        await settled;
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it('a retryable failure followed by success resolves on retry', async () => {
    vi.useFakeTimers();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...RETRYABLE), async (status) => {
        fetchMock.mockReset();
        fetchMock
          .mockResolvedValueOnce({ status, body: 'err' })
          .mockResolvedValue({ status: 200, body: 'ok' });
        const p = aossWriteWithRetry('https://x', 'idx', {});
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(p).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }),
    );
  });
});
