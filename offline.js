'use strict';
// W2-B-02: the ONLY shape of public data a phone may keep for offline use — no player identities at all (consent can be revoked
// while the phone is offline). Shared by the page and the node tests (UMD-style).
function offlineCopy(data) { return { ...data, scorers: null, videos: [], albums: [], /* R6-01: media is consent-gated and can be revoked while a phone is offline: never cached */ fixtures: (data.fixtures || []).map((f) => (f.goals ? { ...f, goals: f.goals.map((g) => ({ side: g.side, minute: g.minute, label: null })) } : f)) }; }
if (typeof module !== 'undefined') module.exports = { offlineCopy };
