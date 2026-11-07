'use strict';
// Demo sample media (FAKE links to invented ids). Bundled in the demo build (T-1106); defines the hook the shim calls after seeding the sample day.
window.TosDemoMedia = function (ev, grp) {
    ['01:48', '01:32', '02:05', '01:57'].forEach((d, i) => ev('VIDEO_LINKED', { id: 'v' + (i + 1), fixtureId: grp[i].id, people: 'ninguno', url: 'https://app.veo.co/matches/demo-torneo-de-prueba-' + (i + 1) + '/', duration: d }));
    [['al1', 'cancha', 24, grp[0].id], ['al2', 'cancha', 18, grp[1].id], ['al3', 'aficion', 31], ['al4', 'equipos', 9]].forEach(([id, kind, count, fixtureId]) => ev('ALBUM_LINKED', { id, kind, people: 'ninguno', count, url: 'https://www.icloud.com/sharedalbum/#demo' + id, ...(fixtureId ? { fixtureId } : {}) }));
};
