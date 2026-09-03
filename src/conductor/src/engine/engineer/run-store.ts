import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ComplexityTier,
  EngineerFailureEvidence,
  EngineerLifecycleEvent,
  EngineerReadinessEvidence,
  EngineerStepCompletionEvidence,
  EngineerStepName,
  EngineerWorktreeRetirementReason,
} from '../../types/index.js';
import { ConductorEventEmitter } from '../../ui/events.js';
import { EventPersister } from '../event-persister.js';

export const ENGINEER_LIFECYCLE_CAPABILITY = 'engineerLifecycleEventsV1' as const;
export const ENGINEER_READINESS_CAPABILITY = 'engineerReadinessV1' as const;
export const ENGINEER_WORKTREE_RETIREMENT_CAPABILITY = 'engineerWorktreeRetirementV1' as const;
export const ENGINEER_RETAINED_REVIEW_WORKTREE_CAPABILITY = 'engineerRetainedReviewWorktreesV1' as const;
export const ENGINEER_OWNED_ATTEMPTS_CAPABILITY = 'engineerOwnedAttemptsV1' as const;
export const ENGINEER_LIFECYCLE_SCHEMA_VERSION = 1 as const;

const TERMINAL_STATES = new Set<EngineerRunState>(['cancelled', 'failed', 'settled']);
const STEP_NAMES = new Set<EngineerStepName>([
  'bootstrap',
  'memory',
  'assess',
  'explore',
  'complexity',
  'prd',
  'architecture_diagram',
  'architecture_review',
  'stories',
  'conflict_check',
  'plan',
  'coherence_check',
]);

export type EngineerRunState =
  | 'created'
  | 'authoring'
  | 'awaiting_spec_merge'
  | 'cancelled'
  | 'failed'
  | 'settled';

export interface EngineerStepSnapshot {
  status: 'started' | 'completed' | 'failed' | 'retrying' | 'skipped';
  attempt: number;
  completion?: EngineerStepCompletionEvidence;
  provider?: string;
  model?: string;
  error?: string;
  reason?: string;
  artifactPaths?: string[];
}

export interface EngineerHandoffIdentity {
  planSlug: string;
  branch: string;
  prUrl: string | null;
  outcome: 'pr_opened' | 'local_commit';
}

export interface EngineerReadinessSnapshot extends EngineerReadinessEvidence {
  permitted: boolean;
  checkedAt: string;
}

export interface EngineerRetentionSnapshot {
  retainedCommit: string;
  retainedAt: string;
  retentionDeadline: string;
}

export interface EngineerRetirementSnapshot {
  worktreePath: string;
  branch: string;
  planSlug: string;
  reason: EngineerWorktreeRetirementReason;
  retainedCommit: string | null;
  retiredAt: string;
}

export interface EngineerCleanupSnapshot {
  schemaVersion: 1;
  engineerRunId: string;
  status: 'pending' | 'failed' | 'complete';
  stage: 'retirement_precondition' | 'physical_removal';
  attempts: number;
  lastError: string | null;
  failure: EngineerFailureEvidence | null;
  nextAttemptAt: string | null;
  updatedAt: string;
}

