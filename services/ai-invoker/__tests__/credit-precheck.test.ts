/**
 * Unit tests for credit-precheck module.
 * Verifies: exhausted blocks; incident exemption passes; HITL exemption passes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvokeError } from '../src/types.js';

// Mock DynamoDB
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: class {
      send = mockSend;
    },
    GetItemCommand: class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
  };
});

// Set env before import
vi.stubEnv('TABLE_NAME', 'CumplifyCore');

const { checkCreditBalance } = await import('../src/credit-precheck.js');

describe('credit-precheck', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('skips pre-check when creditExempt is true (incident/HITL exemption)', async () => {
    // Should not call DynamoDB at all
    await expect(checkCreditBalance('tenant-1', true)).resolves.toEqual({});
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('passes when credits are within grant', async () => {
    // First call: meter read
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '5000' } },
    });
    // Second call: entitlement read
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '30000' },
        paygoEnabled: { BOOL: false },
        planTier: { S: 'launch' },
      },
    });

    await expect(checkCreditBalance('tenant-1', false)).resolves.toEqual({
      hardCap: 30000,
    });
  });

  it('throws PAUSED_FOR_CREDITS when grant exhausted (no auto-refill)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '31000' } },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '30000' },
        paygoEnabled: { BOOL: false },
        planTier: { S: 'launch' },
      },
    });

    try {
      await checkCreditBalance('tenant-1', false);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvokeError);
      expect((err as InvokeError).code).toBe('PAUSED_FOR_CREDITS');
    }
  });

  it('does not block enterprise even when over grant (F-6: never block)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '250000' } },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '200000' },
        paygoEnabled: { BOOL: false },
        planTier: { S: 'enterprise' },
      },
    });

    await expect(checkCreditBalance('tenant-1', false)).resolves.toEqual({});
  });

  it('does not block when paygoEnabled even past grant (F-6: serve overage)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '45000' } },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '30000' },
        paygoEnabled: { BOOL: true },
        planTier: { S: 'launch' },
      },
    });

    await expect(checkCreditBalance('tenant-1', false)).resolves.toEqual({});
  });

  it('blocks trial (no paygo) when past grant (F-6)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '16000' } },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '15000' },
        paygoEnabled: { BOOL: false },
        planTier: { S: 'trial' },
      },
    });

    try {
      await checkCreditBalance('tenant-1', false);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvokeError);
      expect((err as InvokeError).code).toBe('PAUSED_FOR_CREDITS');
    }
  });

  it('applies trial defaults (15,000) when no entitlement record exists', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '14000' } },
    });
    mockSend.mockResolvedValueOnce({ Item: undefined }); // no entitlement

    await expect(checkCreditBalance('tenant-1', false)).resolves.toEqual({
      hardCap: 15000,
    });
  });

  it('blocks on trial defaults when exhausted', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '16000' } },
    });
    mockSend.mockResolvedValueOnce({ Item: undefined }); // no entitlement

    await expect(checkCreditBalance('tenant-1', false)).rejects.toThrow(InvokeError);
  });

  it('resolves the launch grant as the hard cap for conditional writes (TOCTOU)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { creditsUsed: { N: '29900' } },
    });
    mockSend.mockResolvedValueOnce({
      Item: {
        monthlyGrant: { N: '30000' },
        paygoEnabled: { BOOL: false },
        planTier: { S: 'launch' },
      },
    });

    const cap = await checkCreditBalance('tenant-1', false);
    expect(cap.hardCap).toBe(30000);
  });
});
