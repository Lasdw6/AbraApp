import { abra } from './abra.js';

export async function chooseInbox(kind, requestedId, from) {
  const inbox = await abra(['inbox']);
  const matching = inbox.filter(item => item.kind === kind && (!from || item.from === from));
  if (requestedId) {
    const exact = matching.find(item => item.id === requestedId);
    if (!exact) throw new Error(`no ${kind} item matches ${requestedId}`);
    return exact;
  }
  const candidates = matching
    .filter(item => !item.read)
    .sort((left, right) => right.received_at.localeCompare(left.received_at));
  if (candidates.length !== 1) {
    const ids = candidates.map(item => item.id).join(', ');
    throw new Error(candidates.length ? `multiple unread ${kind} items match; pass one id: ${ids}` : `no unread ${kind} item found`);
  }
  return candidates[0];
}
