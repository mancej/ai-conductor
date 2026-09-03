import { access, realpath } from 'node:fs/promises';

import type { EngineerWorktreeRetirementReason } from '../../types/index.js';
import type { HarnessConfig } from '../../types/config.js';
import type { GhRunner } from '../tracker-client.js';
import { makeProductionGh } from '../tracker-client.js';
import type { GitRunner } from '../pr-labels.js';
import { makeProductionGit } from '../pr-labels.js';
import { removeEngineerWorktree } from './worktree-authoring.js';
import { classifyEngineerFailure, redactEngineerDiagnostic } from './failure-evidence.js';
import { readEngineerRunMarker } from './run-marker.js';
import {
  EngineerLifecycleError,
  type EngineerRunSnapshot,
  type EngineerRunStore,
} from './run-store.js';

export const DEFAULT_ENGINEER_RETENTION_DAYS = 14;
export const DEFAULT_ENGINEER_RETENTION_MS = DEFAULT_ENGINEER_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const ENGINEER_CLEANUP_RETRY_BACKOFF_MS = 15 * 60 * 1_000;

export function resolveEngineerRetentionMs(
  config?: Pick<HarnessConfig, 'engineer_review_retention_days'>,
): number {
  const days = config?.engineer_review_retention_days;
  if (days === undefined || !Number.isInteger(days) || days < 1 || days > 90) {
    return DEFAULT_ENGINEER_RETENTION_MS;
  }
  return days * 24 * 60 * 60 * 1_000;
}

export type EngineerPullRequestState = 'open' | 'merged' | 'closed';

export interface EngineerRetentionDeps {
  git?: GitRunner;
  gh?: GhRunner;
  removeWorktree?: (repoRoot: string, worktreePath: string) => Promise<void>;
  resolvePath?: (path: string) => Promise<string>;
  pathExists?: (path: string) => Promise<boolean>;
  now?: () => Date;
  readPullRequestState?: (prUrl: string, repoRoot: string) => Promise<EngineerPullRequestState>;
  log?: (message: string) => void;
}

export function engineerRetentionDeadline(
  now = new Date(),
  retentionMs = DEFAULT_ENGINEER_RETENTION_MS,
): string {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new EngineerLifecycleError('invalid_transition', 'Engineer retention timeout must be positive and bounded');
  }
  return new Date(now.getTime() + retentionMs).toISOString();
}

export async function retainedWorktreeCommit(
  worktreePath: string,
  git: GitRunner = makeProductionGit(),
): Promise<string> {
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: worktreePath });
  const commit = stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new EngineerLifecycleError('identity_mismatch', 'Engineer worktree HEAD is not a full Git object id');
  }
  return commit;
}

export async function retireEngineerWorktree(input: {
  store: EngineerRunStore;
  engineerRunId: string;
  reason: EngineerWorktreeRetirementReason;
  deps?: EngineerRetentionDeps;
}): Promise<EngineerRunSnapshot> {
  const deps = input.deps ?? {};
  const resolvePath = deps.resolvePath ?? realpath;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const git = deps.git ?? makeProductionGit();
  const removeWorktree = deps.removeWorktree ?? removeEngineerWorktree;
  let snapshot = await input.store.inspectRun(input.engineerRunId);
  if (!snapshot.worktree) {
    throw new EngineerLifecycleError('retirement_not_allowed', 'Engineer run has no exact worktree identity to retire');
  }

  const worktreePath = snapshot.retirement?.worktreePath ?? snapshot.worktree.path;
  if (!snapshot.retirement) {
    try {
      const canonicalRepo = await resolvePath(snapshot.repoRoot);
      const canonicalWorktree = await resolvePath(worktreePath);
      const marker = await readEngineerRunMarker(canonicalWorktree);
      if (
        !marker
        || marker.engineerRunId !== snapshot.engineerRunId
        || marker.repoRoot !== canonicalRepo
        || marker.branch !== snapshot.worktree.branch
        || marker.planSlug !== snapshot.worktree.planSlug
      ) {
        throw new EngineerLifecycleError('identity_mismatch', 'Engineer cleanup marker does not match the exact retained run identity');
      }

      const listing = await git(['worktree', 'list', '--porcelain'], { cwd: canonicalRepo });
      if (!worktreeListingMatches(listing.stdout, canonicalWorktree, snapshot.worktree.branch)) {
        throw new EngineerLifecycleError('identity_mismatch', 'Engineer cleanup target is not the registered worktree for the retained branch');
      }
      const commit = await retainedWorktreeCommit(canonicalWorktree, git);
      if (snapshot.retention && snapshot.retention.retainedCommit !== commit) {
        throw new EngineerLifecycleError('identity_mismatch', 'Engineer retained worktree HEAD changed after handoff');
      }
      snapshot = await input.store.retireWorktree(input.engineerRunId, {
        reason: input.reason,
        retainedCommit: commit,
      });
    } catch (error) {
      const failure = classifyEngineerFailure(error);
      await input.store.recordCleanupAttempt(input.engineerRunId, {
        status: 'failed',
        stage: 'retirement_precondition',
        failure,
        nextAttemptAt: cleanupRetryAfter(deps),
      });
      throw error;
    }
  }

  await input.store.recordCleanupAttempt(input.engineerRunId, {
    status: 'pending',
    stage: 'physical_removal',
  });
  try {
    if (await pathExists(worktreePath)) {
      await removeWorktree(snapshot.repoRoot, worktreePath);
    }
    await input.store.recordCleanupAttempt(input.engineerRunId, { status: 'complete' });
  } catch (error) {
    const failure = classifyEngineerFailure(error);
    await input.store.recordCleanupAttempt(input.engineerRunId, {
      status: 'failed',
      stage: 'physical_removal',
      failure,
      nextAttemptAt: cleanupRetryAfter(deps),
    });
    deps.log?.(`Engineer worktree cleanup debt for ${input.engineerRunId}: ${failure.summary}`);
  }
  return input.store.inspectRun(input.engineerRunId);
}

