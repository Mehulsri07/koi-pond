// A repository link is only ever followed or shown as an href when it is a github.com
// https URL (defense in depth: the snapshot is data, not trusted markup). Returns the URL,
// or null for anything else.
export function repoUrl(url) {
  return typeof url === 'string' && /^https:\/\/github\.com\//.test(url) ? url : null;
}
