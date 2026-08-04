const API_BASE = 'https://api.github.com';

function headers(ghToken) {
  return {
    Authorization: `Bearer ${ghToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function getAuthenticatedUser(ghToken) {
  const res = await fetch(`${API_BASE}/user`, { headers: headers(ghToken) });
  if (!res.ok) throw new Error(`GitHub auth check failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.login;
}

export async function createRepo(ghToken, name, { private: isPrivate = true } = {}) {
  const res = await fetch(`${API_BASE}/user/repos`, {
    method: 'POST',
    headers: headers(ghToken),
    body: JSON.stringify({ name, private: isPrivate, auto_init: true, description: `ERA Systems client app: ${name}` }),
  });
  if (!res.ok) throw new Error(`GitHub create repo failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { owner: data.owner.login, repo: data.name, htmlUrl: data.html_url, defaultBranch: data.default_branch };
}

export async function fileExists(ghToken, owner, repo, path, branch = 'main') {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: headers(ghToken) });
  return res.ok;
}

export async function putFile(ghToken, owner, repo, path, content, message, branch = 'main') {
  // Need the current file SHA if it already exists (auto_init creates a README on main).
  let sha;
  const existing = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: headers(ghToken) });
  if (existing.ok) sha = (await existing.json()).sha;

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: headers(ghToken),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`GitHub write ${path} failed: ${res.status} ${await res.text()}`);
}

export async function deleteRepo(ghToken, owner, repo) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { method: 'DELETE', headers: headers(ghToken) });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub delete repo failed: ${res.status} ${await res.text()}`);
}
