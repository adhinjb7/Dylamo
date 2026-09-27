import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareApprovalRehearsal } from './approval-rehearsal.mjs';

const OLD_HEADING = 'Dylamo demo site';
const NEW_HEADING = 'Hello, Hack Atlantic!';

function page(heading, releaseState) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dylamo release preview</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      color: #f5f8ff; font: 20px system-ui, sans-serif; }
    body.awaiting-approval { background:
      radial-gradient(circle at 85% 15%, rgba(67, 123, 207, .48), transparent 34rem),
      linear-gradient(145deg, #0a1220 0%, #142a4d 100%); }
    body.published { background:
      radial-gradient(circle at 50% -10%, rgba(116, 255, 191, .6), transparent 35rem),
      linear-gradient(145deg, #063f31 0%, #08714e 100%); }
    main { padding: 3rem; text-align: center; border: 1px solid rgba(174, 198, 237, .32);
      border-radius: 1.5rem; background: rgba(4, 12, 27, .2); box-shadow: 0 1.5rem 5rem rgba(0, 0, 0, .18); }
    body.published main { border-color: rgba(190, 255, 220, .72); box-shadow: 0 1.5rem 5rem rgba(0, 25, 16, .42); }
    h1 { font-size: clamp(2.5rem, 7vw, 5rem); margin: 0 0 1rem; }
    p { color: #aebbd4; }
    body.published p { color: #d1f9e1; }
    .release-state { position: fixed; left: 1rem; bottom: 1rem; padding: .5rem .75rem;
      border: 1px solid #5277c1; border-radius: .5rem; background: rgba(6, 16, 34, .55);
      color: #dce7ff; font-size: .8rem; }
    body.published .release-state { border-color: #76f3b3; background: rgba(1, 54, 34, .7); color: #e5fff1; }
  </style>
</head>
<body class="${releaseState}"><main><h1>${heading}</h1><p>A local, disposable release preview.</p></main></body>
</html>
`;
}

// This prepares a visible, pre-committed change in the same disposable fixture
// shape that the exact-action phone push guard accepts. It does not push.
export function prepareHeadlineDemo(parent) {
  const fixture = prepareApprovalRehearsal(parent);
  const siteDirectory = join(fixture.workspace, 'site');
  mkdirSync(siteDirectory);
  const site = join(siteDirectory, 'index.html');
  writeFileSync(site, page(OLD_HEADING, 'awaiting-approval'));
  fixture.git(fixture.workspace, ['add', 'site/index.html']);
  fixture.git(fixture.workspace, ['commit', '-m', 'Add local demo page']);
  const baselineCommit = fixture.git(fixture.workspace, ['rev-parse', 'HEAD']);
  writeFileSync(site, page(NEW_HEADING, 'published'));
  fixture.git(fixture.workspace, ['add', 'site/index.html']);
  fixture.git(fixture.workspace, ['commit', '-m', 'Update demo headline']);
  const preparedCommit = fixture.git(fixture.workspace, ['rev-parse', 'HEAD']);
  if (fixture.git(fixture.workspace, ['status', '--porcelain=v1', '--untracked-files=all']) ||
      fixture.remoteCommit()) throw new Error('The prepared headline fixture is not clean and unpublished.');
  return { ...fixture, site, baselineCommit, preparedCommit };
}

export function headlineDemoPage(fixture) {
  const sourceHead = fixture.git(fixture.workspace, ['rev-parse', 'HEAD']);
  if (sourceHead !== fixture.preparedCommit ||
      fixture.git(fixture.workspace, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('The prepared headline source changed. Stop the preview and inspect the fixture.');
  }
  const publishedCommit = fixture.remoteCommit();
  if (publishedCommit && publishedCommit !== fixture.preparedCommit) {
    throw new Error('The local phone-demo ref changed unexpectedly. Stop the preview and inspect the fixture.');
  }
  const published = publishedCommit === fixture.preparedCommit;
  const commit = published ? publishedCommit : fixture.baselineCommit;
  const html = fixture.git(fixture.workspace, ['show', `${commit}:site/index.html`]);
  const label = published ? 'Published to local phone-demo branch' : 'Before local approval';
  return { html: html.replace('</body>', `<aside class="release-state">${label}</aside></body>`),
    published, commit };
}