export interface EngineerRunSnapshot {
  schemaVersion: 1;
  capability: typeof ENGINEER_LIFECYCLE_CAPABILITY;
  engineerRunId: string;
  correlationId: string | null;
  attemptKey: string;
  attempt: number;
  previousEngineerRunId: string | null;
  repoRoot: string;
  idea: string;
  readinessRequired: boolean;
  integrationOwner: string | null;
  eventRevision: number;
  state: EngineerRunState;
  project: string | null;
  worktree: { path: string; branch: string; planSlug: string } | null;
  steps: Partial<Record<EngineerStepName, EngineerStepSnapshot>>;
  reconciliation: {
    planSlug: string;
    track: 'product' | 'technical';
    tier: ComplexityTier;
    completed: EngineerStepName[];
    skipped: EngineerStepName[];
  } | null;
  handoff: EngineerHandoffIdentity | null;
  readiness: EngineerReadinessSnapshot | null;
  failure: EngineerFailureEvidence | null;
  retention: EngineerRetentionSnapshot | null;
  retirement: EngineerRetirementSnapshot | null;
  cleanup: EngineerCleanupSnapshot | null;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RunMetadata {
  schemaVersion: 1;
  engineerRunId: string;
  correlationId: string | null;
  attemptKey: string;
  attempt: number;
  previousEngineerRunId: string | null;
  repoRoot: string;
  idea: string;
  integrationOwner?: string;
  createdAt: string;
}

interface AttemptIndex {
  schemaVersion: 1;
  attemptKey: string;
  engineerRunId: string;
}

interface CorrelationIndex {
  schemaVersion: 1;
  correlationId: string;
  repoRoot: string;
  idea: string;
  engineerRunIds: string[];
}

interface RepositoryIndex {
  schemaVersion: 1;
  repoRoot: string;
  engineerRunIds: string[];
}

export interface EngineerOwnershipTransfer {
  schemaVersion: 1;
  correlationId: string;
  repoRoot: string;
  predecessorEngineerRunId: string;
  previousOwner: string | null;
  nextOwner: string | null;
  expectedRevision: number;
  transferId: string;
  createdAt: string;
  consumedBy: string | null;
  consumedAt: string | null;
}

export type EngineerTransition =
  | { kind: 'readiness_checked'; result: EngineerReadinessEvidence; permitInconclusive: boolean }
  | { kind: 'run_started' }
  | { kind: 'routing_selected'; project: string }
  | { kind: 'worktree_created'; worktreePath: string; branch: string; planSlug: string }
  | { kind: 'step_started'; step: EngineerStepName; provider?: string; model?: string }
  | {
      kind: 'step_completed';
      step: EngineerStepName;
      completion: EngineerStepCompletionEvidence;
      artifactPaths?: string[];
    }
  | { kind: 'step_failed'; step: EngineerStepName; error: string }
  | { kind: 'step_retried'; step: EngineerStepName; reason: string }
  | { kind: 'step_skipped'; step: EngineerStepName; reason: string }
  | {
      kind: 'land_reconciled';
      planSlug: string;
      track: 'product' | 'technical';
      tier: ComplexityTier;
      completed: EngineerStepName[];
      skipped: EngineerStepName[];
    }
  | { kind: 'land_refused'; reason: string }
  | {
      kind: 'spec_handoff';
      planSlug: string;
      branch: string;
      prUrl: string | null;
      outcome: 'pr_opened' | 'local_commit';
      retainedCommit: string;
      retentionDeadline: string;
    }
  | { kind: 'run_cancelled'; reason: string }
  | { kind: 'run_failed'; failure: EngineerFailureEvidence }
  | { kind: 'run_settled'; outcome: 'awaiting_spec_merge' };

export class EngineerLifecycleError extends Error {
  constructor(
    public readonly code:
      | 'attempt_key_collision'
      | 'correlation_repository_collision'
      | 'correlation_idea_collision'
      | 'live_attempt_exists'
      | 'run_not_found'
      | 'terminal_run'
      | 'invalid_transition'
      | 'invalid_step'
      | 'invalid_completion_evidence'
      | 'invalid_run_id'
      | 'revision_regression'
      | 'revision_ahead'
      | 'journal_corrupt'
      | 'schema_mismatch'
      | 'identity_mismatch'
      | 'readiness_required'
      | 'readiness_blocked'
      | 'integration_owner_mismatch'
      | 'ownership_transfer_invalid'
      | 'retirement_not_allowed'
      | 'retirement_conflict'
      | 'lock_timeout',
    message: string,
  ) {
    super(message);
    this.name = 'EngineerLifecycleError';
  }
}

export interface EngineerRunStoreOptions {
  engineerDir: string;
  events: ConductorEventEmitter;
  now?: () => Date;
  id?: () => string;
}

export class EngineerRunStore {
  private readonly root: string;
  private readonly runsRoot: string;
  private readonly attemptsRoot: string;
  private readonly correlationsRoot: string;
  private readonly repositoriesRoot: string;
  private readonly ownershipRoot: string;
  private readonly locksRoot: string;
  private readonly events: ConductorEventEmitter;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(options: EngineerRunStoreOptions) {
    this.root = join(options.engineerDir, 'lifecycle');
    this.runsRoot = join(this.root, 'runs');
    this.attemptsRoot = join(this.root, 'indexes', 'attempts');
    this.correlationsRoot = join(this.root, 'indexes', 'correlations');
    this.repositoriesRoot = join(this.root, 'indexes', 'repositories');
    this.ownershipRoot = join(this.root, 'ownership');
    this.locksRoot = join(this.root, 'locks');
    this.events = options.events;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async create(input: {
    repoRoot: string;
    idea: string;
    correlationId?: string | null;
    attemptKey?: string;
    integrationOwner?: string | null;
  }): Promise<EngineerRunSnapshot> {
    const repoRoot = await realpath(input.repoRoot);
    const idea = requireText(input.idea, 'idea');
    const correlationId = normalizeOptional(input.correlationId);
    const attemptKey = normalizeOptional(input.attemptKey) ?? this.id();
    const requestedOwner = normalizeOwner(input.integrationOwner);

    const lockKeys = [this.attemptLockKey(attemptKey), this.repositoryLockKey(repoRoot)];
    if (correlationId !== null) lockKeys.push(this.correlationLockKey(correlationId));

    return this.withLocks(lockKeys, async () => {
      const attemptIndex = await this.readAttemptIndex(attemptKey);
      if (attemptIndex) {
        const sameAttemptKey = await this.readMetadata(attemptIndex.engineerRunId);
        if (
          sameAttemptKey.repoRoot !== repoRoot
          || sameAttemptKey.correlationId !== correlationId
          || sameAttemptKey.idea !== idea
          || normalizeOptional(sameAttemptKey.integrationOwner) !== requestedOwner
        ) {
          throw new EngineerLifecycleError(
            'attempt_key_collision',
            `Engineer attempt key ${JSON.stringify(attemptKey)} was already used with different inputs`,
          );
        }
        await this.ensureRepositoryIndexContains(repoRoot, sameAttemptKey.engineerRunId);
        return this.inspectRunUnlocked(sameAttemptKey.engineerRunId);
      }

      const correlationIndex = correlationId === null
        ? null
        : await this.readCorrelationIndex(correlationId);
      if (correlationIndex && correlationIndex.repoRoot !== repoRoot) {
        throw new EngineerLifecycleError(
          'correlation_repository_collision',
          `Engineer correlation ${JSON.stringify(correlationId)} belongs to ${correlationIndex.repoRoot}, not ${repoRoot}`,
        );
      }
      if (correlationIndex && correlationIndex.idea !== idea) {
        throw new EngineerLifecycleError(
          'correlation_idea_collision',
          `Engineer correlation ${JSON.stringify(correlationId)} was already used for a different idea`,
        );
      }

      const previousId = correlationIndex?.engineerRunIds.at(-1);
      const previous = previousId ? await this.readMetadata(previousId) : undefined;
      let ownershipTransfer: EngineerOwnershipTransfer | null = null;
      if (previous) {
        const previousSnapshot = await this.inspectRunUnlocked(previous.engineerRunId);
        if (!TERMINAL_STATES.has(previousSnapshot.state)) {
          throw new EngineerLifecycleError(
            'live_attempt_exists',
            `Engineer run ${previous.engineerRunId} is still ${previousSnapshot.state}`,
          );
        }
        if (previousSnapshot.integrationOwner !== requestedOwner) {
          ownershipTransfer = await this.readOwnershipTransfer(correlationId!);
          const transferMatches = ownershipTransfer
            && ownershipTransfer.consumedBy === null
            && ownershipTransfer.repoRoot === repoRoot
            && ownershipTransfer.predecessorEngineerRunId === previousSnapshot.engineerRunId
            && ownershipTransfer.previousOwner === previousSnapshot.integrationOwner
            && ownershipTransfer.nextOwner === requestedOwner
            && ownershipTransfer.expectedRevision === previousSnapshot.eventRevision;
          if (!transferMatches) {
            throw new EngineerLifecycleError(
              'integration_owner_mismatch',
              `Engineer correlation ${JSON.stringify(correlationId)} requires integration owner ${JSON.stringify(previousSnapshot.integrationOwner)}`,
            );
          }
        }
      }

      const createdAt = this.now().toISOString();
      const run: RunMetadata = {
        schemaVersion: 1,
        engineerRunId: this.id(),
        correlationId,
        attemptKey,
        attempt: previous ? previous.attempt + 1 : 1,
        previousEngineerRunId: previous?.engineerRunId ?? null,
        repoRoot,
        idea,
        ...(requestedOwner === null ? {} : { integrationOwner: requestedOwner }),
        createdAt,
      };
      await mkdir(this.runDir(run.engineerRunId), { recursive: true });
      await this.writeJsonAtomic(this.metadataPath(run.engineerRunId), run);
      const event: EngineerLifecycleEvent = {
        ...this.eventBase(run, 1, createdAt),
        type: 'engineer_run_created',
        idea,
        readinessRequired: true,
        ...(requestedOwner === null ? {} : { integrationOwner: requestedOwner }),
      };
      await this.persistAndEmit(run.engineerRunId, event);
      const snapshot = reduceEngineerEvents(await this.readJournal(run.engineerRunId));
      await this.writeSnapshot(snapshot);
      await this.writeJsonAtomic(this.attemptIndexPath(attemptKey), {
        schemaVersion: 1,
        attemptKey,
        engineerRunId: run.engineerRunId,
      } satisfies AttemptIndex);
      if (correlationId !== null) {
        await this.writeJsonAtomic(this.correlationIndexPath(correlationId), {
          schemaVersion: 1,
          correlationId,
          repoRoot,
          idea,
          engineerRunIds: [...(correlationIndex?.engineerRunIds ?? []), run.engineerRunId],
        } satisfies CorrelationIndex);
      }
      if (ownershipTransfer) {
        await this.writeJsonAtomic(this.ownershipTransferPath(correlationId!), {
          ...ownershipTransfer,
          consumedBy: run.engineerRunId,
          consumedAt: createdAt,
        } satisfies EngineerOwnershipTransfer);
      }
      await this.ensureRepositoryIndexContains(repoRoot, run.engineerRunId);
      return snapshot;
    });
  }

  async listRuns(input: { repoRoot?: string } = {}): Promise<EngineerRunSnapshot[]> {
    if (input.repoRoot) {
      const repoRoot = await realpath(input.repoRoot);
      const runIds = await this.withLocks(
        [this.repositoryLockKey(repoRoot)],
        () => this.repositoryRunIds(repoRoot),
      );
      return Promise.all(runIds.map((runId) => this.inspectRun(runId)));
    }
    const runIds = await this.allRunIds();
    return Promise.all(runIds.map((runId) => this.inspectRun(runId)));
  }

  private async allRunIds(): Promise<string[]> {
    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async transferOwnership(input: {
    repoRoot: string;
    correlationId: string;
    engineerRunId: string;
    currentOwner: string | null;
    nextOwner: string | null;
    expectedRevision: number;
  }): Promise<EngineerOwnershipTransfer> {
    const repoRoot = await realpath(input.repoRoot);
    const correlationId = requireText(input.correlationId, 'correlationId');
    const currentOwner = normalizeOwner(input.currentOwner);
    const nextOwner = normalizeOwner(input.nextOwner);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new EngineerLifecycleError('ownership_transfer_invalid', 'expectedRevision must be a positive integer');
    }
    return this.withLocks([this.correlationLockKey(correlationId)], async () => {
      const index = await this.readCorrelationIndex(correlationId);
      const activeRunId = index?.engineerRunIds.at(-1);
      if (!index || index.repoRoot !== repoRoot || activeRunId !== input.engineerRunId) {
        throw new EngineerLifecycleError('ownership_transfer_invalid', 'Ownership transfer must target the active exact correlation run');
      }
      const snapshot = await this.inspectRunUnlocked(input.engineerRunId);
      if (!TERMINAL_STATES.has(snapshot.state) || snapshot.eventRevision !== input.expectedRevision) {
        throw new EngineerLifecycleError('ownership_transfer_invalid', 'Ownership transfer requires the active terminal run at the expected revision');
      }
      if (snapshot.integrationOwner !== currentOwner || currentOwner === nextOwner) {
        throw new EngineerLifecycleError('ownership_transfer_invalid', 'Ownership transfer owner identity is invalid');
      }
      const existing = await this.readOwnershipTransfer(correlationId);
      if (existing) {
        if (
          existing.repoRoot === repoRoot
          && existing.predecessorEngineerRunId === input.engineerRunId
          && existing.previousOwner === currentOwner
          && existing.nextOwner === nextOwner
          && existing.expectedRevision === input.expectedRevision
        ) return existing;
        if (existing.consumedBy === null) {
          throw new EngineerLifecycleError('ownership_transfer_invalid', 'A different unused ownership transfer already exists');
        }
      }
      const transfer: EngineerOwnershipTransfer = {
        schemaVersion: 1,
        correlationId,
        repoRoot,
        predecessorEngineerRunId: input.engineerRunId,
        previousOwner: currentOwner,
        nextOwner,
        expectedRevision: input.expectedRevision,
        transferId: this.id(),
        createdAt: this.now().toISOString(),
        consumedBy: null,
        consumedAt: null,
      };
      await this.writeJsonAtomic(this.ownershipTransferPath(correlationId), transfer);
      return transfer;
    });
  }

  async inspectRun(engineerRunId: string): Promise<EngineerRunSnapshot> {
    return this.withLocks([this.runLockKey(engineerRunId)], () => this.inspectRunUnlocked(engineerRunId));
  }

  async inspectCorrelation(input: { repoRoot: string; correlationId: string }): Promise<EngineerRunSnapshot[]> {
    const repoRoot = await realpath(input.repoRoot);
    const correlationId = requireText(input.correlationId, 'correlationId');
    const engineerRunIds = await this.withLocks(
      [this.correlationLockKey(correlationId)],
      async () => {
        const index = await this.readCorrelationIndex(correlationId);
        return index?.repoRoot === repoRoot ? [...index.engineerRunIds] : [];
      },
    );
    return Promise.all(engineerRunIds.map((engineerRunId) => this.inspectRun(engineerRunId)));
  }

  async replay(engineerRunId: string, afterRevision: number): Promise<EngineerLifecycleEvent[]> {
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new EngineerLifecycleError('revision_regression', 'afterRevision must be a non-negative integer');
    }
    return this.withLocks([this.runLockKey(engineerRunId)], async () => {
      const events = await this.readJournal(engineerRunId);
      const current = events.at(-1)?.revision ?? 0;
      if (afterRevision > current) {
        throw new EngineerLifecycleError(
          'revision_ahead',
          `Requested revision ${afterRevision} is ahead of Engineer run ${engineerRunId} at ${current}`,
        );
      }
      return events.filter((event) => event.revision > afterRevision);
    });
  }

