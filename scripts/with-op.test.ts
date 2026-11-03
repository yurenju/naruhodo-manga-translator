import { describe, expect, it } from 'vitest';
import { OP_ENV_FILE, opEnvProblem } from './with-op.ts';

describe('opEnvProblem', () => {
  it('accepts an op:// reference for NARUHODO_ANTHROPIC_KEY, quoted or not', () => {
    expect(opEnvProblem('NARUHODO_ANTHROPIC_KEY=op://Private/claude-test-key/credential\n')).toBeUndefined();
    expect(opEnvProblem("# 開發用\r\nNARUHODO_ANTHROPIC_KEY='op://Dev/key/credential'\r\n")).toBeUndefined();
  });

  it('a missing file names the path and shows the format', () => {
    const problem = opEnvProblem(undefined);
    expect(problem).toContain(OP_ENV_FILE);
    expect(problem).toContain('NARUHODO_ANTHROPIC_KEY=op://');
  });

  it('rejects a file without the line, or with the key itself instead of a reference', () => {
    expect(opEnvProblem('OTHER=op://a/b/c\n')).toContain('NARUHODO_ANTHROPIC_KEY=op://');
    expect(opEnvProblem('NARUHODO_ANTHROPIC_KEY=sk-ant-plain\n')).toContain('NARUHODO_ANTHROPIC_KEY=op://');
  });
});
