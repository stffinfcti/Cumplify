/**
 * AUD-1/BUG-18 regression — RDS Data API timestamp marshalling.
 *
 * Fixture fidelity rule (build-audit RC-2): every fixture here uses the
 * REAL Data API wire shape (`stringValue: 'YYYY-MM-DD HH:MM:SS.ffffff'`),
 * never pre-converted ISO strings — the ISO-string fixtures are exactly
 * how this bug survived 1,262 hermetic tests.
 */

import { describe, expect, it } from 'vitest';
import {
  sqlTimestampToIso,
  unwrapField,
  marshalRow,
  marshalResult,
  type DataApiResult,
} from '../../src/resolvers/shared.js';

describe('sqlTimestampToIso', () => {
  it('converts Data API TIMESTAMPTZ with microseconds to ISO-8601 UTC (ms precision)', () => {
    expect(sqlTimestampToIso('2026-07-09 14:23:45.123456')).toBe('2026-07-09T14:23:45.123Z');
  });

  it('converts without fractional seconds to .000Z', () => {
    expect(sqlTimestampToIso('2026-07-09 14:23:45')).toBe('2026-07-09T14:23:45.000Z');
  });

  it('pads short fractions to millisecond precision', () => {
    expect(sqlTimestampToIso('2026-07-09 14:23:45.1')).toBe('2026-07-09T14:23:45.100Z');
    expect(sqlTimestampToIso('2026-07-09 14:23:45.12')).toBe('2026-07-09T14:23:45.120Z');
  });

  it('leaves AWSDate-shaped values (date only) untouched', () => {
    expect(sqlTimestampToIso('2026-07-09')).toBe('2026-07-09');
  });

  it('leaves already-ISO values untouched', () => {
    expect(sqlTimestampToIso('2026-07-09T14:23:45.123Z')).toBe('2026-07-09T14:23:45.123Z');
  });

  it('leaves prose containing a timestamp untouched (strict full-string match)', () => {
    const prose = 'Sealed at 2026-07-09 14:23:45 by the approver';
    expect(sqlTimestampToIso(prose)).toBe(prose);
  });

  it('leaves non-timestamp strings untouched', () => {
    expect(sqlTimestampToIso('NCR-2026-0001')).toBe('NCR-2026-0001');
    expect(sqlTimestampToIso('')).toBe('');
  });
});

describe('unwrapField (real Data API wire shapes)', () => {
  it('converts timestamp-shaped stringValue', () => {
    expect(unwrapField({ stringValue: '2026-07-09 14:23:45.123456' })).toBe(
      '2026-07-09T14:23:45.123Z',
    );
  });

  it('passes non-timestamp stringValue through', () => {
    expect(unwrapField({ stringValue: 'Calibration due' })).toBe('Calibration due');
  });

  it('handles longValue / booleanValue / isNull untouched by the conversion', () => {
    expect(unwrapField({ longValue: 42 })).toBe(42);
    expect(unwrapField({ booleanValue: true })).toBe(true);
    expect(unwrapField({ isNull: true })).toBeNull();
  });
});

describe('marshalRow / marshalResult with REAL Data API fixtures (AUD-1 e2e shape)', () => {
  // Exact shape of an ExecuteStatement response for a register list row —
  // the shape that detonated every populated register in the D5 walkthrough.
  const fixture: DataApiResult = {
    columnMetadata: [
      { name: 'id' },
      { name: 'title' },
      { name: 'created_at' },
      { name: 'updated_at' },
      { name: 'sealed_at' },
    ],
    records: [
      [
        { stringValue: '7f3e0a1c-9b2d-4e5f-8a6b-1c2d3e4f5a6b' },
        { stringValue: 'Supplier NCR — late delivery' },
        { stringValue: '2026-07-09 08:15:00.000123' },
        { stringValue: '2026-07-21 17:41:43.999999' },
        { isNull: true },
      ],
    ],
  };

  it('every timestamp column is AWSDateTime-valid after marshalling', () => {
    const [row] = marshalResult(fixture);
    expect(row.createdAt).toBe('2026-07-09T08:15:00.000Z');
    expect(row.updatedAt).toBe('2026-07-21T17:41:43.999Z');
    expect(row.sealedAt).toBeNull();
    // AWSDateTime acceptance shape: ISO-8601 with T and offset
    const awsDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(row.createdAt).toMatch(awsDateTime);
    expect(row.updatedAt).toMatch(awsDateTime);
  });

  it('non-timestamp columns are untouched', () => {
    const [row] = marshalResult(fixture);
    expect(row.id).toBe('7f3e0a1c-9b2d-4e5f-8a6b-1c2d3e4f5a6b');
    expect(row.title).toBe('Supplier NCR — late delivery');
  });

  it('marshalRow camelCases and converts in one pass', () => {
    const row = marshalRow([{ stringValue: '2026-01-02 03:04:05' }], [{ name: 'approved_at' }]);
    expect(row.approvedAt).toBe('2026-01-02T03:04:05.000Z');
  });
});
