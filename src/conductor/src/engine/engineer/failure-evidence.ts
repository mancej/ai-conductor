import type { EngineerFailureClass, EngineerFailureEvidence } from '../../types/index.js';

const RAW_ERROR_LIMIT = 2_048;
const DIAGNOSTIC_LIMIT = 2_048;

interface FailureRule {
  pattern: RegExp;
  class: EngineerFailureClass;
  code: string;
  summary: string;
  retryable: boolean;
  remedy: string;
}

const FAILURE_RULES: readonly FailureRule[] = [
  {
    pattern: /no configured remote|no remote configured|does not have any remotes|no git remotes? found/i,
    class: 'remote',
    code: 'remote_missing',
    summary: 'A GitHub handoff was requested but the repository has no configured remote.',
    retryable: false,
    remedy: 'Configure the intended origin remote or select a local-only handoff.',
  },
  {
    pattern: /not a git repository|cannot change to .*no such file|repository path .*does not exist/i,
    class: 'workspace',
    code: 'invalid_repository',
    summary: 'The Engineer repository is unavailable or is not a Git repository.',
    retryable: false,
    remedy: 'Select an existing Git repository and retry readiness.',
  },
  {
    pattern: /command not found|enoent|not found on path|could not find executable/i,
    class: 'tooling',
    code: 'tool_missing',
    summary: 'A required Engineer tool is unavailable.',
    retryable: true,
    remedy: 'Install the named tool or correct PATH, then rerun readiness.',
  },
  {
    pattern: /permission denied \(publickey\)|authentication failed|not logged in|gh auth login|bad credentials|could not read username/i,
    class: 'authentication',
    code: 'authentication_required',
    summary: 'Remote authentication is unavailable from the current process posture.',
    retryable: true,
    remedy: 'Authenticate the current process for the configured remote, then rerun readiness.',
  },
  {
    pattern: /write access .* not granted|repository access denied|permission .* denied|http 403|status code 403/i,
    class: 'authorization',
    code: 'remote_authorization_denied',
    summary: 'The current identity is not authorized for the requested remote operation.',
    retryable: false,
    remedy: 'Grant the current identity access or transfer the attempt to an authorized owner.',
  },
  {
    pattern: /could not resolve host|network is unreachable|connection timed out|connection refused|unable to access .*failed to connect/i,
    class: 'remote',
    code: 'remote_unreachable',
    summary: 'The configured remote is not reachable from the current process posture.',
    retryable: true,
    remedy: 'Restore network or VPN access, then rerun readiness.',
  },
  {
    pattern: /worktree|pathspec|invalid path|no such file or directory/i,
    class: 'workspace',
    code: 'workspace_invalid',
    summary: 'The Engineer workspace identity is invalid or unavailable.',
    retryable: false,
    remedy: 'Recover the exact worktree or cancel the attempt before cleanup.',
  },
  {
    pattern: /provider|model|agent sdk|claude|codex/i,
    class: 'provider',
    code: 'provider_failed',
    summary: 'The configured authoring provider failed.',
    retryable: true,
    remedy: 'Inspect provider availability and retry with a newly reserved attempt when safe.',
  },
];

const FAILURE_CODES: Readonly<Record<string, Omit<FailureRule, 'pattern'>>> = {
  identity_mismatch: {
    class: 'workspace',
    code: 'workspace_identity_mismatch',
    summary: 'The retained Engineer worktree no longer matches its durable identity.',
    retryable: false,
    remedy: 'Restore the exact marker, registered branch, and retained commit before requesting cleanup again.',
  },
  ENOENT: {
    class: 'workspace',
    code: 'workspace_missing',
    summary: 'The retained Engineer worktree or repository path is missing.',
    retryable: false,
    remedy: 'Recover the exact retained path or inspect the durable commit before requesting cleanup again.',
  },
};

export function redactEngineerDiagnostic(value: string, limit = DIAGNOSTIC_LIMIT): string {
  const redacted = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED TOKEN]')
    .replace(/([?&](?:access_token|token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi, '$1[REDACTED]')
    .trim();
  return redacted.length <= limit ? redacted : `${redacted.slice(0, Math.max(0, limit - 15))}...[truncated]`;
}

export function classifyEngineerFailure(error: unknown): EngineerFailureEvidence {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = redactEngineerDiagnostic(message);
  const errorCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const rule = FAILURE_CODES[errorCode]
    ?? FAILURE_RULES.find((candidate) => candidate.pattern.test(diagnostic));
  const evidence = rule ?? {
    class: 'unknown' as const,
    code: 'unknown_failure',
    summary: 'Engineer failed for an unclassified reason.',
    retryable: false,
    remedy: 'Inspect the bounded diagnostic before deciding whether a new attempt is safe.',
  };
  return {
    error: redactEngineerDiagnostic(message, RAW_ERROR_LIMIT) || 'Engineer failed without an error message.',
    class: evidence.class,
    code: evidence.code,
    summary: evidence.summary,
    retryable: evidence.retryable,
    remedy: evidence.remedy,
    diagnostic: diagnostic || null,
  };
}