  async record(engineerRunId: string, transition: EngineerTransition): Promise<EngineerRunSnapshot> {
    return this.withLocks([this.runLockKey(engineerRunId)], async () => {
      const snapshot = await this.inspectRunUnlocked(engineerRunId);
      if (TERMINAL_STATES.has(snapshot.state)) {
        throw new EngineerLifecycleError(
          'terminal_run',
          `Engineer run ${engineerRunId} is terminal (${snapshot.state}) and cannot be reopened`,
        );
      }
      const metadata = await this.readMetadata(engineerRunId);
      const event = this.transitionEvent(metadata, snapshot, transition);
      await this.persistAndEmit(engineerRunId, event);
      const next = reduceEngineerEvents([...(await this.readJournal(engineerRunId))]);
      await this.writeSnapshot(next);
      return next;
    });
  }

  async retireWorktree(engineerRunId: string, input: {
    reason: EngineerWorktreeRetirementReason;
    retainedCommit?: string | null;
  }): Promise<EngineerRunSnapshot> {
    return this.withLocks([this.runLockKey(engineerRunId)], async () => {
      const snapshot = await this.inspectRunUnlocked(engineerRunId);
      const retainedCommit = normalizeCommit(input.retainedCommit ?? snapshot.retention?.retainedCommit ?? null);
      if (snapshot.retirement) {
        if (snapshot.retirement.reason === input.reason && snapshot.retirement.retainedCommit === retainedCommit) {
          return snapshot;
        }
        throw new EngineerLifecycleError('retirement_conflict', `Engineer run ${engineerRunId} already has different retirement evidence`);
      }
      if (!snapshot.worktree || !['settled', 'cancelled'].includes(snapshot.state)) {
        throw new EngineerLifecycleError('retirement_not_allowed', 'Worktree retirement requires an exact retained worktree on a settled or cancelled run');
      }
      const metadata = await this.readMetadata(engineerRunId);
      const event: EngineerLifecycleEvent = {
        ...this.eventBase(metadata, snapshot.eventRevision + 1, this.now().toISOString()),
        type: 'engineer_worktree_retired',
        worktreePath: snapshot.worktree.path,
        branch: snapshot.worktree.branch,
        planSlug: snapshot.worktree.planSlug,
        reason: input.reason,
        retainedCommit,
      };
      await this.persistAndEmit(engineerRunId, event);
      const next = reduceEngineerEvents(await this.readJournal(engineerRunId));
      await this.writeSnapshot(next);
      return next;
    });
  }

