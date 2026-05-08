import { describe, it, expect } from 'vitest';
import { binance } from '../src/binance';

describe('Binance API', () => {
  it('should have binance object defined', () => {
    expect(binance).toBeDefined();
  });

  it('should have required methods', () => {
    expect(typeof binance.getKlines).toBe('function');
    expect(typeof binance.getBalance).toBe('function');
    expect(typeof binance.getDepth).toBe('function');
  });
});
