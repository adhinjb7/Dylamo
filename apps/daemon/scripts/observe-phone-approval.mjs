import { databasePathFromUrl } from '../../voice-webhook/src/state.mjs';
import { openPhoneApprovalProof, observePhoneApproval, PhoneProofError } from '../src/phone-approval-proof.mjs';

if (process.argv.length !== 3 || !['--check', '--watch'].includes(process.argv[2])) {
  console.log('Usage: node --env-file=apps/voice-webhook/.env --env-file=apps/daemon/.env apps/daemon/scripts/observe-phone-approval.mjs --check|--watch');
  console.log('--check validates the fixture now; --watch starts before the call. Neither makes a call, model turn or push.');
  process.exitCode = 1;
} else {
  let observer;
  try {
    observer = openPhoneApprovalProof({
      workspace: process.env.CODEX_WORKSPACE,
      databasePath: databasePathFromUrl(process.env.DATABASE_URL ?? 'file:./data/agent-phone.db'),
      approvalCommand: process.env.CODEX_APPROVAL_COMMAND,
    });
    if (process.argv[2] === '--check') {
      const current = observer.readSnapshot();
      if (current.remoteCommit) throw new PhoneProofError('The disposable remote already has phone-demo; use a fresh fixture.');
      console.log('PASS: disposable local fixture, exact command, voice database and empty phone-demo ref are ready. No phone approval was tested.');
    } else {
      await observePhoneApproval({ readSnapshot: observer.readSnapshot, onPhase: phase => {
        if (phase === 'baseline') console.log('PASS: source HEAD captured; local phone-demo ref is absent. Place the authenticated call now.');
        if (phase === 'held') console.log('PASS: real Codex action is held pending; local phone-demo ref is still absent. Approve on the current call, or hang up for a callback.');
        if (phase === 'approved-on-call') console.log('PASS: one-use approval is recorded on the same PIN-authenticated inbound call. No callback was needed.');
        if (phase === 'hangup') console.log('PASS: inbound hangup is recorded before the decision. Answer the PIN callback if it is still pending.');
        if (phase === 'verified') console.log('PASS: PIN-verified approval completed and the local phone-demo ref matches the original source HEAD.');
      } });
    }
  } catch (error) {
    // No raw SQLite/Git errors, commands, paths, prompts or environment values.
    console.error(`FAIL: ${error instanceof PhoneProofError ? error.message : 'Could not observe the local phone approval safely.'}`);
    process.exitCode = 1;
  } finally { observer?.close(); }
}
