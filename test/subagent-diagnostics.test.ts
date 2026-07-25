import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveSubagentSessionRoot,
  failedToolName,
  formatToolFailureDiagnostic,
  parseDelegationReplayAudit,
  parseToolFailureDiagnostic,
  readDelegationReplayAudit,
  readToolFailureDiagnostic,
  type DelegationReplayExpectation,
} from '../src/integrations/subagents/diagnostics.ts';
import {
  encodeChildPolicy,
  extractChildPolicy,
  type ChildStepPolicy,
} from '../src/integrations/subagents/protocol.ts';

function replayPolicy(
  bash: ChildStepPolicy['permissions']['bash'] = {
    mode: 'unrestricted',
    allow: [],
  },
): ChildStepPolicy {
  const directory = join(tmpdir(), 'pi-workflows-step-diagnostics');
  return {
    version: 1,
    requestId: 'diagnostic-request',
    agent: 'scout',
    workflowId: 'diagnostic-workflow',
    runId: 'diagnostic-run',
    stepId: 'inspect',
    stepTitle: 'Inspect',
    policyDigest: 'a'.repeat(64),
    capabilityPath: join(directory, 'capability'),
    capabilityToken: 'b'.repeat(64),
    resultPath: join(directory, 'result.json'),
    permissions: {
      tools: ['bash', 'read'],
      mcp: [],
      extensions: [],
      skills: [],
      bash,
    },
    outcomes: ['done', 'blocked'],
    pauseOutcomes: ['blocked'],
    summaryMaxChars: 1_000,
  };
}

function persistedDelegationTask(policy: ChildStepPolicy): string {
  const requestTask = [
    encodeChildPolicy(policy),
    'Inspect the repository.',
    `<pi-workflows-delegation-binding-v1>${policy.requestId}:${policy.policyDigest}</pi-workflows-delegation-binding-v1>`,
  ].join('\n\n');
  const extracted = extractChildPolicy(requestTask);
  if (!extracted) throw new Error('test delegation policy was not extracted');
  return extracted.task;
}

function replayExpectation(
  policy: ChildStepPolicy,
): DelegationReplayExpectation {
  return {
    task: persistedDelegationTask(policy),
    bashPermission: policy.permissions.bash,
    approvedBashCommands: policy.approvedBashCommands ?? [],
  };
}

function boundTranscript(policy: ChildStepPolicy, body = ''): string {
  return [
    JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: persistedDelegationTask(policy),
          },
        ],
      },
    }),
    body,
  ]
    .filter(Boolean)
    .join('\n');
}

function transcript(): string {
  return [
    '{not json}',
    JSON.stringify({ type: 'metadata' }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'bash-1',
            name: 'bash',
            arguments: {
              command:
                'rg -n "class WorkflowHarness|constructor\\(" src/harness.ts',
            },
          },
          {
            type: 'toolCall',
            id: 'read-1',
            name: 'read',
            arguments: { path: 'src/harness.ts' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'bash-1',
        toolName: 'bash',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'substitutions and escapes are not allowed inside double quotes',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        isError: true,
        content: [{ type: 'text', text: 'file was not found' }],
      },
    }),
  ].join('\n');
}

function transcriptWithCompletion(): string {
  return [
    transcript(),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'complete-1',
            name: 'structured_output',
            arguments: { value: { outcome: 'done', summary: 'Recovered' } },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'complete-1',
        toolName: 'structured_output',
        isError: false,
        content: [{ type: 'text', text: 'Structured output captured.' }],
      },
    }),
  ].join('\n');
}

function transcriptWithSuccessfulOutputCompletion(): string {
  return [
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'bash-source',
            name: 'bash',
            arguments: {
              command: "sed -n '650,700p' src/workflow-status.ts",
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'bash-source',
        toolName: 'bash',
        isError: false,
        content: [
          {
            type: 'text',
            text: [
              "650  if (status === 'failed') return 'exit 1';",
              "651  return 'ready';",
            ].join('\n'),
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'complete-after-source',
            name: 'structured_output',
            arguments: {
              value: { outcome: 'done', summary: 'Inspected source' },
            },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'complete-after-source',
        toolName: 'structured_output',
        isError: false,
        content: [{ type: 'text', text: 'Structured output captured.' }],
      },
    }),
  ].join('\n');
}

