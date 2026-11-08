import type { ArtifactPayload } from './conversation-artifacts';
import type { CommandOutputProps } from './CommandOutputContent';

/** Never trims or truncates the received output; the command stays plain text. */
export function commandLogText({ command, output, exitCode }: Pick<CommandOutputProps, 'command' | 'output' | 'exitCode'>): string {
  return [command ? `$ ${command}` : undefined, output, typeof exitCode === 'number' ? `退出码 ${exitCode}` : undefined]
    .filter((part): part is string => part !== undefined).join('\n\n');
}

export function commandLogPayload(input: CommandOutputProps, now = Date.now()): ArtifactPayload {
  const content = commandLogText(input), name = `command-output-${new Date(now).toISOString().replace(/[:.]/g, '-')}.txt`;
  return { encoding: 'utf8', content, artifact: { id: 'local-command-log', path: name, name, kind: 'text', mime: 'text/plain',
    size: new TextEncoder().encode(content).length, revision: 'local', updatedAt: now } };
}
