import { execFile as execFileCb } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ENGINEER_RETENTION_MS,
  engineerRetentionDeadline,
  reconcileEngineerRetainedWorktrees,
  resolveEngineerRetentionMs,
  retireEngineerWorktree,
} from '../../../src/engine/engineer/retention.js';
import { EngineerRunStore } from '../../../src/engine/engineer/run-store.js';
import { writeEngineerRunMarker } from '../../../src/engine/engineer/run-marker.js';
import { ConductorEventEmitter } from '../../../src/ui/events.js';

const execFile = promisify(execFileCb);

describe('Engineer retained review worktrees', () => {
  it('resolves the bounded configuration with a 14-day default', () => {
    expect(resolveEngineerRetentionMs()).toBe(DEFAULT_ENGINEER_RETENTION_MS);
    expect(resolveEngineerRetentionMs({ engineer_review_retention_days: 30 })).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(resolveEngineerRetentionMs({ engineer_review_retention_days: 91 })).toBe(DEFAULT_ENGINEER_RETENTION_MS);
  });

  let base: string;
  let repoRoot: string;
  let engineerDir: string;
  let worktreePath: string;
  let store: EngineerRunStore;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'engineer-retention-'));
    repoRoot = join(base, 'repo');
    engineerDir = join(base, 'engineer');
    worktreePath = join(repoRoot, '.worktrees', 'engineer-plan');
    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ['init', '-b', 'main']);
    await git(repoRoot, ['config', 'user.email', 'test@example.com']);
    await git(repoRoot, ['config', 'user.name', 'Test']);
    await writeFile(join(repoRoot, 'README.md'), 'base\n', 'utf-8');
    await git(repoRoot, ['add', 'README.md']);
    await git(repoRoot, ['commit', '-m', 'base']);
    await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
    await git(repoRoot, ['worktree', 'add', '-b', 'spec/plan', worktreePath, 'main']);
    repoRoot = await realpath(repoRoot);
    worktreePath = await realpath(worktreePath);
    store = new EngineerRunStore({ engineerDir, events: new ConductorEventEmitter() });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function settledRun(outcome: 'pr_opened' | 'local_commit' = 'pr_opened') {
    const run = await store.create({ repoRoot, idea: 'Retain this spec' });
    await store.record(run.engineerRunId, {
      kind: 'readiness_checked',
      result: {
        status: 'ready', code: 'ready', summary: 'Ready', checkedCapabilities: ['repository'],
        retryable: false, remedy: null, diagnostic: null, fingerprint: 'ready-fixture',
      },
      permitInconclusive: false,
    });
    await store.record(run.engineerRunId, { kind: 'run_started' });
    await store.record(run.engineerRunId, {
      kind: 'worktree_created', worktreePath, branch: 'spec/plan', planSlug: 'plan',
    });
    await writeEngineerRunMarker(worktreePath, {
      schemaVersion: 1,
      engineerRunId: run.engineerRunId,
      repoRoot,
      planSlug: 'plan',
      branch: 'spec/plan',
    });
    await store.reconcileLand(run.engineerRunId, {
      planSlug: 'plan', track: 'technical', tier: 'S',
      completed: ['explore', 'complexity', 'stories', 'plan'],
      skipped: ['prd', 'architecture_diagram', 'architecture_review', 'conflict_check', 'coherence_check'],
    });
    const commit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    await store.record(run.engineerRunId, {
      kind: 'spec_handoff', planSlug: 'plan', branch: 'spec/plan',
      prUrl: outcome === 'pr_opened' ? 'https://github.com/example/repo/pull/1' : null,
      outcome,
      retainedCommit: commit,
      retentionDeadline: '2026-09-17T00:00:00.000Z',
    });
    return store.record(run.engineerRunId, { kind: 'run_settled', outcome: 'awaiting_spec_merge' });
  }

  it('records logical retirement before exact physical cleanup on PR merge', async () => {
    const run = await settledRun();
    let retiredBeforeRemoval = false;
    await reconcileEngineerRetainedWorktrees({
      store,
      deps: {
        git: gitRunner,
        now: () => new Date('2026-09-04T00:00:00.000Z'),
        readPullRequestState: async () => 'merged',
        removeWorktree: async (root, path) => {
          const snapshot = await store.inspectRun(run.engineerRunId);
          retiredBeforeRemoval = snapshot.retirement?.reason === 'spec_merged';
          await git(root, ['worktree', 'remove', '--force', path]);
        },
      },
    });

    expect(retiredBeforeRemoval).toBe(true);
    await expect(access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({
      state: 'settled',
      retirement: { reason: 'spec_merged' },
      cleanup: { status: 'complete', attempts: 1 },
    });
  });

  it('scopes daemon reconciliation through a repository index and backfills legacy metadata only', async () => {
    const ownRun = await store.create({ repoRoot, idea: 'Current repository run' });
    const otherRepo = join(base, 'other-repo');
    await mkdir(otherRepo, { recursive: true });
    await git(otherRepo, ['init', '-b', 'main']);
    const otherRun = await store.create({ repoRoot: otherRepo, idea: 'Other repository run' });

    await rm(join(engineerDir, 'lifecycle', 'indexes', 'repositories'), { recursive: true, force: true });
    await writeFile(
      join(engineerDir, 'lifecycle', 'runs', otherRun.engineerRunId, 'events.jsonl'),
      'corrupt journal that scoped reconciliation must not read\n',
      'utf-8',
    );

    const snapshotPath = join(engineerDir, 'lifecycle', 'runs', ownRun.engineerRunId, 'snapshot.json');
    const snapshotMtime = (await stat(snapshotPath)).mtimeMs;
    await expect(reconcileEngineerRetainedWorktrees({ store, repoRoot })).resolves.toBeUndefined();
    await expect(store.listRuns({ repoRoot })).resolves.toMatchObject([
      { engineerRunId: ownRun.engineerRunId, repoRoot },
    ]);
    expect((await stat(snapshotPath)).mtimeMs).toBe(snapshotMtime);
  });

  it('persists typed retirement-precondition evidence and backs off repeated daemon attempts', async () => {
    const run = await settledRun();
    await rm(join(worktreePath, '.pipeline', 'engineer-run.json'));
    const readPullRequestState = vi.fn(async () => 'merged' as const);
    const logs: string[] = [];

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:00:00.000Z'),
        readPullRequestState,
        log: (line) => logs.push(line),
      },
    });

    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({
      retirement: null,
      cleanup: {
        status: 'failed',
        stage: 'retirement_precondition',
        attempts: 1,
        nextAttemptAt: '2026-09-04T00:15:00.000Z',
        failure: {
          class: 'workspace',
          code: 'workspace_identity_mismatch',
          retryable: false,
        },
      },
    });
    expect(logs.at(-1)).toMatch(/cleanup marker does not match/);

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:01:00.000Z'),
        readPullRequestState,
      },
    });
    expect(readPullRequestState).toHaveBeenCalledTimes(1);
    expect((await store.inspectRun(run.engineerRunId)).cleanup?.attempts).toBe(1);

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:16:00.000Z'),
        readPullRequestState,
      },
    });
    expect(readPullRequestState).toHaveBeenCalledTimes(2);
    expect((await store.inspectRun(run.engineerRunId)).cleanup?.attempts).toBe(2);
  });

  it('persists typed PR-status failure evidence and backs off remote reconciliation', async () => {
    const run = await settledRun();
    const readPullRequestState = vi.fn()
      .mockRejectedValueOnce(new Error('could not resolve host github.com'))
      .mockResolvedValueOnce('open');

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:00:00.000Z'),
        readPullRequestState,
      },
    });

    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({
      retirement: null,
      cleanup: {
        status: 'failed',
        stage: 'retirement_status',
        attempts: 1,
        nextAttemptAt: '2026-09-04T00:15:00.000Z',
        failure: {
          class: 'remote',
          code: 'remote_unreachable',
          retryable: true,
        },
      },
    });

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:01:00.000Z'),
        readPullRequestState,
      },
    });
    expect(readPullRequestState).toHaveBeenCalledTimes(1);

    await reconcileEngineerRetainedWorktrees({
      store,
      repoRoot,
      deps: {
        now: () => new Date('2026-09-04T00:16:00.000Z'),
        readPullRequestState,
      },
    });
    expect(readPullRequestState).toHaveBeenCalledTimes(2);
    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({
      retirement: null,
      cleanup: {
        status: 'pending',
        stage: 'retirement_status',
        attempts: 2,
        nextAttemptAt: null,
        failure: null,
      },
    });
  });

  it('captures retained-commit drift as typed precondition evidence', async () => {
    const run = await settledRun('local_commit');
    await writeFile(join(worktreePath, 'review-change.txt'), 'changed after handoff\n', 'utf-8');
    await git(worktreePath, ['add', 'review-change.txt']);
    await git(worktreePath, ['commit', '-m', 'review change']);

    await expect(retireEngineerWorktree({
      store,
      engineerRunId: run.engineerRunId,
      reason: 'operator_cleanup',
      deps: { git: gitRunner, now: () => new Date('2026-09-04T00:00:00.000Z') },
    })).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({
      retirement: null,
      cleanup: {
        stage: 'retirement_precondition',
        failure: { code: 'workspace_identity_mismatch' },
      },
    });
  });

  it('keeps failed deletion as cleanup debt and retries without a second retirement event', async () => {
    const run = await settledRun('local_commit');
    const remove = vi.fn()
      .mockRejectedValueOnce(new Error('worktree is locked'))
      .mockImplementationOnce(async (root: string, path: string) => {
        await git(root, ['worktree', 'remove', '--force', path]);
      });

    const first = await retireEngineerWorktree({
      store,
      engineerRunId: run.engineerRunId,
      reason: 'operator_cleanup',
      deps: { git: gitRunner, removeWorktree: remove },
    });
    expect(first).toMatchObject({ retirement: { reason: 'operator_cleanup' }, cleanup: { status: 'failed', attempts: 1 } });
    expect((await store.replay(run.engineerRunId, 0)).filter((event) => event.type === 'engineer_worktree_retired')).toHaveLength(1);

    const second = await retireEngineerWorktree({
      store,
      engineerRunId: run.engineerRunId,
      reason: 'operator_cleanup',
      deps: { git: gitRunner, removeWorktree: remove },
    });
    expect(second.cleanup).toMatchObject({ status: 'complete', attempts: 2 });
    expect((await store.replay(run.engineerRunId, 0)).filter((event) => event.type === 'engineer_worktree_retired')).toHaveLength(1);
  });

  it('removes a stale Git registration before completing cleanup for an externally missing path', async () => {
    const run = await settledRun('local_commit');
    const retainedCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    await store.retireWorktree(run.engineerRunId, {
      reason: 'operator_cleanup',
      retainedCommit,
    });
    await rename(worktreePath, join(base, 'externally-moved-worktree'));
    const remove = vi.fn(async (root: string, path: string) => {
      await git(root, ['worktree', 'remove', '--force', path]);
    });

    const cleaned = await retireEngineerWorktree({
      store,
      engineerRunId: run.engineerRunId,
      reason: 'operator_cleanup',
      deps: { git: gitRunner, removeWorktree: remove },
    });

    expect(remove).toHaveBeenCalledWith(repoRoot, worktreePath);
    expect(cleaned.cleanup).toMatchObject({ status: 'complete', stage: 'physical_removal' });
    expect((await git(repoRoot, ['worktree', 'list', '--porcelain'])).stdout)
      .not.toContain(`worktree ${worktreePath}`);
  });

  it('retires local commits on the bounded timeout without consulting a PR', async () => {
    const run = await settledRun('local_commit');
    const prState = vi.fn();
    await reconcileEngineerRetainedWorktrees({
      store,
      deps: {
        git: gitRunner,
        now: () => new Date('2026-09-18T00:00:00.000Z'),
        readPullRequestState: prState,
        removeWorktree: async (root, path) => git(root, ['worktree', 'remove', '--force', path]).then(() => undefined),
      },
    });
    expect(prState).not.toHaveBeenCalled();
    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({ retirement: { reason: 'retention_expired' } });
  });

  it('retires an exact worktree when the specification PR closes without merge', async () => {
    const run = await settledRun();
    await reconcileEngineerRetainedWorktrees({
      store,
      deps: {
        git: gitRunner,
        now: () => new Date('2026-09-04T00:00:00.000Z'),
        readPullRequestState: async () => 'closed',
        removeWorktree: async (root, path) => git(root, ['worktree', 'remove', '--force', path]).then(() => undefined),
      },
    });
    expect(await store.inspectRun(run.engineerRunId)).toMatchObject({ retirement: { reason: 'spec_closed' } });
  });

  it('retires a cancelled run without consulting a PR', async () => {
    const created = await store.create({ repoRoot, idea: 'Cancelled spec' });
    await store.record(created.engineerRunId, {
      kind: 'readiness_checked',
      result: {
        status: 'ready', code: 'ready', summary: 'Ready', checkedCapabilities: ['repository'],
        retryable: false, remedy: null, diagnostic: null, fingerprint: 'ready-fixture',
      },
      permitInconclusive: false,
    });
    await store.record(created.engineerRunId, { kind: 'run_started' });
    await store.record(created.engineerRunId, {
      kind: 'worktree_created', worktreePath, branch: 'spec/plan', planSlug: 'plan',
    });
    await writeEngineerRunMarker(worktreePath, {
      schemaVersion: 1,
      engineerRunId: created.engineerRunId,
      repoRoot,
      planSlug: 'plan',
      branch: 'spec/plan',
    });
    await store.record(created.engineerRunId, { kind: 'run_cancelled', reason: 'Task cancelled' });
    const prState = vi.fn();
    await reconcileEngineerRetainedWorktrees({
      store,
      deps: {
        git: gitRunner,
        readPullRequestState: prState,
        removeWorktree: async (root, path) => git(root, ['worktree', 'remove', '--force', path]).then(() => undefined),
      },
    });
    expect(prState).not.toHaveBeenCalled();
    expect(await store.inspectRun(created.engineerRunId)).toMatchObject({
      state: 'cancelled',
      retirement: { reason: 'task_cancelled' },
    });
  });

  it('uses the selected 14-day default deadline', () => {
    expect(engineerRetentionDeadline(new Date('2026-09-03T00:00:00.000Z')))
      .toBe('2026-09-17T00:00:00.000Z');
  });
});

async function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  const result = await execFile('git', args, { cwd });
  return { stdout: String(result.stdout) };
}

async function gitRunner(args: string[], options: { cwd: string }): Promise<{ stdout: string }> {
  return git(options.cwd, args);
}
