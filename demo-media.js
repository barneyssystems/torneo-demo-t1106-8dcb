'use strict';
// Demo sample media (invented links to invented ids). Bundled in the demo build (T-1106); defines the hook the shim calls after seeding the sample day.
// T-1109 (TOR-T1106-06): the samples are inert: no real page behind them, so they never get a link, and every one says it is a sample (ucl-media.js).
(function () {
  const VIDEO = 'https://app.veo.co/matches/demo-torneo-de-prueba-', ALBUM = 'https://www.icloud.com/sharedalbum/#demo';
  window.TosDemoMedia = function (ev, grp) {
    const teams = [...new Set(grp.flatMap((f) => [f.home, f.away]))], who = (f) => ({ teams: f ? [f.home, f.away] : teams });
    ['01:48', '01:32', '02:05', '01:57'].forEach((d, i) => ev('VIDEO_LINKED', { id: 'v' + (i + 1), fixtureId: grp[i].id, people: who(grp[i]), url: VIDEO + (i + 1) + '/', duration: d }));
    [['al1', 'cancha', 24, grp[0]], ['al2', 'cancha', 18, grp[1]], ['al3', 'aficion', 31], ['al4', 'equipos', 9]].forEach(([id, kind, count, f]) => ev('ALBUM_LINKED', { id, kind, people: who(f), count, url: ALBUM + id, ...(f ? { fixtureId: f.id } : {}) }));
  };
  window.TosDemoMedia.isSample = (x) => !!x && typeof x.url === 'string' && (x.url.startsWith(VIDEO) || x.url.startsWith(ALBUM));
})();
