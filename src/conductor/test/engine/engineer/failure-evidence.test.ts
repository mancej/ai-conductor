import { describe, expect, it } from 'vitest';

import { classifyEngineerFailure, redactEngineerDiagnostic } from '../../../src/engine/engineer/failure-evidence.js';
import { EngineerLifecycleError } from '../../../src/engine/engineer/run-store.js';

describe('Engineer failure evidence', () => {
  it.each([
    ['git@github.com: Permission denied (publickey).', 'authentication', 'authentication_required'],
    ['remote: Write access to repository not granted.', 'authorization', 'remote_authorization_denied'],
    ['fatal: unable to access remote: Could not resolve host github.com', 'remote', 'remote_unreachable'],
    ['spawn mmdc ENOENT command not found', 'tooling', 'tool_missing'],
    ['fatal: not a git repository', 'workspace', 'invalid_repository'],
    ['Codex provider model failed', 'provider', 'provider_failed'],
    ['something novel happened', 'unknown', 'unknown_failure'],
  ])('classifies %s', (message, expectedClass, expectedCode) => {
    expect(classifyEngineerFailure(message)).toMatchObject({ class: expectedClass, code: expectedCode });
  });

  it('uses stable error codes for retirement identity and missing-path failures', () => {
    expect(classifyEngineerFailure(
      new EngineerLifecycleError('identity_mismatch', 'marker mismatch'),
    )).toMatchObject({
      class: 'workspace',
      code: 'workspace_identity_mismatch',
      retryable: false,
    });
    expect(classifyEngineerFailure(Object.assign(new Error('lstat failed'), { code: 'ENOENT' })))
      .toMatchObject({ class: 'workspace', code: 'workspace_missing', retryable: false });
  });

  it('redacts credentials and bounds persisted diagnostics', () => {
    const value = `Authorization: Bearer secret-value github_pat_abcdefghijklmnopqrstuvwxyz123456 `
      + `DEPLOY_TOKEN=deploy-secret AWS_SECRET_ACCESS_KEY: 'aws-secret-value' ${'x'.repeat(4_000)}`;
    const redacted = redactEngineerDiagnostic(value);
    expect(redacted).not.toContain('secret-value');
    expect(redacted).not.toContain('github_pat_');
    expect(redacted).not.toContain('deploy-secret');
    expect(redacted).not.toContain('aws-secret-value');
    expect(redacted).toContain('DEPLOY_TOKEN=[REDACTED]');
    expect(redacted).toContain('AWS_SECRET_ACCESS_KEY: [REDACTED]');
    expect(redacted.length).toBeLessThanOrEqual(2_048);
    expect(redacted).toContain('[REDACTED');
  });
});