export async function reconcileEngineerRetainedWorktrees(input: {
  store: EngineerRunStore;
  repoRoot?: string;
  deps?: EngineerRetentionDeps;
}): Promise<void> {
  const deps = input.deps ?? {};
  const now = deps.now?.() ?? new Date();
  const readPullRequestState = deps.readPullRequestState
    ?? ((prUrl: string, repoRoot: string) => productionPullRequestState(prUrl, repoRoot, deps.gh ?? makeProductionGh()));
  const filteredRepoRoot = input.repoRoot
    ? await (deps.resolvePath ?? realpath)(input.repoRoot)
    : null;
  const runs = filteredRepoRoot
    ? await input.store.listRuns({ repoRoot: filteredRepoRoot })
    : await input.store.listRuns();
  for (const run of runs) {
    try {
      if (
        run.cleanup?.status === 'failed'
        && run.cleanup.nextAttemptAt
        && Date.parse(run.cleanup.nextAttemptAt) > now.getTime()
      ) continue;
      if (run.retirement && run.cleanup?.status !== 'complete') {
        await retireEngineerWorktree({
          store: input.store,
          engineerRunId: run.engineerRunId,
          reason: run.retirement.reason,
          deps,
        });
        continue;
      }
      if (!run.worktree || run.retirement) continue;
      let reason: EngineerWorktreeRetirementReason | null = null;
      if (run.state === 'cancelled') {
        reason = 'task_cancelled';
      } else if (run.state === 'settled' && run.retention) {
        if (Date.parse(run.retention.retentionDeadline) <= now.getTime()) {
          reason = 'retention_expired';
        } else if (run.handoff?.outcome === 'pr_opened' && run.handoff.prUrl) {
          let prState: EngineerPullRequestState;
          try {
            prState = await readPullRequestState(run.handoff.prUrl, run.repoRoot);
          } catch (error) {
            await input.store.recordCleanupAttempt(run.engineerRunId, {
              status: 'failed',
              stage: 'retirement_status',
              failure: classifyEngineerFailure(error),
              nextAttemptAt: cleanupRetryAfter(deps),
            });
            throw error;
          }
          if (prState === 'merged') reason = 'spec_merged';
          if (prState === 'closed') reason = 'spec_closed';
          if (
            prState === 'open'
            && run.cleanup?.status === 'failed'
            && run.cleanup.stage === 'retirement_status'
          ) {
            await input.store.recordCleanupAttempt(run.engineerRunId, {
              status: 'pending',
              stage: 'retirement_status',
            });
          }
        }
      }
      if (reason) {
        await retireEngineerWorktree({
          store: input.store,
          engineerRunId: run.engineerRunId,
          reason,
          deps,
        });
      }
    } catch (error) {
      deps.log?.(`Engineer retention reconciliation failed for ${run.engineerRunId}: ${redactEngineerDiagnostic(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

function cleanupRetryAfter(deps: EngineerRetentionDeps): string {
  const now = deps.now?.() ?? new Date();
  return new Date(now.getTime() + ENGINEER_CLEANUP_RETRY_BACKOFF_MS).toISOString();
}

async function productionPullRequestState(
  prUrl: string,
  repoRoot: string,
  gh: GhRunner,
): Promise<EngineerPullRequestState> {
  const result = await gh(['pr', 'view', prUrl, '--json', 'state,mergedAt'], { cwd: repoRoot });
  const parsed = JSON.parse(result.stdout) as { state?: unknown; mergedAt?: unknown };
  if (typeof parsed.mergedAt === 'string' && parsed.mergedAt !== '') return 'merged';
  if (parsed.state === 'OPEN') return 'open';
  if (parsed.state === 'CLOSED') return 'closed';
  throw new Error(`gh returned unsupported PR state ${JSON.stringify(parsed.state)}`);
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function worktreeListingMatches(output: string, path: string, branch: string): boolean {
  const records = output.trim().split(/\n\n+/);
  return records.some((record) => {
    const lines = record.split('\n');
    return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
  });
}
