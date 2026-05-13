import { describe, it, expect } from 'vitest';
import { validateLanguage } from '../src/chat/language.js';

describe('validateLanguage', () => {
  it('en room: allows ascii', () => {
    expect(validateLanguage('hello there', 'en').ok).toBe(true);
  });
  it('en room: allows numbers and emoji', () => {
    expect(validateLanguage('1000 RPOW 🎉', 'en').ok).toBe(true);
  });
  it('en room: rejects Mandarin', () => {
    const r = validateLanguage('我第一次发帖奖励吗', 'en');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/English-only/);
  });
  it('en room: rejects mixed CJK + ascii', () => {
    expect(validateLanguage('btc price 比特币', 'en').ok).toBe(false);
  });

  it('zh room: allows Mandarin', () => {
    expect(validateLanguage('比特币今天跌了', 'zh').ok).toBe(true);
  });
  it('zh room: allows mixed CJK + ascii (technical terms)', () => {
    expect(validateLanguage('我用 Lightning Network 测试', 'zh').ok).toBe(true);
  });
  it('zh room: rejects pure English', () => {
    const r = validateLanguage('bitcoin to the moon', 'zh');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Mandarin-only|中文/);
  });
  it('zh room: allows emoji/url-only post', () => {
    expect(validateLanguage('🎉🎉', 'zh').ok).toBe(true);
  });

  it('unknown language: passes through', () => {
    expect(validateLanguage('anything goes', 'xx').ok).toBe(true);
  });
});
