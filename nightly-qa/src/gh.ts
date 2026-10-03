import { execFileSync } from 'node:child_process';

/** The two reads prepare-triage and seed share. Arguments as arrays, never a shell. */

const BIG = { encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };

export function fetchTracker(): unknown {
  return JSON.parse(
    execFileSync(
      'gh',
      [
        'issue', 'list',
        '--label', 'nightly-qa',
        '--state', 'all',
        '--limit', '300',
        '--json', 'number,title,state,labels,body,createdAt,comments',
      ],
      BIG,
    ),
  );
}

export function recentCommits(count: number): string {
  return execFileSync('git', ['log', `-${count}`, '--date=short', '--format=%h %ad %s%n%n%b%n---'], BIG);
}
