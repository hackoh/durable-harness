import { describe, expect, it } from 'vitest';
import { FIRST_VISIT_HARNESS, openingHarness, readMine } from './registry.ts';

describe('openingHarness', () => {
  it('opens a first visit on Pi', () => {
    expect(FIRST_VISIT_HARNESS).toBe('pi');
    expect(openingHarness(undefined, undefined)).toBe('pi');
  });
  it('keeps what this browser chose last', () => {
    expect(openingHarness(undefined, 'claude-code')).toBe('claude-code');
  });
  it('lets the URL win over a stored choice', () => {
    expect(openingHarness('codex', 'claude-code')).toBe('codex');
    expect(openingHarness('claude-code', undefined)).toBe('claude-code');
  });
});

describe('readMine', () => {
  const stored = (entries: unknown[]) => ({ getItem: () => JSON.stringify(entries) });
  const entry = { id: 'wrun_1', harness: 'hybrid', durability: 'on', prompt: 'p', sentAt: 1 };
  it('lists a session the retired Sandbox mode started under Hybrid, where it now runs', () => {
    expect(readMine(stored([{ ...entry, mode: 'sandbox', key: 'sandbox' }]))).toEqual([{ ...entry, mode: 'hybrid', key: 'hybrid' }]);
  });
  it('keeps the hands an entry was started with', () => {
    expect(readMine(stored([{ ...entry, mode: 'server', key: 'server', hands: 'none' }]))[0]?.hands).toBe('none');
  });
});
