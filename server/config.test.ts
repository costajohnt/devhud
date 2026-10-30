import { test, expect, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'jd-'));

test('loads config and applies defaults', () => {
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' }
  }));
  const c = loadConfig(p);
  expect(c.port).toBe(3010);
  expect(c.jira.statuses.inTest).toBe('In Test');
  expect(c.jira.statuses.blocked).toBe('Blocked');
  expect(c.writeEnabled).toBe(false); // off by default
});

test('writeEnabled: true is normalized through untouched', () => {
  const p = join(dir, 'write-enabled.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    writeEnabled: true,
  }));
  expect(loadConfig(p).writeEnabled).toBe(true);
});

test.each(['DEVHUD_DEMO', 'SIMON_DASH_DEMO', 'JIRA_DASH_DEMO'])('%s=1 turns on demo mode', (name) => {
  const p = join(dir, `demo-env-${name}.json`);
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  process.env[name] = '1';
  try {
    expect(loadConfig(p).demo).toBe(true);
  } finally {
    delete process.env[name];
  }
});

test('throws readable error when missing', () => {
  expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/config/i);
});

test('throws readable error on invalid JSON', () => {
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{ not json');
  expect(() => loadConfig(p)).toThrow(/not valid JSON/);
});

test('throws readable error when jira or github key missing', () => {
  const p = join(dir, 'missing-key.json');
  writeFileSync(p, JSON.stringify({ github: { org: 'o', repos: ['r'], username: 'u' } }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira"/);
});

test('throws when jira.projectKey or jira.accountId missing', () => {
  const p = join(dir, 'missing-jira-fields.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira.projectKey"/);
});

test('throws when github.username or github.org missing', () => {
  const p = join(dir, 'missing-github-fields.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { repos: ['r'] },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "github.username"/);
});

test('throws when jira.baseUrl/email/apiToken missing outside demo mode', () => {
  const p = join(dir, 'missing-jira-creds.json');
  writeFileSync(p, JSON.stringify({
    jira: { projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  expect(() => loadConfig(p)).toThrow(/missing required key "jira.baseUrl"/);
});

test('jira.baseUrl/email/apiToken are not required in demo mode', () => {
  const p = join(dir, 'demo-no-creds.json');
  writeFileSync(p, JSON.stringify({
    jira: { projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
    demo: true,
  }));
  expect(loadConfig(p).demo).toBe(true);
});

test('loadConfig warns when config.json is group/world-readable (0644)', () => {
  const p = join(dir, 'loose-perms.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  chmodSync(p, 0o644);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadConfig(p);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  warnSpy.mockRestore();
});

test('loadConfig does not warn when config.json is already 0600', () => {
  const p = join(dir, 'tight-perms.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  chmodSync(p, 0o600);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadConfig(p);
  expect(warnSpy).not.toHaveBeenCalled();
  warnSpy.mockRestore();
});

test('accepts a valid explicit port at both ends of the range, including 0 (OS-assigned)', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p0 = join(dir, 'port-zero.json');
  // 0 is Node's own convention for "bind to any free port" (server.listen(0)),
  // relied on throughout this suite's own test servers — not an edge case to reject.
  writeFileSync(p0, JSON.stringify({ ...base, port: 0 }));
  expect(loadConfig(p0).port).toBe(0);
  const p1 = join(dir, 'port-min.json');
  writeFileSync(p1, JSON.stringify({ ...base, port: 1 }));
  expect(loadConfig(p1).port).toBe(1);
  const p2 = join(dir, 'port-max.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: 65535 }));
  expect(loadConfig(p2).port).toBe(65535);
});

test('throws a readable error for a port outside 0-65535', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p2 = join(dir, 'port-too-big.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: 65536 }));
  expect(() => loadConfig(p2)).toThrow(/invalid "port"/);
  const p3 = join(dir, 'port-negative.json');
  writeFileSync(p3, JSON.stringify({ ...base, port: -1 }));
  expect(() => loadConfig(p3)).toThrow(/invalid "port"/);
});

test('throws a readable error for a non-integer port (fraction or string)', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p1 = join(dir, 'port-fraction.json');
  writeFileSync(p1, JSON.stringify({ ...base, port: 3010.5 }));
  expect(() => loadConfig(p1)).toThrow(/invalid "port"/);
  const p2 = join(dir, 'port-string.json');
  writeFileSync(p2, JSON.stringify({ ...base, port: '3010' }));
  expect(() => loadConfig(p2)).toThrow(/invalid "port"/);
});

test('rejects config values that would rewrite downstream queries/paths (JQL, GitHub URL)', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const cases: [string, object][] = [
    ['bad-projectkey', { ...base, jira: { ...base.jira, projectKey: 'PROJ" OR project = "X' } }],
    ['bad-accountid', { ...base, jira: { ...base.jira, accountId: 'id" OR x="y' } }],
    ['bad-org', { ...base, github: { ...base.github, org: 'o/../other' } }],
    ['bad-repo', { ...base, github: { ...base.github, repos: ['r?per_page=1'] } }],
  ];
  for (const [name, cfg] of cases) {
    const p = join(dir, `${name}.json`);
    writeFileSync(p, JSON.stringify(cfg));
    expect(() => loadConfig(p), name).toThrow(/invalid "(jira\.(projectKey|accountId)|github\.(org|repos))"/);
  }
  // Qualified "owner/name" entries are a supported fetchPrs form (cross-org
  // repos) and must pass — exactly one slash.
  const ok = join(dir, 'qualified-repo.json');
  writeFileSync(ok, JSON.stringify({ ...base, github: { ...base.github, repos: ['r', 'otherorg/svc'] } }));
  expect(loadConfig(ok).github.repos).toEqual(['r', 'otherorg/svc']);
  const twoSlashes = join(dir, 'two-slash-repo.json');
  writeFileSync(twoSlashes, JSON.stringify({ ...base, github: { ...base.github, repos: ['a/b/c'] } }));
  expect(() => loadConfig(twoSlashes)).toThrow(/invalid "github\.repos"/);
});

test('passes refreshIntervalSeconds through and leaves it undefined when absent', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  const p0 = join(dir, 'interval-absent.json');
  writeFileSync(p0, JSON.stringify(base));
  expect(loadConfig(p0).refreshIntervalSeconds).toBeUndefined();
  const p1 = join(dir, 'interval-set.json');
  writeFileSync(p1, JSON.stringify({ ...base, refreshIntervalSeconds: 60 }));
  expect(loadConfig(p1).refreshIntervalSeconds).toBe(60);
});

test('throws a readable error for a non-positive or non-integer refreshIntervalSeconds', () => {
  const base = { jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' } };
  for (const [name, value] of [['zero', 0], ['negative', -5], ['fraction', 1.5], ['string', '60']] as const) {
    const p = join(dir, `interval-${name}.json`);
    writeFileSync(p, JSON.stringify({ ...base, refreshIntervalSeconds: value }));
    expect(() => loadConfig(p)).toThrow(/invalid "refreshIntervalSeconds"/);
  }
});

// --- Multi-identity (#108) ---

const baseJira = { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' };

test('multi-identity: identities array is normalised; each token is resolved from env', () => {
  const p = join(dir, 'multi-id.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: {
      org: 'myorg',
      identities: [
        { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['myorg/repo1'] },
        { username: 'personal-user', tokenEnv: 'GH_TOKEN_PERSONAL', repos: ['otherorg/repo2'] },
      ],
    },
  }));
  process.env.GH_TOKEN_WORK = 'tok-work';
  process.env.GH_TOKEN_PERSONAL = 'tok-personal';
  try {
    const cfg = loadConfig(p);
    expect(cfg.github.identities).toHaveLength(2);
    expect(cfg.github.identities![0]).toEqual({ username: 'work-user', token: 'tok-work', repos: ['myorg/repo1'] });
    expect(cfg.github.identities![1]).toEqual({ username: 'personal-user', token: 'tok-personal', repos: ['otherorg/repo2'] });
    expect(cfg.github.usernames).toEqual(['work-user', 'personal-user']);
    // Legacy fields are derived from the first identity.
    expect(cfg.github.username).toBe('work-user');
    expect(cfg.github.token).toBe('tok-work');
    // Repos is the union across identities.
    expect(cfg.github.repos).toEqual(['myorg/repo1', 'otherorg/repo2']);
  } finally {
    delete process.env.GH_TOKEN_WORK;
    delete process.env.GH_TOKEN_PERSONAL;
  }
});

test('multi-identity: single-identity config is also normalised to identities array', () => {
  const p = join(dir, 'single-id-normalised.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: { org: 'o', repos: ['r'], username: 'u', token: 'tok' },
  }));
  const cfg = loadConfig(p);
  expect(cfg.github.identities).toHaveLength(1);
  expect(cfg.github.identities![0]).toMatchObject({ username: 'u', token: 'tok', repos: ['r'] });
  expect(cfg.github.usernames).toEqual(['u']);
});

test('multi-identity: missing tokenEnv or username in an identity throws a readable error', () => {
  const base2 = { jira: baseJira, github: { org: 'o' } };

  const noUser = join(dir, 'id-no-username.json');
  writeFileSync(noUser, JSON.stringify({ ...base2, github: { org: 'o',
    identities: [{ tokenEnv: 'GH_TOKEN_WORK', repos: [] }] } }));
  expect(() => loadConfig(noUser)).toThrow(/identities\[0\]\.username/);

  const noEnv = join(dir, 'id-no-tokenenv.json');
  writeFileSync(noEnv, JSON.stringify({ ...base2, github: { org: 'o',
    identities: [{ username: 'u', repos: [] }] } }));
  expect(() => loadConfig(noEnv)).toThrow(/identities\[0\]\.tokenEnv/);
});

test('multi-identity: unset tokenEnv env var throws a readable error at load time', () => {
  const p = join(dir, 'id-unset-env.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: { org: 'o', identities: [
      { username: 'u', tokenEnv: 'GH_TOKEN_DEFINITELY_NOT_SET_XYZ123', repos: [] },
    ] },
  }));
  delete process.env.GH_TOKEN_DEFINITELY_NOT_SET_XYZ123;
  expect(() => loadConfig(p)).toThrow(/GH_TOKEN_DEFINITELY_NOT_SET_XYZ123.*is not set/);
});

test('multi-identity: invalid repo entry inside identities throws a readable error', () => {
  const p = join(dir, 'id-bad-repo.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: { org: 'o', identities: [
      { username: 'u', tokenEnv: 'GH_TOKEN_WORK', repos: ['bad repo?'] },
    ] },
  }));
  expect(() => loadConfig(p)).toThrow(/identities\[0\]\.repos/);
});