  async recordCleanupAttempt(
    engineerRunId: string,
    input: {
      status: 'pending' | 'failed' | 'complete';
      stage?: 'retirement_precondition' | 'physical_removal';
      error?: string | null;
      failure?: EngineerFailureEvidence | null;
      nextAttemptAt?: string | null;
    },
  ): Promise<EngineerCleanupSnapshot> {
    return this.withLocks([this.runLockKey(engineerRunId)], async () => {
      const snapshot = await this.inspectRunUnlocked(engineerRunId);
      const stage = input.stage ?? 'physical_removal';
      const isPreconditionFailure = stage === 'retirement_precondition' && input.status === 'failed';
      if (!snapshot.retirement && !isPreconditionFailure) {
        throw new EngineerLifecycleError('retirement_not_allowed', 'Physical cleanup cannot begin before logical retirement');
      }
      if (isPreconditionFailure && (!snapshot.worktree || !['settled', 'cancelled'].includes(snapshot.state))) {
        throw new EngineerLifecycleError('retirement_not_allowed', 'Retirement failure evidence requires a terminal run with exact worktree identity');
      }
      const previous = await this.readCleanupSnapshot(engineerRunId);
      if (previous?.status === 'complete') return previous;
      const failure = input.failure ? validateFailureEvidence(input.failure) : null;
      const nextAttemptAt = input.nextAttemptAt
        ? normalizeIsoDate(input.nextAttemptAt, 'cleanup nextAttemptAt')
        : null;
      const cleanup: EngineerCleanupSnapshot = {
        schemaVersion: 1,
        engineerRunId,
        status: input.status,
        stage,
        attempts: (previous?.attempts ?? 0) + (input.status === 'pending' || isPreconditionFailure ? 1 : 0),
        lastError: failure?.error ?? normalizeBoundedOptional(input.error, 'cleanup error', 2_048),
        failure,
        nextAttemptAt,
        updatedAt: this.now().toISOString(),
      };
      await this.writeJsonAtomic(this.cleanupPath(engineerRunId), cleanup);
      return cleanup;
    });
  }

  async reconcileLand(engineerRunId: string, input: {
    planSlug: string;
    track: 'product' | 'technical';
    tier: ComplexityTier;
    completed: EngineerStepName[];
    skipped: EngineerStepName[];
  }): Promise<EngineerRunSnapshot> {
    let snapshot = await this.inspectRun(engineerRunId);
    const completed = [...new Set(input.completed)];
    const skipped = [...new Set(input.skipped)];
    for (const step of completed) {
      this.assertStep(step);
      const current = snapshot.steps[step];
      if (current?.status === 'skipped') {
        throw new EngineerLifecycleError(
          'invalid_transition',
          `Land evidence proves ${step} completed but the run recorded it skipped`,
        );
      }
      if (current?.status !== 'completed') {
        snapshot = await this.record(engineerRunId, {
          kind: 'step_completed',
          step,
          completion: 'land_reconciliation',
        });
      }
    }
    for (const step of skipped) {
      this.assertStep(step);
      const current = snapshot.steps[step];
      if (current?.status === 'completed') {
        throw new EngineerLifecycleError(
          'invalid_transition',
          `Land evidence proves ${step} skipped but the run recorded it completed`,
        );
      }
      if (current?.status !== 'skipped') {
        snapshot = await this.record(engineerRunId, {
          kind: 'step_skipped',
          step,
          reason: `Not required for ${input.track} track at tier ${input.tier}`,
        });
      }
    }
    return this.record(engineerRunId, {
      kind: 'land_reconciled',
      ...input,
      completed,
      skipped,
    });
  }

  private transitionEvent(
    run: RunMetadata,
    snapshot: EngineerRunSnapshot,
    transition: EngineerTransition,
  ): EngineerLifecycleEvent {
    const base = this.eventBase(run, snapshot.eventRevision + 1, this.now().toISOString());
    if ('step' in transition) this.assertStep(transition.step);
    const stepAttempt = 'step' in transition
      ? this.stepAttempt(snapshot, transition)
      : 0;

    switch (transition.kind) {
      case 'readiness_checked': {
        if (!['created', 'authoring'].includes(snapshot.state)) this.invalidTransition(transition.kind, snapshot.state);
        const result = validateReadinessEvidence(transition.result);
        const permitted = result.status === 'ready'
          || (result.status === 'inconclusive' && transition.permitInconclusive);
        return {
          ...base,
          type: 'engineer_readiness_checked',
          ...result,
          permitted,
        };
      }
      case 'run_started':
        if (snapshot.state !== 'created') this.invalidTransition(transition.kind, snapshot.state);
        this.requireReadiness(snapshot);
        return { ...base, type: 'engineer_run_started' };
      case 'routing_selected':
        this.requireAuthoring(snapshot, transition.kind);
        return { ...base, type: 'engineer_routing_selected', project: requireText(transition.project, 'project') };
      case 'worktree_created':
        this.requireAuthoring(snapshot, transition.kind);
        return {
          ...base,
          type: 'engineer_worktree_created',
          worktreePath: requireText(transition.worktreePath, 'worktreePath'),
          branch: requireText(transition.branch, 'branch'),
          planSlug: requireText(transition.planSlug, 'planSlug'),
        };
      case 'step_started':
        this.requireAuthoring(snapshot, transition.kind);
        return {
          ...base,
          type: 'engineer_step_started',
          step: transition.step,
          stepAttempt,
          ...(normalizeOptional(transition.provider) ? { provider: normalizeOptional(transition.provider)! } : {}),
          ...(normalizeOptional(transition.model) ? { model: normalizeOptional(transition.model)! } : {}),
        };
      case 'step_completed': {
        this.requireAuthoring(snapshot, transition.kind);
        const allowed = new Set<EngineerStepCompletionEvidence>([
          'accepted_result',
          'artifact_validation',
          'land_reconciliation',
        ]);
        if (!allowed.has(transition.completion)) {
          throw new EngineerLifecycleError(
            'invalid_completion_evidence',
            `Engineer step completion requires accepted_result, artifact_validation, or land_reconciliation`,
          );
        }
        return {
          ...base,
          type: 'engineer_step_completed',
          step: transition.step,
          stepAttempt,
          completion: transition.completion,
          ...(transition.artifactPaths ? { artifactPaths: transition.artifactPaths } : {}),
        };
      }
      case 'step_failed':
        this.requireAuthoring(snapshot, transition.kind);
        return { ...base, type: 'engineer_step_failed', step: transition.step, stepAttempt, error: requireText(transition.error, 'error') };
      case 'step_retried':
        this.requireAuthoring(snapshot, transition.kind);
        return { ...base, type: 'engineer_step_retried', step: transition.step, stepAttempt, reason: requireText(transition.reason, 'reason') };
      case 'step_skipped':
        this.requireAuthoring(snapshot, transition.kind);
        return { ...base, type: 'engineer_step_skipped', step: transition.step, stepAttempt, reason: requireText(transition.reason, 'reason') };
      case 'land_reconciled':
        this.requireAuthoring(snapshot, transition.kind);
        if (snapshot.reconciliation && snapshot.reconciliation.planSlug !== transition.planSlug) {
          throw new EngineerLifecycleError('identity_mismatch', 'Engineer run cannot reconcile two final plan identities');
        }
        return { ...base, type: 'engineer_land_reconciled', ...transition };
      case 'land_refused':
        this.requireAuthoring(snapshot, transition.kind);
        return { ...base, type: 'engineer_land_refused', reason: requireText(transition.reason, 'reason') };
      case 'spec_handoff':
        this.requireAuthoring(snapshot, transition.kind);
        if (!snapshot.reconciliation || snapshot.reconciliation.planSlug !== transition.planSlug) {
          throw new EngineerLifecycleError('identity_mismatch', 'Spec handoff planSlug must match the reconciled plan identity');
        }
        return {
          ...base,
          type: 'engineer_spec_handoff',
          planSlug: requireText(transition.planSlug, 'planSlug'),
          branch: requireText(transition.branch, 'branch'),
          prUrl: transition.prUrl,
          outcome: transition.outcome,
          state: 'awaiting_spec_merge',
          retainedCommit: normalizeCommit(transition.retainedCommit)!,
          retainedAt: base.ts,
          retentionDeadline: normalizeIsoDate(transition.retentionDeadline, 'retentionDeadline'),
        };
      case 'run_cancelled':
        return { ...base, type: 'engineer_run_cancelled', reason: requireText(transition.reason, 'reason') };
      case 'run_failed':
        return { ...base, type: 'engineer_run_failed', ...validateFailureEvidence(transition.failure) };
      case 'run_settled':
        if (snapshot.state !== 'awaiting_spec_merge') this.invalidTransition(transition.kind, snapshot.state);
        return { ...base, type: 'engineer_run_settled', outcome: transition.outcome };
    }
  }

