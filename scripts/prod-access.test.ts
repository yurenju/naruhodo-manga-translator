import { describe, expect, it } from 'vitest';
import {
  formatLogEvents,
  isLocalClient,
  logsQueryBody,
  MAX_LOG_LIMIT,
  parseDuration,
  parseLogsRequest,
  PROXY_PORT,
  readOnlySqlProblem,
  readonlyEnvProblem,
  WORKER_NAME,
} from './prod-access.ts';

describe('readOnlySqlProblem', () => {
  it.each([
    'SELECT * FROM accounts LIMIT 5',
    'select count(*) from usage;',
    '  -- 最近的\nSELECT id FROM accounts ORDER BY created_at DESC',
    'WITH recent AS (SELECT * FROM usage) SELECT * FROM recent',
    'EXPLAIN QUERY PLAN SELECT * FROM accounts',
    'PRAGMA table_info(accounts)',
    "SELECT * FROM audit WHERE note = 'delete; drop table'",
    'SELECT "update" FROM t',
    "SELECT replace(email, '@', ' at ') FROM accounts",
    "SELECT 'it''s; DELETE' AS note",
    'SELECT [weird;name] FROM t',
    'PRAGMA user_version',
    'PRAGMA main.index_list(accounts)',
  ])('放行唯讀語句：%s', (sql) => {
    expect(readOnlySqlProblem(sql)).toBeUndefined();
  });

  it.each([
    ['DELETE FROM accounts', 'DELETE'],
    ['UPDATE accounts SET plan = 1', 'UPDATE'],
    ['SELECT 1; DELETE FROM accounts', '一個語句'],
    ['WITH x AS (SELECT 1) DELETE FROM accounts', 'DELETE'],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'INSERT'],
    ['PRAGMA user_version = 3', 'PRAGMA'],
    ['WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x', 'REPLACE'],
    // 註解裡的引號不能把後面的語句藏成字串（code review 找到的繞過）
    ["SELECT 1 -- '\n; DELETE FROM accounts; --'", '一個語句'],
    ["SELECT 1 /* ' */ ; DELETE FROM accounts; /* ' */", '一個語句'],
    ["SELECT 1 -- '\nUNION SELECT 1 FROM (DELETE FROM accounts) --'", 'DELETE'],
    ["SELECT 'unterminated", '引號'],
    ['PRAGMA foreign_keys(0)', 'PRAGMA foreign_keys'],
    ['PRAGMA main.user_version(3)', 'PRAGMA user_version'],
    ['/* SELECT */ DROP TABLE accounts', 'DROP'],
    ['', '空'],
  ])('擋下：%s', (sql, reason) => {
    expect(readOnlySqlProblem(sql)).toContain(reason);
  });
});

describe('readonlyEnvProblem', () => {
  const ok = { CLOUDFLARE_API_TOKEN: 'op://Dev/cf-readonly/credential', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };

  it('op:// 參照加上 Account ID 就能用', () => {
    expect(readonlyEnvProblem(ok)).toBeUndefined();
  });

  it('檔案不存在、token 不是參照、Account ID 不對都說明怎麼建立', () => {
    expect(readonlyEnvProblem(undefined)).toContain('找不到');
    expect(readonlyEnvProblem({ ...ok, CLOUDFLARE_API_TOKEN: 'plain-token' })).toContain('op://');
    expect(readonlyEnvProblem({ ...ok, CLOUDFLARE_ACCOUNT_ID: 'nope' })).toContain('CLOUDFLARE_ACCOUNT_ID');
  });
});

describe('parseDuration', () => {
  it('分、時、天換成毫秒', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('看不懂的格式回傳 undefined', () => {
    expect(parseDuration('1w')).toBeUndefined();
    expect(parseDuration('h')).toBeUndefined();
  });
});

describe('logs 查詢', () => {
  it('只查 naruhodo-api，時間範圍從 now 往回算', () => {
    const body = logsQueryBody({ sinceMs: 3_600_000, search: 'error' }, 10_000_000);

    expect(body.timeframe).toEqual({ from: 6_400_000, to: 10_000_000 });
    expect(body.parameters.filters).toEqual([{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: WORKER_NAME }]);
    expect(body.parameters.needle).toEqual({ value: 'error', matchCase: false });
  });

  it('筆數限制在 1 到上限之間', () => {
    expect(logsQueryBody({ sinceMs: 1, limit: 5000 }, 0).limit).toBe(MAX_LOG_LIMIT);
    expect(logsQueryBody({ sinceMs: 1, limit: 0 }, 0).limit).toBe(1);
  });

  it('proxy 只接受 7 天內的時間範圍', () => {
    expect(parseLogsRequest({ sinceMs: 3_600_000 })).toEqual({ sinceMs: 3_600_000, search: undefined, limit: undefined });
    expect(parseLogsRequest({ sinceMs: 8 * 86_400_000 })).toContain('7 天');
    expect(parseLogsRequest({ sinceMs: 'x' })).toContain('sinceMs');
    expect(parseLogsRequest(null)).toContain('JSON');
  });

  it('events 依時間排序，一行一筆', () => {
    const lines = formatLogEvents({
      result: {
        events: {
          events: [
            // 請求事件的形狀照 production 的實際回應
            {
              timestamp: 3000,
              $metadata: { level: 'info', type: 'cf-worker-event', trigger: 'POST /v1/translate', message: 'POST https://api.example/v1/translate' },
              $workers: { outcome: 'ok', wallTimeMs: 2851, event: { response: { status: 200 } } },
            },
            {
              timestamp: 2000,
              $metadata: { level: 'error', type: 'cf-worker-event', trigger: 'POST /v1/notes', error: 'boom' },
              $workers: { outcome: 'exception', wallTimeMs: 12 },
            },
            { timestamp: 1000, $metadata: { level: 'log', type: 'cf-worker', message: { msg: 'start' } } },
          ],
        },
      },
    });

    expect(lines).toEqual([
      '1970-01-01T00:00:01.000Z log {"msg":"start"}',
      '1970-01-01T00:00:02.000Z error POST /v1/notes - 12ms exception boom',
      '1970-01-01T00:00:03.000Z info POST /v1/translate 200 2851ms',
    ]);
  });

  it('認不出回應的結構就回傳 undefined', () => {
    expect(formatLogEvents({ result: {} })).toBeUndefined();
  });
});

describe('isLocalClient', () => {
  it('本機 CLI：Host 是 proxy、沒有 Origin', () => {
    expect(isLocalClient({ host: `127.0.0.1:${PROXY_PORT}` })).toBe(true);
  });

  it('瀏覽器裡的網頁（有 Origin）或改過 Host（DNS rebinding）都擋', () => {
    expect(isLocalClient({ host: `127.0.0.1:${PROXY_PORT}`, origin: 'https://evil.example' })).toBe(false);
    expect(isLocalClient({ host: `evil.example:${PROXY_PORT}` })).toBe(false);
  });
});