test('multi-identity: a catch-all identity (no repos) covers the top-level github.repos list', () => {
  const p = join(dir, 'id-catch-all.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: { org: 'acme', repos: ['webapp', 'api'], identities: [
      { username: 'personal-user', tokenEnv: 'GH_TOKEN_PERSONAL', repos: ['me/side'] },
      { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK' },
    ] },
  }));
  process.env.GH_TOKEN_WORK = 'tok-work';
  process.env.GH_TOKEN_PERSONAL = 'tok-personal';
  try {
    const cfg = loadConfig(p);
    // Top-level repos are kept (not dropped), unioned with identity repos.
    expect(cfg.github.repos).toEqual(['webapp', 'api', 'me/side']);
    expect(cfg.github.identities![1]).toEqual({ username: 'work-user', token: 'tok-work', repos: [] });
  } finally {
    delete process.env.GH_TOKEN_WORK;
    delete process.env.GH_TOKEN_PERSONAL;
  }
});

test('multi-identity: more than one catch-all identity is a config error', () => {
  const p = join(dir, 'id-two-catch-alls.json');
  writeFileSync(p, JSON.stringify({
    jira: baseJira,
    github: { org: 'acme', repos: ['webapp'], identities: [
      { username: 'a', tokenEnv: 'GH_TOKEN_WORK' },
      { username: 'b', tokenEnv: 'GH_TOKEN_WORK' },
    ] },
  }));
  process.env.GH_TOKEN_WORK = 'tok-work';
  try {
    expect(() => loadConfig(p)).toThrow(/at most one github\.identities entry may omit "repos"/);
  } finally {
    delete process.env.GH_TOKEN_WORK;
  }
});