  private stepAttempt(
    snapshot: EngineerRunSnapshot,
    transition: Extract<EngineerTransition, { step: EngineerStepName }>,
  ): number {
    const { step, kind } = transition;
    const current = snapshot.steps[step];
    if (kind === 'step_retried') return (current?.attempt ?? 0) + 1;
    if (kind === 'step_started') {
      return current?.status === 'retrying' ? current.attempt : (current?.attempt ?? 0) + 1;
    }
    if (kind === 'step_skipped') return current?.attempt ?? 0;
    if (
      kind === 'step_completed'
      && transition.completion === 'land_reconciliation'
      && current === undefined
    ) return 1;
    if (!current || !['started', 'retrying', 'failed'].includes(current.status)) {
      throw new EngineerLifecycleError(
        'invalid_transition',
        `Engineer step ${step} cannot ${kind.replace('step_', '')} before it starts`,
      );
    }
    return current.attempt;
  }

  private assertStep(step: EngineerStepName): void {
    if (!STEP_NAMES.has(step)) {
      throw new EngineerLifecycleError('invalid_step', `Unknown canonical Engineer step ${JSON.stringify(step)}`);
    }
  }

  private requireAuthoring(snapshot: EngineerRunSnapshot, transition: string): void {
    if (snapshot.state !== 'authoring') this.invalidTransition(transition, snapshot.state);
    this.requireReadiness(snapshot);
  }

  private requireReadiness(snapshot: EngineerRunSnapshot): void {
    if (!snapshot.readinessRequired) return;
    if (!snapshot.readiness) {
      throw new EngineerLifecycleError('readiness_required', `Engineer run ${snapshot.engineerRunId} requires readiness evidence before authoring`);
    }
    if (!snapshot.readiness.permitted) {
      throw new EngineerLifecycleError(
        'readiness_blocked',
        `Engineer run ${snapshot.engineerRunId} readiness is ${snapshot.readiness.status} (${snapshot.readiness.code})`,
      );
    }
  }

  private invalidTransition(transition: string, state: EngineerRunState): never {
    throw new EngineerLifecycleError(
      'invalid_transition',
      `Engineer transition ${transition} is illegal while the run is ${state}`,
    );
  }

  private eventBase(run: RunMetadata, revision: number, ts: string) {
    return {
      schemaVersion: ENGINEER_LIFECYCLE_SCHEMA_VERSION,
      engineerRunId: run.engineerRunId,
      correlationId: run.correlationId,
      attemptKey: run.attemptKey,
      attempt: run.attempt,
      previousEngineerRunId: run.previousEngineerRunId,
      repoRoot: run.repoRoot,
      revision,
      ts,
    } as const;
  }

  private async inspectRunUnlocked(engineerRunId: string): Promise<EngineerRunSnapshot> {
    await this.readMetadata(engineerRunId);
    const snapshot = reduceEngineerEvents(await this.readJournal(engineerRunId));
    snapshot.cleanup = await this.readCleanupSnapshot(engineerRunId);
    await this.writeSnapshotIfChanged(snapshot);
    return snapshot;
  }

