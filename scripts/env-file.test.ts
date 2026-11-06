import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file.ts';

describe('parseEnvFile', () => {
  it('reads the wizard format, undoing its single-quote escape', () => {
    const env = parseEnvFile("A='plain'\r\nB='it'\\''s'\n# comment\nC=bare\nD=\"double\"\n");
    expect(env).toEqual({ A: 'plain', B: "it's", C: 'bare', D: 'double' });
  });
});