// Writes a multi-identity config with both tokens set and returns loadConfig's result (or throw).
function loadIdentities(name: string, github: Record<string, unknown>) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ jira: baseJira, github: { org: 'acme', ...github } }));
  process.env.GH_TOKEN_WORK = 'tok-work';
  process.env.GH_TOKEN_PERSONAL = 'tok-personal';
  try { return loadConfig(p); } finally {
    delete process.env.GH_TOKEN_WORK;
    delete process.env.GH_TOKEN_PERSONAL;
  }
}

test('multi-identity: a top-level repo no identity owns, with no catch-all, is a config error', () => {
  expect(() => loadIdentities('id-unowned.json', { repos: ['webapp', 'api'], identities: [
    { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['webapp'] },
    { username: 'personal-user', tokenEnv: 'GH_TOKEN_PERSONAL', repos: ['me/side'] },
  ] })).toThrow(/"acme\/api" is in github\.repos but no github\.identities entry lists it.*catch-all/);
});

test('multi-identity: top-level repos all claimed by explicit identities need no catch-all', () => {
  const cfg = loadIdentities('id-all-claimed.json', { repos: ['webapp'], identities: [
    { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['acme/webapp'] },
  ] });
  expect(cfg.github.repos).toEqual(['webapp']);
});

test('multi-identity: a repo listed under two identities is a config error', () => {
  expect(() => loadIdentities('id-double-claim.json', { identities: [
    { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['svc'] },
    { username: 'personal-user', tokenEnv: 'GH_TOKEN_PERSONAL', repos: ['acme/svc'] },
  ] })).toThrow(/"acme\/svc" is listed under more than one github\.identities entry/);
});

