import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINEER_LIFECYCLE_CAPABILITY,
  EngineerLifecycleError,
  EngineerRunStore,
  type EngineerRunSnapshot,
} from '../../../src/engine/engineer/run-store.js';
import { EventPersister } from '../../../src/engine/event-persister.js';
import type { EngineerLifecycleEvent } from '../../../src/types/index.js';
import { ConductorEventEmitter } from '../../../src/ui/events.js';

describe('EngineerRunStore', () => {
  let engineerDir: string;
  let repoRoot: string;
  let events: ConductorEventEmitter;

  beforeEach(async () => {
    engineerDir = await mkdtemp(join(tmpdir(), 'engineer-lifecycle-'));
    repoRoot = await mkdtemp(join(tmpdir(), 'engineer-lifecycle-repo-'));
    events = new ConductorEventEmitter();
  });

  afterEach(async () => {
    await rm(engineerDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  function store(): EngineerRunStore {
    return new EngineerRunStore({ engineerDir, events });
  }

  async function markReady(
    run: EngineerRunSnapshot,
    status: 'ready' | 'inconclusive' = 'ready',
  ): Promise<EngineerRunSnapshot> {
    return store().record(run.engineerRunId, {
      kind: 'readiness_checked',
      result: {
        status,
        code: status === 'ready' ? 'ready' : 'push_authorization_unproven',
        summary: status === 'ready' ? 'Engineer prerequisites are ready' : 'Push authorization is unproven',
        checkedCapabilities: ['repository', 'git', 'remote'],
        retryable: status !== 'ready',
        remedy: status === 'ready' ? null : 'Retry the handoff authorization check before push.',
        diagnostic: status === 'ready' ? null : 'Read-only remote probe succeeded.',
        fingerprint: 'readiness-fingerprint',
      },
      permitInconclusive: status === 'inconclusive',
    });
  }

  async function create(
    overrides: Partial<{ correlationId: string; attemptKey: string; idea: string }> = {},
  ): Promise<EngineerRunSnapshot> {
    return store().create({
      repoRoot,
      idea: overrides.idea ?? 'Add a health check',
      correlationId: overrides.correlationId ?? 'corr-1',
      attemptKey: overrides.attemptKey ?? 'launch-1',
    });
  }

  it('advertises the complete machine-readable capability', () => {
    expect(ENGINEER_LIFECYCLE_CAPABILITY).toBe('engineerLifecycleEventsV1');
  });

  it('creates one durable run and is idempotent for the same correlation and attempt key', async () => {
    const first = await create();
    const second = await create();

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      correlationId: 'corr-1',
      attemptKey: 'launch-1',
      attempt: 1,
      previousEngineerRunId: null,
      repoRoot,
      idea: 'Add a health check',
      eventRevision: 1,
      state: 'created',
      capability: 'engineerLifecycleEventsV1',
    });
    expect(await store().replay(first.engineerRunId, 0)).toHaveLength(1);
  });

  it('does not report create success before asynchronous journal persistence completes', async () => {
    type PersistTarget = {
      persist: (event: EngineerLifecycleEvent) => void | Promise<void>;
    };
    const target = EventPersister.prototype as unknown as PersistTarget;
    const originalPersist = target.persist;
    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const started = new Promise<void>((resolve) => { persistenceStarted = resolve; });
    const persistSpy = vi.spyOn(target, 'persist').mockImplementation(function persistAfterRelease(
      this: PersistTarget,
      event,
    ) {
      persistenceStarted();
      return blocked.then(() => originalPersist.call(this, event));
    });

    try {
      const durableStore = new EngineerRunStore({
        engineerDir,
        events,
        id: () => 'engineer-run-fixed',
      });
      const creation = durableStore.create({
        repoRoot,
        idea: 'Add a health check',
        correlationId: 'corr-async',
        attemptKey: 'launch-async',
      });
      await started;

      const stateBeforeRelease = await Promise.race([
        creation.then(() => 'settled', () => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(stateBeforeRelease).toBe('pending');

      releasePersistence();
      await expect(creation).resolves.toMatchObject({
        engineerRunId: 'engineer-run-fixed',
        eventRevision: 1,
      });
    } finally {
      releasePersistence();
      persistSpy.mockRestore();
    }
  });

  it('propagates asynchronous journal persistence failures without advancing durable state', async () => {
    const durableStore = store();
    const run = await durableStore.create({
      repoRoot,
      idea: 'Add a health check',
      correlationId: 'corr-persist-failure',
      attemptKey: 'launch-persist-failure',
    });
    await durableStore.record(run.engineerRunId, {
      kind: 'readiness_checked',
      result: {
        status: 'ready', code: 'ready', summary: 'Ready', checkedCapabilities: ['repository'],
        retryable: false, remedy: null, diagnostic: null, fingerprint: 'ready-fixture',
      },
      permitInconclusive: false,
    });
    type PersistTarget = {
      persist: (event: EngineerLifecycleEvent) => void | Promise<void>;
    };
    const target = EventPersister.prototype as unknown as PersistTarget;
    const persistenceError = new Error('async journal append failed');
    const persistSpy = vi.spyOn(target, 'persist').mockImplementation(async () => {
      await Promise.resolve();
      throw persistenceError;
    });

    try {
      await expect(durableStore.record(run.engineerRunId, { kind: 'run_started' }))
        .rejects.toBe(persistenceError);
    } finally {
      persistSpy.mockRestore();
    }

    expect(await durableStore.replay(run.engineerRunId, 0)).toHaveLength(2);
    expect(await durableStore.inspectRun(run.engineerRunId)).toMatchObject({
      eventRevision: 2,
      state: 'created',
    });
  });

  it('refuses attempt-key input drift, cross-repository correlation reuse, and a second live attempt', async () => {
    await create();

    await expect(create({ idea: 'Different idea' })).rejects.toMatchObject({ code: 'attempt_key_collision' });

    const otherRepo = await mkdtemp(join(tmpdir(), 'engineer-lifecycle-other-'));
    try {
      await expect(store().create({
        repoRoot: otherRepo,
        idea: 'Add a health check',
        correlationId: 'corr-1',
        attemptKey: 'launch-2',
      })).rejects.toMatchObject({ code: 'correlation_repository_collision' });
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }

    await expect(create({ attemptKey: 'launch-2' })).rejects.toMatchObject({ code: 'live_attempt_exists' });
  });

  it('creates an immutable correlated successor with its own revision cursor', async () => {
    const first = await create();
    await markReady(first);
    await store().record(first.engineerRunId, { kind: 'run_started' });
    await store().record(first.engineerRunId, {
      kind: 'run_failed',
      failure: {
        error: 'host exited',
        class: 'provider',
        code: 'provider_failed',
        summary: 'Provider host exited',
        retryable: true,
        remedy: 'Retry with a new reserved attempt.',
        diagnostic: null,
      },
    });

    const second = await create({ attemptKey: 'launch-2' });
    expect(second).toMatchObject({
      attempt: 2,
      previousEngineerRunId: first.engineerRunId,
      eventRevision: 1,
      state: 'created',
    });
    expect(second.engineerRunId).not.toBe(first.engineerRunId);

    await expect(store().record(first.engineerRunId, { kind: 'run_started' })).rejects.toMatchObject({
      code: 'terminal_run',
    });
    expect(await store().replay(first.engineerRunId, 0)).toHaveLength(4);
    expect(await store().replay(second.engineerRunId, 0)).toHaveLength(1);
  });

  it('allocates strictly monotonic revisions under concurrent appends', async () => {
    const run = await create();
    await markReady(run);
    await store().record(run.engineerRunId, { kind: 'run_started' });

    await Promise.all([
      store().record(run.engineerRunId, { kind: 'step_started', step: 'explore' }),
      store().record(run.engineerRunId, { kind: 'step_started', step: 'complexity' }),
      store().record(run.engineerRunId, { kind: 'step_started', step: 'prd' }),
    ]);

    const replay = await store().replay(run.engineerRunId, 0);
    expect(replay.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store().inspectRun(run.engineerRunId)).eventRevision).toBe(6);
  });

  it('does not scan unrelated historical metadata when creating a run', async () => {
    const historical = await create();
    await writeFile(
      join(engineerDir, 'lifecycle', 'runs', historical.engineerRunId, 'metadata.json'),
      '{broken',
      'utf-8',
    );

    await expect(create({
      correlationId: 'unrelated-correlation',
      attemptKey: 'unrelated-attempt',
      idea: 'Add another health check',
    })).resolves.toMatchObject({
      correlationId: 'unrelated-correlation',
      attemptKey: 'unrelated-attempt',
      attempt: 1,
    });
  });

  it('does not serialize lifecycle writes for unrelated runs', async () => {
    const first = await create();
    const second = await create({ correlationId: 'corr-2', attemptKey: 'launch-2', idea: 'Other work' });
    await markReady(first);
    await markReady(second);
    await store().record(first.engineerRunId, { kind: 'run_started' });
    await store().record(second.engineerRunId, { kind: 'run_started' });

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    events.on('engineer_step_started', async (event) => {
      if (event.type === 'engineer_step_started' && event.engineerRunId === first.engineerRunId) {
        firstEntered();
        await blocked;
      }
    });

    const firstWrite = store().record(first.engineerRunId, { kind: 'step_started', step: 'explore' });
    await entered;
    try {
      await expect(Promise.race([
        store().record(second.engineerRunId, { kind: 'step_started', step: 'explore' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('unrelated write stayed blocked')), 500)),
      ])).resolves.toMatchObject({ engineerRunId: second.engineerRunId, eventRevision: 4 });
    } finally {
      releaseFirst();
      await firstWrite;
    }
  });

  it('keeps unrelated concurrent spine events out of the run-local journal', async () => {
    events.on('engineer_run_created', async () => {
      await events.emit({ type: 'dashboard_refresh' });
    });

    const run = await create();
    const replay = await store().replay(run.engineerRunId, 0);

    expect(replay.map((event) => event.type)).toEqual(['engineer_run_created']);
  });

  it('requires accepted completion and validates step retry and terminal transitions', async () => {
    const run = await create();
    await markReady(run);
    await store().record(run.engineerRunId, { kind: 'run_started' });
    await store().record(run.engineerRunId, {
      kind: 'step_started',
      step: 'explore',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });

    await expect(store().record(run.engineerRunId, {
      kind: 'step_completed',
      step: 'explore',
      completion: 'tool_return' as never,
    })).rejects.toMatchObject({ code: 'invalid_completion_evidence' });

    await store().record(run.engineerRunId, {
      kind: 'step_retried',
      step: 'explore',
      reason: 'artifact rejected',
    });
    const completed = await store().record(run.engineerRunId, {
      kind: 'step_completed',
      step: 'explore',
      completion: 'accepted_result',
    });
    expect(completed.steps.explore).toMatchObject({ status: 'completed', attempt: 2 });

    await expect(store().record(run.engineerRunId, {
      kind: 'step_started',
      step: 'not-a-step' as never,
    })).rejects.toBeInstanceOf(EngineerLifecycleError);
  });

  it('replays strictly after the caller revision and refuses regression', async () => {
    const run = await create();
    await markReady(run);
    await store().record(run.engineerRunId, { kind: 'run_started' });
    await store().record(run.engineerRunId, { kind: 'routing_selected', project: 'api' });

    expect((await store().replay(run.engineerRunId, 2)).map((event) => event.revision)).toEqual([3, 4]);
    await expect(store().replay(run.engineerRunId, -1)).rejects.toMatchObject({ code: 'revision_regression' });
    await expect(store().replay(run.engineerRunId, 5)).rejects.toMatchObject({ code: 'revision_ahead' });
  });

  it('refuses run identities that could escape the durable runs directory', async () => {
    await expect(store().inspectRun('../../outside')).rejects.toMatchObject({ code: 'invalid_run_id' });
    await expect(store().replay('/tmp/outside', 0)).rejects.toMatchObject({ code: 'invalid_run_id' });
  });

  it.each([
    ['product', 'S', ['explore', 'complexity', 'prd', 'stories', 'plan'], ['architecture_diagram', 'architecture_review', 'conflict_check', 'coherence_check']],
    ['technical', 'M', ['explore', 'complexity', 'architecture_diagram', 'architecture_review', 'stories', 'conflict_check', 'plan', 'coherence_check'], ['prd']],
    ['product', 'L', ['explore', 'complexity', 'prd', 'architecture_diagram', 'architecture_review', 'stories', 'conflict_check', 'plan', 'coherence_check'], []],
  ] as const)(
    'reconciles artifact-proven %s tier %s completion and skip combinations',
    async (track, tier, completed, skipped) => {
      const run = await create({ correlationId: `${track}-${tier}`, attemptKey: `${track}-${tier}` });
      await markReady(run);
      await store().record(run.engineerRunId, { kind: 'run_started' });
      const reconciled = await store().reconcileLand(run.engineerRunId, {
        planSlug: `${track}-${tier}`,
        track,
        tier,
        completed: [...completed],
        skipped: [...skipped],
      });

      expect(reconciled.reconciliation).toMatchObject({ planSlug: `${track}-${tier}`, track, tier });
      for (const step of completed) expect(reconciled.steps[step]?.status).toBe('completed');
      for (const step of skipped) expect(reconciled.steps[step]?.status).toBe('skipped');
    },
  );

  it('recovers the snapshot from the append-only journal when the compact snapshot is absent', async () => {
    const run = await create();
    await markReady(run);
    await store().record(run.engineerRunId, { kind: 'run_started' });
    const snapshotPath = join(engineerDir, 'lifecycle', 'runs', run.engineerRunId, 'snapshot.json');
    await rm(snapshotPath);

    const recovered = await store().inspectRun(run.engineerRunId);
    expect(recovered).toMatchObject({ engineerRunId: run.engineerRunId, eventRevision: 3, state: 'authoring' });
    expect(JSON.parse(await readFile(snapshotPath, 'utf-8'))).toMatchObject({ eventRevision: 3 });
  });

  it('loads legacy cleanup snapshots before typed failure and retry fields existed', async () => {
    const run = await create();
    const cleanupPath = join(engineerDir, 'lifecycle', 'runs', run.engineerRunId, 'cleanup.json');
    await writeFile(cleanupPath, JSON.stringify({
      schemaVersion: 1,
      engineerRunId: run.engineerRunId,
      status: 'failed',
      attempts: 2,
      lastError: 'legacy cleanup failure',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }), 'utf-8');

    expect((await store().inspectRun(run.engineerRunId)).cleanup).toMatchObject({
      status: 'failed',
      stage: 'physical_removal',
      attempts: 2,
      lastError: 'legacy cleanup failure',
      failure: null,
      nextAttemptAt: null,
    });
  });

  it('refuses corrupt journals and unsupported schema versions explicitly', async () => {
    const run = await create();
    const journal = join(engineerDir, 'lifecycle', 'runs', run.engineerRunId, 'events.jsonl');
    await appendFile(journal, '{broken-json\n', 'utf-8');
    await expect(store().inspectRun(run.engineerRunId)).rejects.toMatchObject({ code: 'journal_corrupt' });

    const schemaRun = await create({ correlationId: 'corr-2', attemptKey: 'launch-schema' });
    const schemaJournal = join(engineerDir, 'lifecycle', 'runs', schemaRun.engineerRunId, 'events.jsonl');
    const raw = await readFile(schemaJournal, 'utf-8');
    await writeFile(schemaJournal, raw.replace('"schemaVersion":1', '"schemaVersion":2'), 'utf-8');
    await expect(store().inspectRun(schemaRun.engineerRunId)).rejects.toMatchObject({ code: 'schema_mismatch' });
  });

  it('gates authoring on the latest bounded readiness evidence', async () => {
    const run = await create();
    await expect(store().record(run.engineerRunId, { kind: 'run_started' }))
      .rejects.toMatchObject({ code: 'readiness_required' });

    await store().record(run.engineerRunId, {
      kind: 'readiness_checked',
      result: {
        status: 'blocked',
        code: 'tool_missing',
        summary: 'Required tool is unavailable',
        checkedCapabilities: ['git', 'gh'],
        retryable: true,
        remedy: 'Install gh and retry readiness.',
        diagnostic: 'gh was not found on PATH',
        fingerprint: 'blocked-fingerprint',
      },
      permitInconclusive: false,
    });
    await expect(store().record(run.engineerRunId, { kind: 'run_started' }))
      .rejects.toMatchObject({ code: 'readiness_blocked' });

    const ready = await markReady(run, 'inconclusive');
    expect(ready.readiness).toMatchObject({ status: 'inconclusive', permitted: true });
    await expect(store().record(run.engineerRunId, { kind: 'run_started' }))
      .resolves.toMatchObject({ state: 'authoring' });
  });

  it('preserves owner identity and rejects unowned or differently owned successors without partial state', async () => {
    const owned = await store().create({
      repoRoot,
      idea: 'Owned work',
      correlationId: 'owned-correlation',
      attemptKey: 'owned-attempt-1',
      integrationOwner: 'commission-123',
    });
    await store().record(owned.engineerRunId, {
      kind: 'run_failed',
      failure: {
        error: 'host exited',
        class: 'provider',
        code: 'provider_failed',
        summary: 'Provider host exited',
        retryable: true,
        remedy: 'Retry with a new reserved attempt.',
        diagnostic: null,
      },
    });

    await expect(store().create({
      repoRoot,
      idea: 'Owned work',
      correlationId: 'owned-correlation',
      attemptKey: 'owned-attempt-2',
    })).rejects.toMatchObject({ code: 'integration_owner_mismatch' });
    await expect(store().create({
      repoRoot,
      idea: 'Owned work',
      correlationId: 'owned-correlation',
      attemptKey: 'owned-attempt-2',
      integrationOwner: 'different-commission',
    })).rejects.toMatchObject({ code: 'integration_owner_mismatch' });
    expect(await store().inspectCorrelation({ repoRoot, correlationId: 'owned-correlation' })).toHaveLength(1);

    const successor = await store().create({
      repoRoot,
      idea: 'Owned work',
      correlationId: 'owned-correlation',
      attemptKey: 'owned-attempt-2',
      integrationOwner: 'commission-123',
    });
    expect(successor).toMatchObject({ integrationOwner: 'commission-123', attempt: 2 });
  });

  it('uses an exact auditable one-use transfer for the next direct successor', async () => {
    const first = await store().create({
      repoRoot,
      idea: 'Transfer work',
      correlationId: 'transfer-correlation',
      attemptKey: 'transfer-attempt-1',
      integrationOwner: 'commission-old',
    });
    await store().record(first.engineerRunId, {
      kind: 'run_failed',
      failure: {
        error: 'host exited',
        class: 'provider',
        code: 'provider_failed',
        summary: 'Provider host exited',
        retryable: true,
        remedy: 'Transfer ownership before an intentional successor.',
        diagnostic: null,
      },
    });
    const terminal = await store().inspectRun(first.engineerRunId);
    const transfer = await store().transferOwnership({
      repoRoot,
      correlationId: 'transfer-correlation',
      engineerRunId: first.engineerRunId,
      currentOwner: 'commission-old',
      nextOwner: 'commission-new',
      expectedRevision: terminal.eventRevision,
    });
    expect(transfer).toMatchObject({ previousOwner: 'commission-old', nextOwner: 'commission-new', consumedBy: null });

    const second = await store().create({
      repoRoot,
      idea: 'Transfer work',
      correlationId: 'transfer-correlation',
      attemptKey: 'transfer-attempt-2',
      integrationOwner: 'commission-new',
    });
    expect(second).toMatchObject({ previousEngineerRunId: first.engineerRunId, integrationOwner: 'commission-new' });

    await store().record(second.engineerRunId, {
      kind: 'run_failed',
      failure: {
        error: 'host exited again',
        class: 'provider',
        code: 'provider_failed',
        summary: 'Provider host exited',
        retryable: true,
        remedy: 'Retry with the current owner.',
        diagnostic: null,
      },
    });
    await expect(store().create({
      repoRoot,
      idea: 'Transfer work',
      correlationId: 'transfer-correlation',
      attemptKey: 'transfer-attempt-3',
      integrationOwner: 'commission-old',
    })).rejects.toMatchObject({ code: 'integration_owner_mismatch' });
  });

  it('allows one exact post-terminal retirement without changing the terminal outcome', async () => {
    const run = await create();
    await markReady(run);
    await store().record(run.engineerRunId, { kind: 'run_started' });
    await store().record(run.engineerRunId, { kind: 'worktree_created', worktreePath: join(repoRoot, '.worktrees', 'engineer-plan'), branch: 'spec/plan', planSlug: 'plan' });
    await store().reconcileLand(run.engineerRunId, {
      planSlug: 'plan',
      track: 'technical',
      tier: 'S',
      completed: ['explore', 'complexity', 'stories', 'plan'],
      skipped: ['prd', 'architecture_diagram', 'architecture_review', 'conflict_check', 'coherence_check'],
    });
    await store().record(run.engineerRunId, {
      kind: 'spec_handoff',
      planSlug: 'plan',
      branch: 'spec/plan',
      prUrl: 'https://github.com/example/repo/pull/1',
      outcome: 'pr_opened',
      retainedCommit: 'a'.repeat(40),
      retentionDeadline: '2026-09-17T00:00:00.000Z',
    });
    const terminal = await store().record(run.engineerRunId, { kind: 'run_settled', outcome: 'awaiting_spec_merge' });
    const retired = await store().retireWorktree(run.engineerRunId, {
      reason: 'spec_merged',
      retainedCommit: 'a'.repeat(40),
    });

    expect(retired).toMatchObject({
      state: 'settled',
      terminalReason: terminal.terminalReason,
      retirement: { reason: 'spec_merged', retainedCommit: 'a'.repeat(40) },
    });
    await expect(store().retireWorktree(run.engineerRunId, {
      reason: 'spec_closed',
      retainedCommit: 'a'.repeat(40),
    })).rejects.toMatchObject({ code: 'retirement_conflict' });
    await expect(store().record(run.engineerRunId, { kind: 'run_cancelled', reason: 'too late' }))
      .rejects.toMatchObject({ code: 'terminal_run' });
  });
});
