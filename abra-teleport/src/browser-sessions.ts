// Keep the legacy active fields for CLI commands while retaining every imported context.
export function browserSessions(browser) {
  const entries = [...(browser.sessions || []), browser];
  const unique = new Map<string, any>();
  for (const entry of entries) {
    if (!entry.active_receipt || !entry.active_context_id) continue;
    const { sessions, ...session } = entry;
    unique.set(entry.active_context_id, session);
  }
  return [...unique.values()];
}

export function selectBrowserSession(browser, id?: string) {
  if (!id) return browser;
  const session = browserSessions(browser).find(item => item.active_context_id === id);
  if (!session) throw new Error('That browser session is no longer active.');
  return session;
}

export function addBrowserSession(browser, session) {
  const sessions = browserSessions(browser).filter(item => item.active_context_id !== session.active_context_id);
  const { allow_non_portable, active_context_id, active_receipt, chrome_pid, chrome_ws_url, prepared, from,
    received_snapshot_id, received_at, sessions: oldSessions, ...history } = browser;
  return { ...history, ...session, sessions: [...sessions, session] };
}

export function removeBrowserSession(browser, id: string) {
  const sessions = browserSessions(browser).filter(item => item.active_context_id !== id);
  if (browser.active_context_id !== id) return { ...browser, sessions };
  const { allow_non_portable, active_context_id, active_receipt, chrome_pid, chrome_ws_url, prepared, from,
    received_snapshot_id, received_at, sessions: oldSessions, ...history } = browser;
  return { ...history, ...(sessions.at(-1) || {}), ...(sessions.length ? { sessions } : {}) };
}