test('multi-identity: case-variant duplicate repos are a config error', () => {
  expect(() => loadIdentities('id-case-dup.json', { repos: ['WebApp'], identities: [
    { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['acme/webapp'] },
  ] })).toThrow(/"acme\/WebApp" and "acme\/webapp" differ only in case/);
  expect(() => loadIdentities('id-case-dup2.json', { identities: [
    { username: 'work-user', tokenEnv: 'GH_TOKEN_WORK', repos: ['Svc'] },
    { username: 'personal-user', tokenEnv: 'GH_TOKEN_PERSONAL', repos: ['svc'] },
  ] })).toThrow(/differ only in case/);
});

test('jira.statuses accepts lists and rejects empty or non-string entries', () => {
  const base = {
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  };
  const ok = join(dir, 'statuses-list.json');
  writeFileSync(ok, JSON.stringify({ ...base, jira: { ...base.jira, statuses: { review: ['Code Review', 'PR Review'] } } }));
  expect(loadConfig(ok).jira.statuses.review).toEqual(['Code Review', 'PR Review']);
  expect(loadConfig(ok).jira.statuses.inTest).toBe('In Test');
  for (const [name, v] of [['empty', []], ['blank', ['']], ['number', 5]] as const) {
    const p = join(dir, `statuses-${name}.json`);
    writeFileSync(p, JSON.stringify({ ...base, jira: { ...base.jira, statuses: { inTest: v } } }));
    expect(() => loadConfig(p)).toThrow(/invalid "jira.statuses.inTest"/);
  }
});

test('ignoreAuthors defaults to Rovo only', () => {
  const p = join(dir, 'ignore-default.json');
  writeFileSync(p, JSON.stringify({
    jira: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't', projectKey: 'PROJ', accountId: 'id' },
    github: { org: 'o', repos: ['r'], username: 'u' },
  }));
  expect(loadConfig(p).ignoreAuthors).toEqual(['Rovo']);
});
