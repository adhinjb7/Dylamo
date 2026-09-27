import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Protocol fixture only: never launches Codex, Git, or a model. The integration
// test still uses the production adapter, daemon transport, store and webhooks.
export function stubCodexProcess({ command, cwd, decisions, requests = [] }) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdin.end(); child.stdout.end(); child.stderr.end(); };
  const reply = message => { if (!child.stdout.destroyed && !child.stdout.writableEnded) child.stdout.write(JSON.stringify(message) + '\n'); };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, index));
      requests.push(message);
      buffer = buffer.slice(index + 1);
      queueMicrotask(() => {
        if (message.method === 'initialize') reply({ id: message.id, result: {} });
        if (message.method === 'account/read') reply({ id: message.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
        if (message.method === 'configRequirements/read') reply({ id: message.id, result: { requirements: null } });
        if (message.method === 'config/read') reply({ id: message.id, result: { config: {} } });
        if (message.method === 'thread/start') reply({ id: message.id, result: {
          thread: { id: 'test-thread' }, approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          activePermissionProfile: { id: message.params.permissions, extends: null }, sandbox: { type: 'readOnly', networkAccess: false },
        } });
        if (message.method === 'turn/start') {
          reply({ id: message.id, result: { turn: { id: 'test-turn' } } });
          setImmediate(() => reply({ id: 'approval-rpc', method: 'item/commandExecution/requestApproval', params: {
            threadId: 'test-thread', turnId: 'test-turn', itemId: 'push-item', command, cwd,
            availableDecisions: ['accept', 'decline', 'cancel'], additionalPermissions: { network: { enabled: true } },
          } }));
        }
        if (message.id === 'approval-rpc' && message.result) {
          decisions.push(message.result.decision);
          if (message.result.decision === 'accept') {
            reply({ method: 'item/completed', params: { threadId: 'test-thread', turnId: 'test-turn',
              item: { id: 'push-item', type: 'commandExecution', status: 'completed', exitCode: 0 } } });
            reply({ method: 'item/completed', params: { threadId: 'test-thread', turnId: 'test-turn',
              item: { type: 'agentMessage', phase: 'final_answer', text: 'The fixture push completed.' } } });
            reply({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed' } } });
          }
        }
      });
    }
  });
  return child;
}
