import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { execa } from 'execa';

import type { EngineerReadinessEvidence } from '../../types/index.js';
import { EngineerLifecycleError, type EngineerRunStore } from './run-store.js';
import { classifyEngineerFailure, redactEngineerDiagnostic } from './failure-evidence.js';

export interface EngineerReadinessCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type EngineerReadinessCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<EngineerReadinessCommandResult>;

export interface EngineerReadinessInput {
  repoRoot: string;
  githubHandoff: boolean;
  requiredTools?: string[];
  hostPosture?: string;
}

export interface EngineerReadinessDeps {
  run?: EngineerReadinessCommandRunner;
  resolvePath?: (path: string) => Promise<string>;
  path?: string;
  platform?: string;
  arch?: string;
}

const defaultRunner: EngineerReadinessCommandRunner = async (command, args, options) => {
  const result = await execa(command, args, { cwd: options.cwd, reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
};

export async function checkEngineerReadiness(
  input: EngineerReadinessInput,
  deps: EngineerReadinessDeps = {},
): Promise<EngineerReadinessEvidence> {
  const run = deps.run ?? defaultRunner;
  const checkedCapabilities: string[] = [];
  let repoRoot: string;
  try {
    repoRoot = await (deps.resolvePath ?? realpath)(input.repoRoot);
  } catch (error) {
    return readinessFailure(error, ['repository']);
  }

  const gitRoot = await command(run, 'git', ['rev-parse', '--show-toplevel'], repoRoot);
  checkedCapabilities.push('repository', 'git');
  if (!gitRoot.ok) return readinessFailure(gitRoot.error, checkedCapabilities);
  try {
    if (await (deps.resolvePath ?? realpath)(gitRoot.stdout.trim()) !== repoRoot) {
      return readinessFailure(new Error(`Repository identity mismatch: expected ${repoRoot}, received ${gitRoot.stdout.trim()}`), checkedCapabilities);
    }
  } catch (error) {
    return readinessFailure(error, checkedCapabilities);
  }

  const toolFingerprints: string[] = [];
  for (const tool of [...new Set(input.requiredTools ?? [])]) {
    const result = await command(run, tool, ['--version'], repoRoot);
    checkedCapabilities.push(`tool:${tool}`);
    if (!result.ok) return readinessFailure(new Error(`${tool} not found on PATH: ${result.error.message}`), checkedCapabilities);
    toolFingerprints.push(`${tool}:${result.stdout.trim().split('\n')[0] ?? ''}`);
  }

  const remote = await command(run, 'git', ['remote', 'get-url', 'origin'], repoRoot);
  checkedCapabilities.push('remote_configuration');
  if (!remote.ok) {
    if (!input.githubHandoff) {
      return readyEvidence(repoRoot, null, checkedCapabilities, toolFingerprints, input, deps);
    }
    return readinessFailure(new Error(`No configured remote: ${remote.error.message}`), checkedCapabilities);
  }
  const remoteUrl = remote.stdout.trim();
  if (!isParseableRemote(remoteUrl)) {
    return readinessFailure(new Error(`Configured remote is not parseable: ${remoteUrl}`), checkedCapabilities);
  }

  const reachable = await command(run, 'git', ['ls-remote', '--exit-code', 'origin', 'HEAD'], repoRoot);
  checkedCapabilities.push('remote_reachability', 'remote_authentication');
  if (!reachable.ok) return readinessFailure(reachable.error, checkedCapabilities);

  if (input.githubHandoff) {
    const ghVersion = await command(run, 'gh', ['--version'], repoRoot);
    checkedCapabilities.push('tool:gh');
    if (!ghVersion.ok) return readinessFailure(new Error(`gh not found on PATH: ${ghVersion.error.message}`), checkedCapabilities);
    toolFingerprints.push(`gh:${ghVersion.stdout.trim().split('\n')[0] ?? ''}`);
    const ghAuth = await command(run, 'gh', ['auth', 'status'], repoRoot);
    checkedCapabilities.push('github_authentication');
    if (!ghAuth.ok) return readinessFailure(ghAuth.error, checkedCapabilities);
  }

  const fingerprint = readinessFingerprint(repoRoot, remoteUrl, checkedCapabilities, toolFingerprints, input, deps);
  return {
    status: 'inconclusive',
    code: 'push_authorization_unproven',
    summary: 'Read-only remote checks passed; branch push authorization remains unproven.',
    checkedCapabilities,
    retryable: true,
    remedy: 'Repeat the authorization-sensitive check immediately before pushing the specification branch.',
    diagnostic: 'No mutating push was attempted during readiness.',
    fingerprint,
  };
}

export async function recordEngineerReadiness(input: {
  store: EngineerRunStore;
  engineerRunId: string;
  readiness: EngineerReadinessInput;
  permitInconclusive: boolean;
  deps?: EngineerReadinessDeps;
}) {
  const snapshot = await input.store.inspectRun(input.engineerRunId);
  const requestedRoot = await (input.deps?.resolvePath ?? realpath)(input.readiness.repoRoot);
  if (snapshot.repoRoot !== requestedRoot) {
    throw new EngineerLifecycleError('identity_mismatch', 'Run-scoped readiness repository does not match the exact Engineer run');
  }
  const result = await checkEngineerReadiness(input.readiness, input.deps);
  return input.store.record(input.engineerRunId, {
    kind: 'readiness_checked',
    result,
    permitInconclusive: input.permitInconclusive,
  });
}

function readyEvidence(
  repoRoot: string,
  remoteUrl: string | null,
  checkedCapabilities: string[],
  toolFingerprints: string[],
  input: EngineerReadinessInput,
  deps: EngineerReadinessDeps,
): EngineerReadinessEvidence {
  return {
    status: 'ready',
    code: 'ready',
    summary: 'Engineer repository and required local tools are ready.',
    checkedCapabilities,
    retryable: false,
    remedy: null,
    diagnostic: null,
    fingerprint: readinessFingerprint(repoRoot, remoteUrl, checkedCapabilities, toolFingerprints, input, deps),
  };
}

function readinessFailure(error: unknown, checkedCapabilities: string[]): EngineerReadinessEvidence {
  const failure = classifyEngineerFailure(error);
  return {
    status: 'blocked',
    code: failure.code,
    summary: failure.summary,
    checkedCapabilities: checkedCapabilities.length > 0 ? checkedCapabilities : ['repository'],
    retryable: failure.retryable,
    remedy: failure.remedy,
    diagnostic: failure.diagnostic,
    fingerprint: createHash('sha256').update(`blocked\0${failure.code}\0${failure.diagnostic ?? ''}`).digest('hex'),
  };
}

async function command(
  run: EngineerReadinessCommandRunner,
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: Error }> {
  try {
    const result = await run(executable, args, { cwd });
    if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
    return { ok: false, error: new Error(redactEngineerDiagnostic(result.stderr || result.stdout || `${executable} exited ${result.exitCode}`)) };
  } catch (error) {
    return { ok: false, error: new Error(redactEngineerDiagnostic(error instanceof Error ? error.message : String(error))) };
  }
}

function readinessFingerprint(
  repoRoot: string,
  remoteUrl: string | null,
  checkedCapabilities: string[],
  toolFingerprints: string[],
  input: EngineerReadinessInput,
  deps: EngineerReadinessDeps,
): string {
  return createHash('sha256').update(JSON.stringify({
    repoRoot,
    remoteUrl,
    checkedCapabilities,
    toolFingerprints,
    githubHandoff: input.githubHandoff,
    hostPosture: input.hostPosture ?? '',
    path: deps.path ?? process.env.PATH ?? '',
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
  })).digest('hex');
}

function isParseableRemote(value: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[^\s@]+@[^\s:]+:|\/)/.test(value);
}