describe('when testing subagent failure diagnostics', () => {
  test('correlates an exact failed Bash command from a child session', () => {
    const terminalError =
      'bash failed (exit 1): substitutions and escapes are not allowed inside double quotes';
    expect(
      parseToolFailureDiagnostic(transcript(), 'bash', terminalError),
    ).toEqual({
      tool: 'bash',
      call: 'rg -n "class WorkflowHarness|constructor\\(" src/harness.ts',
      output: 'substitutions and escapes are not allowed inside double quotes',
    });
    expect(parseToolFailureDiagnostic(transcript())).toEqual({
      tool: 'read',
      call: '{"path":"src/harness.ts"}',
      output: 'file was not found',
    });
    expect(parseToolFailureDiagnostic('')).toBe(undefined);
    expect(
      parseToolFailureDiagnostic(
        transcript(),
        'bash',
        'bash failed (exit 1): a different command failed',
      ),
    ).toBe(undefined);
    expect(
      parseToolFailureDiagnostic(
        transcriptWithCompletion(),
        'bash',
        'bash failed (exit 1): unrelated terminal summary',
      ),
    ).toEqual({
      tool: 'bash',
      call: 'rg -n "class WorkflowHarness|constructor\\(" src/harness.ts',
      output: 'substitutions and escapes are not allowed inside double quotes',
      completionAfterFailure: true,
      completionValue: { outcome: 'done', summary: 'Recovered' },
      correlation: 'latest-before-completion',
    });

    const laterFailure = [
      transcriptWithCompletion(),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'bash-2',
              name: 'bash',
              arguments: { command: 'git status --short' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'bash-2',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'later command failed' }],
        },
      }),
    ].join('\n');
    expect(
      parseToolFailureDiagnostic(
        laterFailure,
        'bash',
        'bash failed (exit 1): unrelated terminal summary',
      ),
    ).toBe(undefined);
    expect(
      parseToolFailureDiagnostic(laterFailure, 'bash', terminalError),
    ).toEqual({
      tool: 'bash',
      call: 'rg -n "class WorkflowHarness|constructor\\(" src/harness.ts',
      output: 'substitutions and escapes are not allowed inside double quotes',
    });
  });

  test('does not mark an unknown-effect Bash transcript as replay-safe', () => {
    const command = 'bun install --cwd /tmp/worktree --frozen-lockfile';
    const candidate = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'install',
              name: 'bash',
              arguments: { command },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'install',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'install failed after extraction' }],
        },
      }),
    ].join('\n');

    expect(
      parseToolFailureDiagnostic(
        candidate,
        'bash',
        'bash failed (exit 1): install failed after extraction',
      ),
    ).toEqual({
      tool: 'bash',
      call: command,
      output: 'install failed after extraction',
    });
  });

  test('audits the whole attempt before authorizing a reinforcement retry', () => {
    const policy = replayPolicy({ mode: 'read-only', allow: [] });
    const validReadAttempt = transcript().split('\n').slice(1).join('\n');
    expect(
      parseDelegationReplayAudit(
        boundTranscript(policy, validReadAttempt),
        replayExpectation(policy),
      ),
    ).toEqual({
      replaySafe: true,
      toolCount: 2,
    });
    expect(
      parseDelegationReplayAudit(
        boundTranscript(policy),
        replayExpectation(policy),
      ),
    ).toEqual({
      replaySafe: true,
      toolCount: 0,
    });
    expect(
      parseDelegationReplayAudit(validReadAttempt, replayExpectation(policy)),
    ).toEqual({
      replaySafe: false,
      toolCount: 2,
    });
    expect(
      parseDelegationReplayAudit(
        boundTranscript(policy, transcript()),
        replayExpectation(policy),
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 2,
    });
    expect(
      parseDelegationReplayAudit(
        boundTranscript(policy, validReadAttempt),
        replayExpectation(policy),
        false,
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 2,
    });

    const siblingPolicy = { ...policy, requestId: 'sibling-request' };
    expect(
      parseDelegationReplayAudit(
        boundTranscript(siblingPolicy, validReadAttempt),
        replayExpectation(policy),
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 2,
    });

    const unknownEffect = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'install',
              name: 'bash',
              arguments: { command: 'bun install' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'install',
          toolName: 'bash',
          isError: true,
          content: [
            {
              type: 'text',
              text: 'command does not match this step',
            },
          ],
        },
      }),
    ].join('\n');
    const unrestrictedPolicy = replayPolicy();
    expect(
      parseDelegationReplayAudit(
        boundTranscript(unrestrictedPolicy, unknownEffect),
        replayExpectation(unrestrictedPolicy),
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 1,
    });

    const deniedPolicy = replayPolicy({ mode: 'deny', allow: [] });
    expect(
      parseDelegationReplayAudit(
        boundTranscript(deniedPolicy, unknownEffect),
        replayExpectation(deniedPolicy),
      ),
    ).toEqual({
      replaySafe: true,
      toolCount: 1,
    });

    const approvedPolicy = {
      ...replayPolicy({
        mode: 'allow-list',
        allow: [],
        approvedSources: ['verification-worker'],
      }),
      approvedBashCommands: ['bun install'],
    } satisfies ChildStepPolicy;
    expect(
      parseDelegationReplayAudit(
        boundTranscript(approvedPolicy, unknownEffect),
        replayExpectation(approvedPolicy),
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 1,
    });

    expect(
      parseDelegationReplayAudit(
        boundTranscript(
          unrestrictedPolicy,
          unknownEffect.replace('"toolName":"bash"', '"toolName":"read"'),
        ),
        replayExpectation(unrestrictedPolicy),
      ),
    ).toEqual({
      replaySafe: false,
      toolCount: 1,
    });
  });

  test('proves a terminal false positive from successful tool output', () => {
    const candidate = transcriptWithSuccessfulOutputCompletion();
    const successfulOutput = [
      "650  if (status === 'failed') return 'exit 1';",
      "651  return 'ready';",
    ].join('\n');
    const terminalError = `bash failed (exit 1): ${successfulOutput}`;

    expect(
      parseToolFailureDiagnostic(candidate, 'bash', terminalError),
    ).toEqual({
      tool: 'bash',
      call: "sed -n '650,700p' src/workflow-status.ts",
      output: successfulOutput,
      completionAfterFailure: true,
      completionValue: { outcome: 'done', summary: 'Inspected source' },
      transcriptToolCount: 2,
      transcriptTurnCount: 2,
      correlation: 'successful-output-before-completion',
    });

    const actualFailure = [
      candidate.split('\n').slice(0, 2).join('\n'),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'failed-read',
              name: 'read',
              arguments: { path: 'missing.md' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'failed-read',
          toolName: 'read',
          isError: true,
          content: [{ type: 'text', text: 'File not found' }],
        },
      }),
      candidate.split('\n').slice(2).join('\n'),
    ].join('\n');
    const candidateLines = candidate.split('\n');
    const unresolvedCall = [
      ...candidateLines.slice(0, 2),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'unresolved-read',
              name: 'read',
              arguments: { path: 'README.md' },
            },
          ],
        },
      }),
      ...candidateLines.slice(2),
    ].join('\n');
    const assistantTextAfterOutput = [
      ...candidateLines.slice(0, 2),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Successful source inspection' }],
        },
      }),
      ...candidateLines.slice(2),
    ].join('\n');
    const actualBashFailure = candidate.replace(
      '"isError":false',
      '"isError":true',
    );
    expect(
      parseToolFailureDiagnostic(actualBashFailure, 'bash', terminalError)
        ?.correlation,
    ).not.toBe('successful-output-before-completion');
    for (const invalid of [
      `{not-json}\n${candidate}`,
      candidate.replace('"isError":false,', ''),
      candidate.replace(
        '"toolCallId":"bash-source"',
        '"toolCallId":"unmatched-call"',
      ),
      candidate.replace('"id":"complete-after-source"', '"id":"bash-source"'),
      [
        ...candidateLines.slice(0, 2),
        candidateLines[1],
        ...candidateLines.slice(2),
      ].join('\n'),
      `${candidate}\n${candidateLines.slice(-2).join('\n')}`,
      unresolvedCall,
      assistantTextAfterOutput,
      candidate.replace(
        '"role":"assistant","content"',
        '"role":"assistant","errorMessage":"provider retry failed","content"',
      ),
      candidate
        .replace(
          "650  if (status === 'failed') return 'exit 1';",
          'unrelated successful output',
        )
        .replace("651  return 'ready';", 'another unrelated line'),
      `${candidate}\n${JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'continued after completion' }],
        },
      })}`,
      actualFailure,
    ]) {
      expect(parseToolFailureDiagnostic(invalid, 'bash', terminalError)).toBe(
        undefined,
      );
    }
    expect(
      parseToolFailureDiagnostic(candidate, 'bash', terminalError, false),
    ).toBe(undefined);
    for (const mismatchedTerminal of [
      terminalError.replace('exit 1', 'exit 2'),
      terminalError.replace("return 'ready'", "RETURN 'READY'"),
      `read failed (exit 1): ${successfulOutput}`,
    ]) {
      expect(
        parseToolFailureDiagnostic(candidate, 'bash', mismatchedTerminal),
      ).toBe(undefined);
    }
  });

  test('reads only child sessions contained by the parent session root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-session-'));
    const trustedRoot = deriveSubagentSessionRoot(
      join(directory, 'parent.jsonl'),
    );
    expect(trustedRoot).toBe(join(directory, 'parent'));
    const identity = { runId: 'child-run', childIndex: 0 };
    const runDirectory = join(
      trustedRoot!,
      identity.runId,
      `run-${identity.childIndex}`,
    );
    const sessionFile = join(runDirectory, 'session.jsonl');
    const siblingDirectory = join(trustedRoot!, 'sibling-run', 'run-0');
    const siblingSession = join(siblingDirectory, 'session.jsonl');
    const outsideDirectory = join(directory, 'outside', 'run-0');
    const outsideSession = join(outsideDirectory, 'session.jsonl');
    const symlinkDirectory = join(trustedRoot!, 'child-run', 'run-1');
    const symlinkSession = join(symlinkDirectory, 'session.jsonl');
    try {
      await mkdir(runDirectory, { recursive: true });
      await mkdir(siblingDirectory, { recursive: true });
      await mkdir(outsideDirectory, { recursive: true });
      await mkdir(symlinkDirectory, { recursive: true });
      await writeFile(sessionFile, transcript());
      await writeFile(
        siblingSession,
        transcript().replaceAll('rg -n', 'SIBLING_SECRET'),
      );
      await writeFile(
        outsideSession,
        transcript().replaceAll('rg -n', 'SECRET'),
      );
      await symlink(outsideSession, symlinkSession);

      expect(
        await readToolFailureDiagnostic(
          sessionFile,
          trustedRoot,
          identity,
          'bash',
          'bash failed (exit 1): substitutions and escapes are not allowed inside double quotes',
        ),
      ).toMatchObject({
        tool: 'bash',
        call: expect.stringContaining('WorkflowHarness'),
      });
      expect(
        await readDelegationReplayAudit(
          sessionFile,
          trustedRoot,
          identity,
          replayExpectation(replayPolicy()),
        ),
      ).toEqual({
        replaySafe: false,
        toolCount: 2,
      });
      expect(
        await readDelegationReplayAudit(
          undefined,
          trustedRoot,
          identity,
          replayExpectation(replayPolicy()),
        ),
      ).toBe(undefined);
      expect(
        await readDelegationReplayAudit(
          join(trustedRoot!, 'missing', 'run-2', 'session.jsonl'),
          trustedRoot,
          { runId: 'missing', childIndex: 2 },
          replayExpectation(replayPolicy()),
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(undefined, trustedRoot, identity),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(
          join(directory, 'other.jsonl'),
          trustedRoot,
          identity,
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(
          siblingSession,
          trustedRoot,
          identity,
          'bash',
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(
          outsideSession,
          trustedRoot,
          identity,
          'bash',
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(
          symlinkSession,
          trustedRoot,
          { runId: 'child-run', childIndex: 1 },
          'bash',
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(
          join(trustedRoot!, 'missing', 'run-2', 'session.jsonl'),
          trustedRoot,
          { runId: 'missing', childIndex: 2 },
        ),
      ).toBe(undefined);
      expect(
        await readToolFailureDiagnostic(sessionFile, trustedRoot, undefined),
      ).toBe(undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('bounds a large child transcript while retaining its terminal failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-session-'));
    const trustedRoot = join(directory, 'parent');
    const runDirectory = join(trustedRoot, 'child-run', 'run-0');
    const sessionFile = join(runDirectory, 'session.jsonl');
    try {
      await mkdir(runDirectory, { recursive: true });
      await writeFile(
        sessionFile,
        `${'{"type":"padding"}\n'.repeat(80_000)}${transcript()}`,
      );

      expect(
        await readToolFailureDiagnostic(
          sessionFile,
          trustedRoot,
          { runId: 'child-run', childIndex: 0 },
          'bash',
          'bash failed (exit 1): substitutions and escapes are not allowed inside double quotes',
        ),
      ).toMatchObject({
        tool: 'bash',
        call: expect.stringContaining('WorkflowHarness'),
      });
      await writeFile(
        sessionFile,
        `${'{"type":"padding"}\n'.repeat(80_000)}${transcriptWithCompletion()}`,
      );
      expect(
        await readToolFailureDiagnostic(
          sessionFile,
          trustedRoot,
          { runId: 'child-run', childIndex: 0 },
          'bash',
          'bash failed (exit 1): unrelated terminal summary',
        ),
      ).toBe(undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('requires a correlated successful structured_output tool call', () => {
    const terminalError = 'bash failed (exit 1): unrelated terminal summary';
    const uncorrelatedCompletion = [
      transcript(),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'missing-call',
          toolName: 'structured_output',
          isError: false,
          content: [{ type: 'text', text: 'Structured output captured.' }],
        },
      }),
    ].join('\n');
    const missingSuccessFlag = transcriptWithCompletion().replace(
      '"isError":false,',
      '',
    );
    const mismatchedCallName = transcriptWithCompletion().replace(
      '"name":"structured_output"',
      '"name":"read"',
    );
    const laterInteraction = [
      transcriptWithCompletion(),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'read-after-completion',
              name: 'read',
              arguments: { path: 'README.md' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'read-after-completion',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'read succeeded' }],
        },
      }),
    ].join('\n');
    const secondCompletion = [
      transcriptWithCompletion(),
      transcriptWithCompletion().split('\n').slice(-2).join('\n'),
    ].join('\n');

    for (const candidate of [
      uncorrelatedCompletion,
      missingSuccessFlag,
      mismatchedCallName,
      laterInteraction,
      secondCompletion,
    ]) {
      expect(parseToolFailureDiagnostic(candidate, 'bash', terminalError)).toBe(
        undefined,
      );
    }
  });

  test('formats actionable labels and extracts the failed tool name', () => {
    expect(
      failedToolName('Subagent "scout" failed: bash failed (exit 1): denied'),
    ).toBe('bash');
    expect(failedToolName(undefined)).toBe(undefined);
    expect(
      formatToolFailureDiagnostic({
        tool: 'bash',
        call: 'git worktree list',
        output: 'git subcommand "worktree" is not read-only',
      }),
    ).toEqual([
      'Failed tool: bash',
      'Command: git worktree list',
      'Tool error: git subcommand "worktree" is not read-only',
    ]);
    expect(
      formatToolFailureDiagnostic({
        tool: 'read',
        call: '{"path":"missing"}',
      }),
    ).toEqual(['Failed tool: read', 'Arguments: {"path":"missing"}']);
    expect(
      formatToolFailureDiagnostic({
        tool: 'bash',
        correlation: 'latest-before-completion',
      }),
    ).toContain(
      'Correlation: latest failed tool call before successful structured_output; terminal text did not identify the call',
    );
    expect(
      formatToolFailureDiagnostic({
        tool: 'bash',
        call: 'sed -n 1,20p src/example.ts',
        output: 'const example = "exit 1";',
        correlation: 'successful-output-before-completion',
      }),
    ).toEqual([
      'Terminal-reported tool: bash',
      'Command: sed -n 1,20p src/example.ts',
      'Successful tool output: const example = "exit 1";',
      'Correlation: terminal error text came from a successful tool result before the final structured_output',
    ]);
    expect(deriveSubagentSessionRoot(undefined)).toBe(undefined);
    expect(deriveSubagentSessionRoot('relative.jsonl')).toBe(undefined);
    expect(deriveSubagentSessionRoot(join(tmpdir(), 'not-a-session.txt'))).toBe(
      undefined,
    );
  });
});
