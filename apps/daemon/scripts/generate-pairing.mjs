import { createHash, randomBytes, randomUUID } from 'node:crypto';

const machineId = randomUUID();
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');

console.log('Keep DAEMON_TOKEN private. Add these values to the two ignored .env files:');
console.log(`apps/voice-webhook/.env: DAEMON_CREDENTIALS=${machineId}:${hash}`);
console.log(`apps/daemon/.env: DAEMON_MACHINE_ID=${machineId}`);
console.log(`apps/daemon/.env: DAEMON_TOKEN=${token}`);
