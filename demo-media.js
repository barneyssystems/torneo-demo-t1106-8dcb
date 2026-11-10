'use strict';
// Demo sample media (invented links to invented ids). Bundled in the demo build (T-1106); defines the hook the shim calls after seeding the sample day.
// T-1109 (TOR-T1106-06): the samples are inert: no real page behind them, so they never get a link, and every one says it is a sample (ucl-media.js).
(function () {
  const VIDEO = 'https://app.veo.co/matches/demo-torneo-de-prueba-', CLIP = '/videos/demo-resumen.mp4', ALBUM = 'https://www.icloud.com/sharedalbum/#demo';
  window.TosDemoMedia = function (ev, grp) {
    const teams = [...new Set(grp.flatMap((f) => [f.home, f.away]))], who = (f) => ({ teams: f ? [f.home, f.away] : teams });
    // T-1110: the sample highlights are one invented 8-second clip (a drawn pitch, no people) that PLAYS INSIDE the app, like the real ones will.
    ['0:08', '0:08', '0:08', '0:08'].forEach((d, i) => ev('VIDEO_LINKED', { id: 'v' + (i + 1), fixtureId: grp[i].id, people: who(grp[i]), url: CLIP, duration: d }));
    // T-1110-2: the sample albums are invented photos (drawn scenes, no people) with the tournament's watermark burned in by the same code Dad's phone uses; they open INSIDE the app.
    const P = (n) => n.map((x) => '/fotos/demo-' + x + '.jpg');
    [['al1', 'cancha', P(['cancha-amplia', 'balon-penal', 'arco']), grp[0]], ['al2', 'cancha', P(['banderin', 'arco']), grp[1]], ['al3', 'aficion', P(['sillas', 'banderin'])], ['al4', 'equipos', P(['camisetas', 'cancha-amplia'])], ['al5', 'premios', P(['trofeo', 'camisetas'])]]
      .forEach(([id, kind, photos, f]) => ev('ALBUM_LINKED', { id, kind, people: who(f), photos, ...(f ? { fixtureId: f.id } : {}) }));
  };
  window.TosDemoMedia.isSample = (x) => !!x && typeof x.url === 'string' && (x.url.startsWith(VIDEO) || x.url === CLIP || x.url.startsWith(ALBUM)) || (!!x && Array.isArray(x.photos) && x.photos.length > 0 && x.photos.every((u) => /^\/fotos\/demo-[a-z0-9-]+\.jpg$/.test(u)));
})();
