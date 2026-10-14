// The site's own address. Visitors who arrive at another (the workers.dev
// address, www) go here with the same path: passkeys only work on this one.
// Local development is left alone.
window.ZKADS_HOST = 'zkads.lol';
if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && location.hostname !== window.ZKADS_HOST) {
  location.replace(`https://${window.ZKADS_HOST}${location.pathname}${location.search}${location.hash}`);
}

// The event's code (Paradigm Frontiers), put in the line for an assistant
// and used to join whenever a link carries none. Change or remove it for
// another event.
window.ZKADS_EVENT_CODE = 'ZK-XR9K-AN62';

// Where the API lives. Empty means this site's own origin (the worker serves
// both). For a static host such as GitHub Pages, set the worker's URL here.
window.ZKADS_API = '';
// Optional: the enclave's origin (its Phala URL). When set, summaries are only
// ever sent there, whatever upload address the API hands out (and, pinned or
// not, only into the slot the page means), so a web app hosted apart from the
// worker does not have to trust it with where summaries go.
window.ZKADS_ENCLAVE = '';
