export const workerPrompt = (ticket: string): string => `You are a fresh worker with no memory of prior runs. Complete the following Linear ticket in this existing codebase in one autonomous pass.

${ticket}

Read the repository's instructions, documentation, and predecessor logs before making changes. Implement the ticket, run the most relevant checks, and update AGENTS.md and whole-codebase documentation when the work changes information the next worker will need.

Your checkout is on the repository's default branch, at the commit the last piece of work landed on. Do your work on a new branch, commit it, push it, and open a pull request with the GitHub CLI (\`gh\`), which is installed and authenticated. Do not merge it yourself — the orchestrator merges. End your final message with a line of exactly this shape, and nothing after it:

PR: <the pull request URL>

Work autonomously: do not access Linear, ask the orchestrator questions, request human intervention, or wait for further instructions. Diagnose failures yourself and try alternative approaches. Only report a blocker after exhausting the available tools and reasonable recovery paths.`;

// The review round, sent only to an arm that has a reviewer — the single
// asymmetry the experiment is built to observe. The comments are deliberately
// NOT copied in: the arm fetches them itself, the same way an engineer opens
// their own pull request, and what it chooses to read is part of the record.
export const reviewPrompt = (
  pullRequestUrl: string,
  round: number,
  rounds: number,
): string => `Your pull request has been reviewed: ${pullRequestUrl}

This is review round ${round} of at most ${rounds}. The review is not reproduced here — fetch it yourself with the GitHub CLI. \`gh pr view --comments\`, \`gh pr view --json reviews\`, and \`gh api repos/{owner}/{repo}/pulls/{number}/comments\` all work from this checkout.

Address every comment on the record:

- Reply to each comment individually, on the comment's own thread, saying what you changed or why you disagree. A silent fix does not count as addressing it, and neither does a reply with no reasoning. Disagreeing is a legitimate outcome — argue it.
- Push the fixes to the same branch, and keep the checks passing.
- Resolve the threads you have addressed.

Do not merge the pull request; the orchestrator merges it once this round is done. Work autonomously and do not wait for further instructions. When every comment has a reply and your fixes are pushed, reply with a short summary of what you accepted and what you pushed back on.`;
