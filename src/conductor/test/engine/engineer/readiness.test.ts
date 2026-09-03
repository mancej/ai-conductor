import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkEngineerReadiness, recordEngineerReadiness, type EngineerReadinessCommandRunner } from '../../../src/engine/engineer/readiness.js';
import { EngineerRunStore } from '../../../src/engine/engineer/run-store.js';
import { ConductorEventEmitter } from '../../../src/ui/events.js';

describe('Engineer readiness', () => {
  let repoRoot: string;
  let engineerDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'engineer-readiness-repo-'));
    engineerDir = await mkdtemp(join(tmpdir(), 'engineer-readiness-state-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(engineerDir, { recursive: true, force: true });
  });

  function runner(overrides: Partial<Record<string, { exitCode: number; stdout: string; stderr: string }>> = {}): EngineerReadinessCommandRunner {
    return async (command, args, options) => {
      const key = `${command} ${args.join(' ')}`;
      if (overrides[key]) return overrides[key];
      if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: options.cwd, stderr: '' };
      if (key === 'git remote get-url origin') return { exitCode: 0, stdout: 'git@github.com:example/repo.git', stderr: '' };
      if (key === 'git ls-remote --exit-code origin HEAD') return { exitCode: 0, stdout: 'a'.repeat(40), stderr: '' };
      if (key === 'gh auth status') return { exitCode: 0, stdout: 'authenticated', stderr: '' };
      return { exitCode: 0, stdout: `${command} version 1`, stderr: '' };
    };
  }

  it('returns bounded inconclusive evidence for a non-mutating remote probe', async () => {
    const result = await checkEngineerReadiness({
      repoRoot,
      githubHandoff: true,
      requiredTools: ['codex', 'mmdc'],
      hostPosture: 'mission-control-pre-reservation',
    }, { run: runner(), path: '/test/bin' });

    expect(result).toMatchObject({
      status: 'inconclusive',
      code: 'push_authorization_unproven',
      retryable: true,
    });
    expect(result.checkedCapabilities).toEqual(expect.arrayContaining([
      'repository', 'git', 'tool:codex', 'tool:mmdc', 'remote_reachability', 'github_authentication',
    ]));
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await new EngineerRunStore({ engineerDir, events: new ConductorEventEmitter() }).listRuns()).toEqual([]);
  });

  it('classifies and redacts a missing tool without leaking credentials', async () => {
    const result = await checkEngineerReadiness({
      repoRoot,
      githubHandoff: true,
      requiredTools: ['codex'],
    }, {
      run: runner({
        'codex --version': {
          exitCode: 127,
          stdout: '',
          stderr: 'command not found token=github_pat_abcdefghijklmnopqrstuvwxyz123456',
        },
      }),
    });

    expect(result).toMatchObject({ status: 'blocked', code: 'tool_missing', retryable: true });
    expect(result.diagnostic).not.toContain('github_pat_');
    expect(result.diagnostic).toContain('[REDACTED');
  });

  it('records readiness only on the exact non-terminal run', async () => {
    const store = new EngineerRunStore({ engineerDir, events: new ConductorEventEmitter() });
    const run = await store.create({ repoRoot, idea: 'Ready work' });
    const ready = await recordEngineerReadiness({
      store,
      engineerRunId: run.engineerRunId,
      readiness: { repoRoot, githubHandoff: true },
      permitInconclusive: true,
      deps: { run: runner() },
    });
    expect(ready).toMatchObject({ readiness: { status: 'inconclusive', permitted: true }, eventRevision: 2 });
    await store.record(run.engineerRunId, { kind: 'run_failed', failure: {
      error: 'provider failed', class: 'provider', code: 'provider_failed', summary: 'Provider failed.',
      retryable: true, remedy: 'Retry safely.', diagnostic: null,
    } });
    await expect(recordEngineerReadiness({
      store,
      engineerRunId: run.engineerRunId,
      readiness: { repoRoot, githubHandoff: false },
      permitInconclusive: false,
      deps: { run: runner() },
    })).rejects.toMatchObject({ code: 'terminal_run' });
  });
});
