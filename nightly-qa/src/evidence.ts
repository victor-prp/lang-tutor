import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Screenshots on an orphan branch, because the GitHub API has no image upload
 * for issue bodies and a run artifact expires in 14 days.
 *
 * The branch never merges and CI never builds it. At four images a night and
 * roughly 25KB each it costs a few megabytes a year, which buys issues whose
 * evidence is still there when someone finally reads them.
 */

const BRANCH = 'nightly-qa-evidence';

export function pushEvidence(
  runDate: string,
  shotsDir: string,
  apply: boolean,
): Map<string, string> {
  const urls = new Map<string, string>();
  if (!existsSync(shotsDir)) return urls;

  const images = readdirSync(shotsDir).filter((name) => name.endsWith('.png'));
  if (images.length === 0) return urls;

  const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();

  for (const image of images) {
    urls.set(
      `shots/${image}`,
      `https://raw.githubusercontent.com/${repo}/${BRANCH}/${runDate}/${image}`,
    );
  }

  if (!apply) {
    console.log(`  would push ${images.length} screenshots to ${BRANCH}/${runDate}/`);
    return urls;
  }

  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' });

  // A worktree, so the run's own checkout is never switched out from under the
  // rest of the job. --orphan on first use; afterwards the branch already exists.
  const tmp = `${process.env.RUNNER_TEMP ?? '/tmp'}/qa-evidence`;
  const exists = git(['ls-remote', '--heads', 'origin', BRANCH]).trim() !== '';
  if (exists) {
    git(['fetch', 'origin', `${BRANCH}:${BRANCH}`]);
    git(['worktree', 'add', tmp, BRANCH]);
  } else {
    git(['worktree', 'add', '--detach', tmp]);
    execFileSync('git', ['checkout', '--orphan', BRANCH], { cwd: tmp });
    execFileSync('git', ['rm', '-rf', '--cached', '.'], { cwd: tmp });
  }

  execFileSync('mkdir', ['-p', `${tmp}/${runDate}`]);
  for (const image of images) execFileSync('cp', [`${shotsDir}/${image}`, `${tmp}/${runDate}/`]);

  execFileSync('git', ['add', runDate], { cwd: tmp });
  execFileSync('git', ['commit', '-m', `evidence: ${runDate}`], { cwd: tmp });
  execFileSync('git', ['push', 'origin', BRANCH], { cwd: tmp });
  git(['worktree', 'remove', '--force', tmp]);

  return urls;
}
