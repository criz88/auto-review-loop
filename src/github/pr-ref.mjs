import { fail } from '../errors.mjs';

export function parsePrRef(value, repoFlag) {
  if (!value) fail('--pr is required', 'INVALID_PR');
  const text = String(value).trim();
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)(?:[/?#].*)?$/.exec(text);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]), fullName: `${url[1]}/${url[2]}` };

  const short = /^([^/\s]+)\/([^#\s]+)#([0-9]+)$/.exec(text);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]), fullName: `${short[1]}/${short[2]}` };

  if (/^[0-9]+$/.test(text)) {
    if (!repoFlag) fail('Numeric --pr requires --repo OWNER/REPO', 'INVALID_PR');
    const repo = /^([^/\s]+)\/([^/\s]+)$/.exec(repoFlag);
    if (!repo) fail('--repo must be OWNER/REPO', 'INVALID_PR');
    return { owner: repo[1], repo: repo[2], number: Number(text), fullName: `${repo[1]}/${repo[2]}` };
  }

  fail(`Unsupported PR reference: ${value}`, 'INVALID_PR');
}

export function prKey(pr) {
  return `${pr.fullName}#${pr.number}`;
}