  private async readCleanupSnapshot(engineerRunId: string): Promise<EngineerCleanupSnapshot | null> {
    const parsed = await this.readOptionalJson(this.cleanupPath(engineerRunId), `Engineer cleanup state ${engineerRunId}`);
    if (parsed === null) return null;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION
      || parsed.engineerRunId !== engineerRunId
      || !['pending', 'failed', 'complete'].includes(String(parsed.status))
      || !Number.isInteger(parsed.attempts)
      || typeof parsed.updatedAt !== 'string'
      || !(parsed.lastError === null || typeof parsed.lastError === 'string')
      || !(parsed.stage === undefined || ['retirement_precondition', 'physical_removal'].includes(String(parsed.stage)))
      || !(parsed.nextAttemptAt === undefined || parsed.nextAttemptAt === null || typeof parsed.nextAttemptAt === 'string')
      || (typeof parsed.nextAttemptAt === 'string' && Number.isNaN(Date.parse(parsed.nextAttemptAt)))
      || !(parsed.failure === undefined || parsed.failure === null || isStoredFailureEvidence(parsed.failure))
    ) {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer cleanup state ${engineerRunId} is malformed`);
    }
    return {
      ...(parsed as unknown as EngineerCleanupSnapshot),
      stage: parsed.stage === 'retirement_precondition' ? 'retirement_precondition' : 'physical_removal',
      failure: parsed.failure === undefined ? null : parsed.failure as EngineerFailureEvidence | null,
      nextAttemptAt: parsed.nextAttemptAt === undefined ? null : parsed.nextAttemptAt as string | null,
    };
  }

  private async readJournal(engineerRunId: string): Promise<EngineerLifecycleEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath(engineerRunId), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EngineerLifecycleError('run_not_found', `Engineer run ${engineerRunId} has no durable journal`);
      }
      throw error;
    }
    const events: EngineerLifecycleEvent[] = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new EngineerLifecycleError('journal_corrupt', `Engineer journal ${engineerRunId} has invalid JSON at line ${index + 1}`);
      }
      if (!isRecord(parsed) || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION) {
        throw new EngineerLifecycleError('schema_mismatch', `Engineer journal ${engineerRunId} uses an unsupported schema at line ${index + 1}`);
      }
      if (
        typeof parsed.type !== 'string'
        || !parsed.type.startsWith('engineer_')
        || parsed.engineerRunId !== engineerRunId
      ) {
        throw new EngineerLifecycleError('journal_corrupt', `Engineer journal ${engineerRunId} has invalid identity at line ${index + 1}`);
      }
      if (parsed.revision !== events.length + 1) {
        throw new EngineerLifecycleError('journal_corrupt', `Engineer journal ${engineerRunId} has a non-monotonic revision at line ${index + 1}`);
      }
      events.push(parsed as unknown as EngineerLifecycleEvent);
    }
    if (events.length === 0 || events[0]?.type !== 'engineer_run_created') {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer journal ${engineerRunId} has no run-created event`);
    }
    return events;
  }

  private async persistAndEmit(engineerRunId: string, event: EngineerLifecycleEvent): Promise<void> {
    const persister = new EventPersister(
      this.journalPath(engineerRunId),
      this.events,
      undefined,
      (event) => 'engineerRunId' in event && event.engineerRunId === engineerRunId,
    );
    persister.start();
    try {
      await this.events.emitOrThrow(event);
    } finally {
      persister.stop();
    }
  }

  private async readMetadata(engineerRunId: string): Promise<RunMetadata> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.metadataPath(engineerRunId), 'utf-8'));
    } catch (error) {
      if (error instanceof EngineerLifecycleError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EngineerLifecycleError('run_not_found', `Unknown Engineer run ${engineerRunId}`);
      }
      throw new EngineerLifecycleError('journal_corrupt', `Engineer metadata for ${engineerRunId} is unreadable`);
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION) {
      throw new EngineerLifecycleError('schema_mismatch', `Engineer metadata for ${engineerRunId} uses an unsupported schema`);
    }
    return parsed as unknown as RunMetadata;
  }

  private async readAttemptIndex(attemptKey: string): Promise<AttemptIndex | null> {
    const parsed = await this.readOptionalJson(
      this.attemptIndexPath(attemptKey),
      `Engineer attempt index ${JSON.stringify(attemptKey)}`,
    );
    if (parsed === null) return null;
    if (!isRecord(parsed) || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION) {
      throw new EngineerLifecycleError(
        'schema_mismatch',
        `Engineer attempt index ${JSON.stringify(attemptKey)} uses an unsupported schema`,
      );
    }
    if (parsed.attemptKey !== attemptKey || typeof parsed.engineerRunId !== 'string') {
      throw new EngineerLifecycleError(
        'journal_corrupt',
        `Engineer attempt index ${JSON.stringify(attemptKey)} has invalid identity`,
      );
    }
    this.runDir(parsed.engineerRunId);
    return parsed as unknown as AttemptIndex;
  }

  private async readCorrelationIndex(correlationId: string): Promise<CorrelationIndex | null> {
    const parsed = await this.readOptionalJson(
      this.correlationIndexPath(correlationId),
      `Engineer correlation index ${JSON.stringify(correlationId)}`,
    );
    if (parsed === null) return null;
    if (!isRecord(parsed) || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION) {
      throw new EngineerLifecycleError(
        'schema_mismatch',
        `Engineer correlation index ${JSON.stringify(correlationId)} uses an unsupported schema`,
      );
    }
    if (
      parsed.correlationId !== correlationId
      || typeof parsed.repoRoot !== 'string'
      || typeof parsed.idea !== 'string'
      || !Array.isArray(parsed.engineerRunIds)
      || !parsed.engineerRunIds.every((engineerRunId) => typeof engineerRunId === 'string')
    ) {
      throw new EngineerLifecycleError(
        'journal_corrupt',
        `Engineer correlation index ${JSON.stringify(correlationId)} has invalid identity`,
      );
    }
    for (const engineerRunId of parsed.engineerRunIds) this.runDir(engineerRunId);
    return parsed as unknown as CorrelationIndex;
  }

  private async repositoryRunIds(repoRoot: string): Promise<string[]> {
    const existing = await this.readRepositoryIndex(repoRoot);
    if (existing) return [...existing.engineerRunIds];

    const engineerRunIds: string[] = [];
    for (const engineerRunId of await this.allRunIds()) {
      try {
        const metadata = await this.readMetadata(engineerRunId);
        if (metadata.repoRoot === repoRoot) engineerRunIds.push(engineerRunId);
      } catch {
        // A malformed run from another repository cannot be attributed safely.
        // Scoped maintenance must not open its journal or block this repository.
      }
    }
    engineerRunIds.sort();
    await this.writeJsonAtomic(this.repositoryIndexPath(repoRoot), {
      schemaVersion: 1,
      repoRoot,
      engineerRunIds,
    } satisfies RepositoryIndex);
    return engineerRunIds;
  }

  private async ensureRepositoryIndexContains(repoRoot: string, engineerRunId: string): Promise<void> {
    const runIds = await this.repositoryRunIds(repoRoot);
    if (runIds.includes(engineerRunId)) return;
    await this.writeJsonAtomic(this.repositoryIndexPath(repoRoot), {
      schemaVersion: 1,
      repoRoot,
      engineerRunIds: [...runIds, engineerRunId].sort(),
    } satisfies RepositoryIndex);
  }

  private async readRepositoryIndex(repoRoot: string): Promise<RepositoryIndex | null> {
    const parsed = await this.readOptionalJson(
      this.repositoryIndexPath(repoRoot),
      `Engineer repository index ${JSON.stringify(repoRoot)}`,
    );
    if (parsed === null) return null;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION
      || parsed.repoRoot !== repoRoot
      || !Array.isArray(parsed.engineerRunIds)
      || !parsed.engineerRunIds.every((engineerRunId) => typeof engineerRunId === 'string')
    ) {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer repository index ${JSON.stringify(repoRoot)} is malformed`);
    }
    for (const engineerRunId of parsed.engineerRunIds) this.runDir(engineerRunId);
    return parsed as unknown as RepositoryIndex;
  }

  private async readOwnershipTransfer(correlationId: string): Promise<EngineerOwnershipTransfer | null> {
    const parsed = await this.readOptionalJson(
      this.ownershipTransferPath(correlationId),
      `Engineer ownership transfer ${JSON.stringify(correlationId)}`,
    );
    if (parsed === null) return null;
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== ENGINEER_LIFECYCLE_SCHEMA_VERSION
      || parsed.correlationId !== correlationId
      || typeof parsed.repoRoot !== 'string'
      || typeof parsed.predecessorEngineerRunId !== 'string'
      || !Number.isInteger(parsed.expectedRevision)
      || typeof parsed.transferId !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !(parsed.previousOwner === null || typeof parsed.previousOwner === 'string')
      || !(parsed.nextOwner === null || typeof parsed.nextOwner === 'string')
      || !(parsed.consumedBy === null || typeof parsed.consumedBy === 'string')
      || !(parsed.consumedAt === null || typeof parsed.consumedAt === 'string')
    ) {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer ownership transfer ${JSON.stringify(correlationId)} is malformed`);
    }
    return parsed as unknown as EngineerOwnershipTransfer;
  }

  private async readOptionalJson(path: string, label: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new EngineerLifecycleError('journal_corrupt', `${label} is unreadable`);
    }
  }

  private async writeSnapshot(snapshot: EngineerRunSnapshot): Promise<void> {
    await this.writeJsonAtomic(this.snapshotPath(snapshot.engineerRunId), snapshot);
  }

  private async writeSnapshotIfChanged(snapshot: EngineerRunSnapshot): Promise<void> {
    const next = JSON.stringify(snapshot, null, 2) + '\n';
    try {
      if (await readFile(this.snapshotPath(snapshot.engineerRunId), 'utf-8') === next) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.writeJsonAtomic(this.snapshotPath(snapshot.engineerRunId), snapshot);
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${this.id()}`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await rename(temporary, path);
  }

  private async withLocks<T>(keys: string[], run: () => Promise<T>): Promise<T> {
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const key of [...new Set(keys)].sort()) releases.push(await this.acquireLock(key));
      return await run();
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  private async acquireLock(key: string): Promise<() => Promise<void>> {
    await mkdir(this.locksRoot, { recursive: true });
    const lockPath = join(this.locksRoot, this.identityHash(key));
    const deadline = Date.now() + 35_000;
    for (;;) {
      try {
        await mkdir(lockPath);
        return () => rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > 30_000) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new EngineerLifecycleError(
            'lock_timeout',
            `Timed out acquiring Engineer lifecycle lock for ${JSON.stringify(key)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private attemptLockKey(attemptKey: string): string {
    return `attempt:${attemptKey}`;
  }

  private correlationLockKey(correlationId: string): string {
    return `correlation:${correlationId}`;
  }

  private repositoryLockKey(repoRoot: string): string {
    return `repository:${repoRoot}`;
  }

  private runLockKey(engineerRunId: string): string {
    this.runDir(engineerRunId);
    return `run:${engineerRunId}`;
  }

  private identityHash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private attemptIndexPath(attemptKey: string): string {
    return join(this.attemptsRoot, `${this.identityHash(attemptKey)}.json`);
  }

  private correlationIndexPath(correlationId: string): string {
    return join(this.correlationsRoot, `${this.identityHash(correlationId)}.json`);
  }

  private repositoryIndexPath(repoRoot: string): string {
    return join(this.repositoriesRoot, `${this.identityHash(repoRoot)}.json`);
  }

  private ownershipTransferPath(correlationId: string): string {
    return join(this.ownershipRoot, `${this.identityHash(correlationId)}.json`);
  }

  private runDir(engineerRunId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(engineerRunId)) {
      throw new EngineerLifecycleError(
        'invalid_run_id',
        `Engineer run id ${JSON.stringify(engineerRunId)} is not a valid durable identity`,
      );
    }
    return join(this.runsRoot, engineerRunId);
  }

  private metadataPath(engineerRunId: string): string {
    return join(this.runDir(engineerRunId), 'metadata.json');
  }

  private snapshotPath(engineerRunId: string): string {
    return join(this.runDir(engineerRunId), 'snapshot.json');
  }

  private journalPath(engineerRunId: string): string {
    return join(this.runDir(engineerRunId), 'events.jsonl');
  }

  private cleanupPath(engineerRunId: string): string {
    return join(this.runDir(engineerRunId), 'cleanup.json');
  }
}

export function reduceEngineerEvents(events: readonly EngineerLifecycleEvent[]): EngineerRunSnapshot {
  const created = events[0];
  if (!created || created.type !== 'engineer_run_created') {
    throw new EngineerLifecycleError('journal_corrupt', 'Engineer lifecycle requires engineer_run_created at revision 1');
  }
  const snapshot: EngineerRunSnapshot = {
    schemaVersion: 1,
    capability: ENGINEER_LIFECYCLE_CAPABILITY,
    engineerRunId: created.engineerRunId,
    correlationId: created.correlationId,
    attemptKey: created.attemptKey,
    attempt: created.attempt,
    previousEngineerRunId: created.previousEngineerRunId,
    repoRoot: created.repoRoot,
    idea: created.idea,
    readinessRequired: created.readinessRequired === true,
    integrationOwner: normalizeOptional(created.integrationOwner),
    eventRevision: 1,
    state: 'created',
    project: null,
    worktree: null,
    steps: {},
    reconciliation: null,
    handoff: null,
    readiness: null,
    failure: null,
    retention: null,
    retirement: null,
    cleanup: null,
    terminalReason: null,
    createdAt: created.ts,
    updatedAt: created.ts,
  };
  for (const event of events.slice(1)) {
    assertEventIdentity(created, event);
    const wasTerminal = TERMINAL_STATES.has(snapshot.state);
    if (wasTerminal && event.type !== 'engineer_worktree_retired') {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer journal contains ${event.type} after terminal state ${snapshot.state}`);
    }
    snapshot.eventRevision = event.revision;
    snapshot.updatedAt = event.ts;
    switch (event.type) {
      case 'engineer_run_created':
        throw new EngineerLifecycleError('journal_corrupt', 'Engineer journal contains more than one run-created event');
      case 'engineer_readiness_checked': {
        if (!['created', 'authoring'].includes(snapshot.state)) {
          throw new EngineerLifecycleError('journal_corrupt', `Readiness evidence is illegal while the run is ${snapshot.state}`);
        }
        const evidence = validateReadinessEvidence(event);
        if (event.permitted && evidence.status === 'blocked') {
          throw new EngineerLifecycleError('journal_corrupt', 'Blocked readiness evidence cannot be permitted');
        }
        snapshot.readiness = {
          ...evidence,
          permitted: event.permitted,
          checkedAt: event.ts,
        };
        break;
      }
      case 'engineer_run_started':
        if (snapshot.state !== 'created') {
          throw new EngineerLifecycleError('journal_corrupt', `Run start is illegal while the run is ${snapshot.state}`);
        }
        assertSnapshotReady(snapshot, 'journal_corrupt');
        snapshot.state = 'authoring';
        break;
      case 'engineer_routing_selected':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.project = event.project;
        break;
      case 'engineer_worktree_created':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.worktree = { path: event.worktreePath, branch: event.branch, planSlug: event.planSlug };
        break;
      case 'engineer_step_started':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.steps[event.step] = {
          status: 'started',
          attempt: event.stepAttempt,
          ...(event.provider ? { provider: event.provider } : {}),
          ...(event.model ? { model: event.model } : {}),
        };
        break;
      case 'engineer_step_completed':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.steps[event.step] = {
          ...snapshot.steps[event.step],
          status: 'completed',
          attempt: event.stepAttempt,
          completion: event.completion,
          ...(event.artifactPaths ? { artifactPaths: event.artifactPaths } : {}),
        };
        break;
      case 'engineer_step_failed':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.steps[event.step] = { ...snapshot.steps[event.step], status: 'failed', attempt: event.stepAttempt, error: event.error };
        break;
      case 'engineer_step_retried':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.steps[event.step] = { ...snapshot.steps[event.step], status: 'retrying', attempt: event.stepAttempt, reason: event.reason };
        break;
      case 'engineer_step_skipped':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.steps[event.step] = { status: 'skipped', attempt: event.stepAttempt, reason: event.reason };
        break;
      case 'engineer_land_reconciled':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.reconciliation = {
          planSlug: event.planSlug,
          track: event.track,
          tier: event.tier,
          completed: [...event.completed],
          skipped: [...event.skipped],
        };
        break;
      case 'engineer_land_refused':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.terminalReason = event.reason;
        break;
      case 'engineer_spec_handoff':
        assertReplayAuthoring(snapshot, event.type);
        snapshot.state = 'awaiting_spec_merge';
        snapshot.handoff = {
          planSlug: event.planSlug,
          branch: event.branch,
          prUrl: event.prUrl,
          outcome: event.outcome,
        };
        if (event.retainedCommit && event.retainedAt && event.retentionDeadline) {
          snapshot.retention = {
            retainedCommit: normalizeCommit(event.retainedCommit)!,
            retainedAt: normalizeIsoDate(event.retainedAt, 'retainedAt'),
            retentionDeadline: normalizeIsoDate(event.retentionDeadline, 'retentionDeadline'),
          };
        } else if (snapshot.readinessRequired) {
          throw new EngineerLifecycleError('journal_corrupt', 'Current Engineer handoff is missing retained-worktree identity');
        }
        break;
      case 'engineer_run_cancelled':
        if (snapshot.state === 'settled') {
          throw new EngineerLifecycleError('journal_corrupt', 'Settled Engineer run cannot be cancelled');
        }
        snapshot.state = 'cancelled';
        snapshot.terminalReason = event.reason;
        break;
      case 'engineer_run_failed': {
        snapshot.state = 'failed';
        snapshot.terminalReason = event.error;
        snapshot.failure = failureEvidenceFromEvent(event);
        break;
      }
      case 'engineer_run_settled':
        if (snapshot.state !== 'awaiting_spec_merge') {
          throw new EngineerLifecycleError('journal_corrupt', `Run settlement is illegal while the run is ${snapshot.state}`);
        }
        snapshot.state = 'settled';
        break;
      case 'engineer_worktree_retired':
        if (!wasTerminal || !['settled', 'cancelled'].includes(snapshot.state) || !snapshot.worktree) {
          throw new EngineerLifecycleError('journal_corrupt', 'Worktree retirement requires a settled or cancelled run with exact worktree identity');
        }
        if (snapshot.retirement) {
          throw new EngineerLifecycleError('journal_corrupt', 'Engineer journal contains duplicate worktree retirement');
        }
        if (
          snapshot.worktree.path !== event.worktreePath
          || snapshot.worktree.branch !== event.branch
          || snapshot.worktree.planSlug !== event.planSlug
        ) {
          throw new EngineerLifecycleError('journal_corrupt', 'Engineer worktree retirement identity does not match the retained worktree');
        }
        snapshot.retirement = {
          worktreePath: event.worktreePath,
          branch: event.branch,
          planSlug: event.planSlug,
          reason: event.reason,
          retainedCommit: normalizeCommit(event.retainedCommit),
          retiredAt: event.ts,
        };
        break;
    }
  }
  return snapshot;
}

function assertEventIdentity(
  created: Extract<EngineerLifecycleEvent, { type: 'engineer_run_created' }>,
  event: EngineerLifecycleEvent,
): void {
  for (const field of [
    'schemaVersion',
    'engineerRunId',
    'correlationId',
    'attemptKey',
    'attempt',
    'previousEngineerRunId',
    'repoRoot',
  ] as const) {
    if (event[field] !== created[field]) {
      throw new EngineerLifecycleError('journal_corrupt', `Engineer journal identity field ${field} changed at revision ${event.revision}`);
    }
  }
}

function assertSnapshotReady(
  snapshot: EngineerRunSnapshot,
  code: 'journal_corrupt' | 'readiness_required' | 'readiness_blocked',
): void {
  if (!snapshot.readinessRequired) return;
  if (!snapshot.readiness) {
    throw new EngineerLifecycleError(code === 'journal_corrupt' ? code : 'readiness_required', 'Engineer readiness evidence is required before authoring');
  }
  if (!snapshot.readiness.permitted) {
    throw new EngineerLifecycleError(code === 'journal_corrupt' ? code : 'readiness_blocked', `Engineer readiness is ${snapshot.readiness.status}`);
  }
}

function assertReplayAuthoring(snapshot: EngineerRunSnapshot, eventType: string): void {
  if (snapshot.state !== 'authoring') {
    throw new EngineerLifecycleError('journal_corrupt', `${eventType} is illegal while the run is ${snapshot.state}`);
  }
  assertSnapshotReady(snapshot, 'journal_corrupt');
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOwner(value: string | null | undefined): string | null {
  const owner = normalizeOptional(value);
  if (owner !== null && owner.length > 256) {
    throw new EngineerLifecycleError('integration_owner_mismatch', 'integrationOwner must be at most 256 characters');
  }
  return owner;
}

function normalizeCommit(value: string | null | undefined): string | null {
  const commit = normalizeOptional(value);
  if (commit === null) return null;
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new EngineerLifecycleError('identity_mismatch', 'retainedCommit must be a full Git object id');
  }
  return commit.toLowerCase();
}

function normalizeIsoDate(value: string, name: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new EngineerLifecycleError('invalid_transition', `${name} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function validateReadinessEvidence(input: EngineerReadinessEvidence): EngineerReadinessEvidence {
  const statuses = new Set(['ready', 'blocked', 'inconclusive']);
  if (!statuses.has(input.status)) {
    throw new EngineerLifecycleError('invalid_transition', 'Readiness status is invalid');
  }
  const code = requireStableCode(input.code, 'readiness code');
  const summary = requireBoundedText(input.summary, 'readiness summary', 240);
  const checkedCapabilities = [...new Set(input.checkedCapabilities.map((capability) =>
    requireBoundedText(capability, 'checked capability', 64)))];
  if (checkedCapabilities.length === 0 || checkedCapabilities.length > 32) {
    throw new EngineerLifecycleError('invalid_transition', 'Readiness must contain between 1 and 32 checked capabilities');
  }
  const remedy = normalizeBoundedOptional(input.remedy, 'readiness remedy', 512);
  const diagnostic = normalizeBoundedOptional(input.diagnostic, 'readiness diagnostic', 2_048);
  const fingerprint = requireBoundedText(input.fingerprint, 'readiness fingerprint', 128);
  return {
    status: input.status,
    code,
    summary,
    checkedCapabilities,
    retryable: input.retryable,
    remedy,
    diagnostic,
    fingerprint,
  };
}

function validateFailureEvidence(input: EngineerFailureEvidence): EngineerFailureEvidence {
  const classes = new Set(['authentication', 'authorization', 'remote', 'workspace', 'tooling', 'provider', 'unknown']);
  if (!classes.has(input.class)) {
    throw new EngineerLifecycleError('invalid_transition', 'Engineer failure class is invalid');
  }
  return {
    error: requireBoundedText(input.error, 'error', 2_048),
    class: input.class,
    code: requireStableCode(input.code, 'failure code'),
    summary: requireBoundedText(input.summary, 'failure summary', 240),
    retryable: input.retryable,
    remedy: normalizeBoundedOptional(input.remedy, 'failure remedy', 512),
    diagnostic: normalizeBoundedOptional(input.diagnostic, 'failure diagnostic', 2_048),
  };
}

function isStoredFailureEvidence(value: unknown): value is EngineerFailureEvidence {
  if (!isRecord(value)) return false;
  return typeof value.error === 'string'
    && typeof value.class === 'string'
    && typeof value.code === 'string'
    && typeof value.summary === 'string'
    && typeof value.retryable === 'boolean'
    && (value.remedy === null || typeof value.remedy === 'string')
    && (value.diagnostic === null || typeof value.diagnostic === 'string');
}

function failureEvidenceFromEvent(
  event: Extract<EngineerLifecycleEvent, { type: 'engineer_run_failed' }>,
): EngineerFailureEvidence | null {
  if (
    event.class === undefined
    || event.code === undefined
    || event.summary === undefined
    || event.retryable === undefined
  ) return null;
  return validateFailureEvidence({
    error: event.error,
    class: event.class,
    code: event.code,
    summary: event.summary,
    retryable: event.retryable,
    remedy: event.remedy ?? null,
    diagnostic: event.diagnostic ?? null,
  });
}

function requireStableCode(value: string, name: string): string {
  const code = requireText(value, name);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    throw new EngineerLifecycleError('invalid_transition', `${name} must be a stable lowercase code`);
  }
  return code;
}

function requireBoundedText(value: string, name: string, maxLength: number): string {
  const text = requireText(value, name);
  if (text.length > maxLength) {
    throw new EngineerLifecycleError('invalid_transition', `${name} must be at most ${maxLength} characters`);
  }
  return text;
}

function normalizeBoundedOptional(
  value: string | null | undefined,
  name: string,
  maxLength: number,
): string | null {
  const text = normalizeOptional(value);
  if (text !== null && text.length > maxLength) {
    throw new EngineerLifecycleError('invalid_transition', `${name} must be at most ${maxLength} characters`);
  }
  return text;
}

function requireText(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new EngineerLifecycleError('invalid_transition', `${name} must not be empty`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
