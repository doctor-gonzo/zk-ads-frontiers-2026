// ZKAds web app: the landing page an event's QR code opens (the line for an
// assistant, and a fictional example), log in or create an account with a
// passkey, approve an assistant's sign-in code, make a card from an
// assistant's reply, follow a card while it renders, and fuse cards with
// other people. At an event, a guest account from the event code needs no
// sign-up until it is saved with a passkey. Plain DOM and no build step. It
// talks to the API with bearer tokens, so it works served by the worker or
// from a static host (set window.ZKADS_API in config.js there).
import { SLOP_CANNON } from '/example.js';
import { INTRO_PROMPT } from '/intro-prompt.js';
import { encode } from '/vendor/uqr.mjs';

const API = (window.ZKADS_API || location.origin).replace(/\/+$/, '');
const ENCLAVE = (window.ZKADS_ENCLAVE || '').replace(/\/+$/, '');
const SESSION = 'zkads.session';
const AGENT = 'zkads.agent';
// A guest account started in this browser with an event code: its token, and
// the claim code that saves it with a passkey.
const GUEST = 'zkads.guest';
const CLAIM = 'zkads.claim';
// (In sessionStorage) the code of a claim link opened in this tab.
const LINK = 'zkads.claim-link';
const STEPS = ['queued', 'concept', 'image', 'orbit', 'music', 'page'];
const STEP_LABELS = {
  queued: 'In the queue',
  concept: 'Writing the idea',
  image: 'Drawing the product',
  orbit: 'Filming the 360° orbit',
  music: 'Adding the sound',
  page: 'Setting the pages',
};
const BULLETS = [
  'Your agent compiles a profile based on your AI history (no sensitive data)',
  'Sends this data to a TEE to create a 1/1 product tailored to you (rendered by Venice)',
  'You can merge your AI history with someone else’s for a shared product (only the product card leaves the TEE)',
];
// The landing page's fictional example: a still kept with the app, and its
// orbit published beside the cards (scripts/example.mjs).
const EXAMPLE = { still: '/media/slop-cannon.jpg', orbit: `${API}/example/orbit.mp4` };
// The public source code.
const REPO = 'https://github.com/doctor-gonzo/zk-ads-frontiers-2026';
// Fixed icon markup (no data in it); icon() makes the elements.
const ICONS = {
  copy: '<rect x="8.5" y="8" width="11.5" height="13" rx="1.5"/><path d="M15.5 8V4.5A1.5 1.5 0 0 0 14 3H5.5A1.5 1.5 0 0 0 4 4.5V16a1.5 1.5 0 0 0 1.5 1.5h3"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  caret: '<path d="M6 9.5h12l-6 7z" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  orbit: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20.2 4v4.5h-4.5"/>',
  outward: '<path d="M7 17L17 7M9 7h8v8"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  about: '<circle cx="12" cy="12" r="10.3"/><path d="M9.2 9.4a2.9 2.9 0 1 1 4.1 2.6c-.9.4-1.3 1-1.3 1.9v.5"/><circle cx="12" cy="17.6" r=".55" fill="currentColor"/>',
  soundOff: '<path d="M3.5 9.5h3.5l5-4v13l-5-4H3.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  soundOn: '<path d="M3.5 9.5h3.5l5-4v13l-5-4H3.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>',
};
const view = document.getElementById('view');
const params = new URLSearchParams(location.search);
// This browser's guest account, if any, is checked before the header offers
// to save it: 'checking', then 'ok' or 'none' (see checkGuest).
let guest = 'none';
let uid = 0;

document.getElementById('skill-link').href = `${API}/skill.md`;

const routes = { '/': home, '/join': join, '/signin': signin, '/event': landing, '/about': about, '/claim': claim, '/approve': approve, '/agent': agentSignIn, '/make': () => make(), '/catalogue': catalogue, '/card': cardView, '/invite': invite, '/fuse': fuse, '/match': match, '/sponsor': sponsor };
checkGuest();
addEventListener('storage', (event) => [SESSION, GUEST, CLAIM].includes(event.key) && checkGuest());
// (Some pages draw at once and some wait on the API; errors from either land here.)
Promise.resolve()
  .then(() => (routes[location.pathname.replace(/\/+$/, '') || '/'] ?? notFound)())
  .catch((error) => show(h('h1', {}, 'Something went wrong'), notice(friendly(error))));

// The home page: a signed-in member's cards; for everyone else, a guest
// included, the landing page.
async function home() {
  const token = read(SESSION);
  if (!token) return landing();
  let me;
  try {
    ({ data: me } = await api('/v1/me', { token }));
  } catch (error) {
    if (error.status !== 401) throw error;
    if (read(SESSION) === token) forget(SESSION);
    renderNav();
    return landing();
  }
  const cards = me.cards.length ? h('ul', { class: 'cards' }, me.cards.map((card) => cardRow(card, token))) : h('p', { class: 'muted' }, 'No cards yet. Ask your assistant for one, or make one here.');
  const { data: inbox } = await api('/v1/fusions', { token }).catch(() => ({ data: { fusions: [] } }));
  show(
    h('h1', {}, 'Your cards'),
    // An assistant's sign-in names the account that approved it; this is the one to compare with.
    me.user?.handle ? h('p', { class: 'muted small' }, `Signed in as ${me.user.handle}`) : null,
    me.credits ? h('p', { class: 'muted small' }, `You have earned ${me.credits} play credits from sponsored items.`) : null,
    cards,
    h('div', { class: 'row' }, h('a', { class: 'button primary', href: '/make' }, 'Make a card')),
    fusionPanel(inbox.fusions, token),
    connectPanel(),
    agentsPanel(me.agents ?? [], token),
    signOutRow(),
  );
}

function signOutRow() {
  return h('div', { class: 'account-row' }, signOutButton('secondary'));
}

function signOutButton(className) {
  const out = h('button', { class: className, type: 'button' }, 'Sign out');
  out.addEventListener('click', async () => {
    const token = read(SESSION);
    forget(SESSION);
    forget(AGENT, sessionStorage);
    await api('/v1/auth/logout', { method: 'POST', token }).catch(() => {});
    location.assign('/');
  });
  return out;
}

// The header's account choice for a member: every card they are part of, their
// own and the ones fused with someone, as /v1/me lists them for this sign-in
// only, each opening its card.
async function accountDialog(trigger) {
  const token = read(SESSION);
  const handle = h('p', { class: 'note' });
  const list = h('ul', { class: 'cards account-cards' }, h('li', { class: 'muted' }, 'Loading your cards…'));
  const message = notice();
  modal({ title: 'Your cards', trigger, className: 'account-modal', content: [handle, list, message, h('div', { class: 'modal-actions' }, h('a', { class: 'btn', href: '/' }, 'Cards page'), signOutButton('btn'))] });
  try {
    const { data: me } = await api('/v1/me', { token });
    handle.textContent = me.user?.handle ? `Signed in as ${me.user.handle}` : '';
    list.replaceChildren(
      ...(me.cards.length
        ? me.cards.map((card) =>
            h('li', {}, h('a', { href: card.status === 'ready' ? safe(card.page_url) : `/card?id=${card.id}` }, card.product_name), h('span', { class: `badge ${card.status}` }, card.kind === 'fusion' ? 'shared' : card.status === 'ready' ? '' : card.status === 'rendering' ? 'making' : card.status.replace('_', ' '))),
          )
        : [h('li', { class: 'muted' }, 'No cards yet. Copy the prompt into your assistant to make one.')]),
    );
  } catch (error) {
    list.replaceChildren();
    if (error.status !== 401) return say(message, friendly(error));
    // A sign-in that ended: forgotten (if it is still the stored one), and the header says login.
    if (read(SESSION) === token) forget(SESSION);
    renderNav();
    say(message, 'You were signed out. Log in again to see your cards.');
  }
}

// Requests from the matching pool to answer, fusions waiting on a summary, and shared cards.
function fusionPanel(fusions, token) {
  const open = fusions.filter((f) => f.status !== 'declined');
  if (!open.length) return null;
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Fusions'),
    h(
      'ul',
      { class: 'cards' },
      open.map((fusion) => {
        const other = fusion.direction === 'incoming' ? fusion.from : fusion.to;
        const label = other ? `${other.product_name ?? 'A card'}${other.name ? ` · ${other.name}` : ''}` : 'Invited friend';
        const item = h('li', {}, h('span', {}, label));
        if (fusion.card) item.append(h('a', { href: `/card?id=${fusion.card.id}` }, 'Shared card'));
        else if (fusion.direction === 'incoming' && fusion.status === 'pending') {
          const message = notice();
          const yes = h('button', { class: 'secondary' }, 'Fuse');
          const no = h('button', { class: 'secondary' }, 'No thanks');
          yes.addEventListener('click', busy(yes, message, async () => location.assign(`/card?id=${(await api(`/v1/fusions/${fusion.id}/accept`, { method: 'POST', token })).data.id}`)));
          no.addEventListener('click', busy(no, message, async () => (await api(`/v1/fusions/${fusion.id}/decline`, { method: 'POST', token }), item.remove())));
          item.append(h('span', { class: 'row' }, yes, no), message);
        } else if (fusion.upload_needed) item.append(h('a', { href: `/fuse?fusion=${fusion.id}` }, 'Add your summary'));
        else item.append(h('span', { class: 'badge' }, fusion.status.replace('_', ' ')));
        return item;
      }),
    ),
  );
}

// The assistants this member approved, each revocable.
function agentsPanel(agents, token) {
  if (!agents.length) return null;
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Connected assistants'),
    h(
      'ul',
      { class: 'cards' },
      agents.map((agent) => {
        const message = notice();
        const revoke = h('button', { class: 'secondary' }, 'Revoke');
        const item = h('li', {}, h('span', {}, agent.label, h('span', { class: 'muted small' }, ` · until ${new Date(agent.expires_at).toLocaleDateString()}`)), revoke, message);
        revoke.addEventListener('click', busy(revoke, message, async () => (await api('/v1/agent/revoke', { method: 'POST', token, body: { id: agent.id } }), item.remove())));
        return item;
      }),
    ),
  );
}

// The landing page: the home page signed out, and the page an event's QR
// code opens. The line to give an assistant is built once from the event
// code (the link's, else the event's own from config.js) and the account, and
// the same string is copied and shown. A member's assistant signs in to their
// own account (a code they approve), so only guests get the event code.
async function landing() {
  const raw = params.get('code');
  const code = eventCode();
  const member = Boolean(await live(SESSION));
  const line = member ? `Read ${API}/skill.md and make me a ZKAds card.` : code ? `Read ${API}/skill.md and make me a ZKAds card. Event code: ${code}` : null;
  const missing = raw
    ? 'This link’s event code is not valid. Scan the event’s QR code again.'
    : location.pathname === '/event'
      ? 'This link has no event code in it. Scan the event’s QR code again.'
      : 'Your prompt comes with the event’s link: scan its QR code. Members can log in instead.';
  const example = h('a', { class: 'btn big example-link mobile-only', href: '#example' }, 'Example', icon('down'));
  example.addEventListener('click', (event) => {
    event.preventDefault();
    toExample();
  });
  const actions = copyActions({ label: 'Copy prompt', text: line, missing, title: 'Prompt', beside: example, source: true });
  // A link that should carry an event code but does not says so at once.
  if (!line && (raw !== null || location.pathname === '/event')) say(actions.status, missing);
  show(
    h(
      'div',
      { class: 'landing' },
      h('section', { class: 'intro' }, h('h1', {}, 'For an audience of one.'), h('ul', { class: 'bullets' }, BULLETS.map((text) => h('li', {}, text))), actions.nodes),
      exampleSection(),
    ),
  );
  view.classList.add('wide');
}

// The yellow copy button, with a caret that unfolds "read prompt" beneath it
// (the same text, shown whole). With no `text` there is nothing to copy yet,
// and `missing` says why. `beside` sits at the end of the button's row.
function copyActions({ label, text, missing, title, beside = null, source = false }) {
  const status = notice();
  const id = `read-${++uid}`;
  const copy = h('button', { class: 'btn primary big copy', type: 'button' }, h('span', {}, label), icon('copy'));
  const caret = h('button', { class: 'btn primary big caret', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': 'Show the whole prompt' }, icon('caret'));
  const reader = h('button', { class: 'btn block read', type: 'button' }, 'read prompt');
  const fold = h('div', { class: 'fold', id, hidden: true }, reader);
  const unfold = (open) => {
    fold.hidden = !open;
    caret.setAttribute('aria-expanded', String(open));
  };
  caret.addEventListener('click', () => unfold(fold.hidden));
  copy.addEventListener('click', async () => {
    if (!text) return say(status, missing);
    if (!(await copyText(text, copy, status, 'Copying is blocked in this browser: open “read prompt” below and copy the text from there.'))) unfold(true);
  });
  reader.addEventListener('click', () => (text ? promptDialog({ title, text, trigger: reader, copyLabel: label, after: source && h('p', { class: 'note source' }, 'The code behind this prompt is open: ', h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub', icon('outward'), h('span', { class: 'sr' }, ' (opens in a new tab)')), '.') }) : say(status, missing)));
  return { nodes: [h('div', { class: 'actions' }, h('div', { class: 'split' }, copy, caret), beside), fold, status], status };
}

// The fictional Slop Cannon as a story card to click through, like a real
// one: its 360° orbit with the name set over it, turning by itself (muted,
// and still with reduced motion), then the product, You, Why, Catalogue and
// Fuse. Its buttons lead back to the prompt, to make one's own. Nothing here
// starts a job or an account.
function exampleSection() {
  const c = SLOP_CANNON;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const status = notice();
  // Loaded once the card comes near the screen; the still shows until then.
  const video = h('video', { poster: EXAMPLE.still, muted: true, loop: true, playsinline: true, preload: 'none', 'aria-label': 'The Slop Cannon, turning in a 360° orbit' });
  video.muted = true;
  video.addEventListener('error', () => say(status, 'The 360° orbit could not play here, so the still stays.'));
  let near = false;
  const play = () => {
    near = true;
    if (!video.getAttribute('src')) video.src = EXAMPLE.orbit;
    video.play().catch(() => {});
  };
  const toPrompt = (label, primary = false) => {
    const button = h('button', { class: `chip${primary ? ' primary' : ''}`, type: 'button' }, label);
    button.addEventListener('click', () => {
      const copy = document.querySelector('.intro .copy');
      copy?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      copy?.focus({ preventScroll: true });
    });
    return button;
  };
  const page = (label, ...blocks) => h('div', { class: 'face sheet' }, h('p', { class: 'label' }, label), ...blocks);
  const faces = [
    // The front, as on a real card: the era and the name over the orbit.
    h(
      'div',
      { class: 'face front' },
      video,
      h('div', { class: 'overlay' }, h('p', { class: 'era' }, c.era.replace(/,\s+/g, ' · ')), h('h2', { id: 'example-title', tabindex: '-1' }, c.product_name)),
      h('p', { class: 'mark', 'aria-hidden': 'true' }, 'ZK', h('span', {}, 'ADS')),
    ),
    page(
      'The product',
      h('div', {}, h('p', { class: 'title' }, c.tagline), h('p', { class: 'reading' }, 'Turns a rough idea into a volley of prototypes. Tuned to your tools, guided by your taste.')),
      h('div', { class: 'facts' }, h('span', {}, '1/1 custom build'), h('span', {}, 'Draft → test → refine')),
    ),
    page(
      'You, decoded',
      h('div', {}, h('p', { class: 'title' }, c.archetype), h('p', { class: 'reading' }, c.reading)),
      h('div', { class: 'tile stat' }, h('b', {}, c.stat_value), h('span', {}, c.stat_label)),
      h('div', { class: 'tile' }, h('p', { class: 'label' }, 'Deepest rabbit hole'), h('p', { class: 'big' }, c.rabbit_hole)),
      h('div', {}, h('p', { class: 'label' }, `In ${c.era}, you’d have been`), h('p', { class: 'era' }, c.era_match)),
    ),
    page(
      'Why it’s yours',
      h('ol', { class: 'reasons' }, c.reasons.map((reason, i) => h('li', {}, h('span', { class: 'n' }, String(i + 1)), h('div', {}, h('p', { class: 'trait' }, reason.you), h('p', { class: 'so' }, `→ so ${reason.so}`))))),
      h('div', {}, h('p', { class: 'label' }, 'Drawn after'), h('p', { class: 'artist' }, c.artist), h('p', { class: 'because' }, c.artist_reason)),
    ),
    page('Also made for you', c.catalogue.map((item) => h('div', { class: 'item' }, h('p', { class: 'label' }, item.era), h('p', { class: 'item-name' }, item.name), h('p', { class: 'teaser' }, item.teaser), toPrompt('Make this one')))),
    page(
      'Make one together',
      h('div', {}, h('p', { class: 'title' }, 'Two ways of thinking. One custom invention.'), h('p', { class: 'reading' }, 'Invite a friend. Make a shared 1/1.')),
      h('div', { class: 'choices' }, toPrompt('Invite a friend', true), toPrompt('Find a match')),
      h('p', { class: 'small' }, 'On your own card these work; here they lead to the prompt.'),
    ),
  ];
  const stops = faces.map(() => h('i'));
  const counter = h('span', {});
  const arrow = (direction, label) => {
    const holder = document.createElement('template');
    holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${direction === 'prev' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`;
    return h('button', { class: `story-nav ${direction}`, type: 'button', 'aria-label': label }, holder.content.firstElementChild);
  };
  const prev = arrow('prev', 'Previous page');
  const next = arrow('next', 'Next page');
  const card = h('div', { class: 'story', tabindex: '0', role: 'group', 'aria-roledescription': 'story card', 'aria-label': 'The Slop Cannon, a fictional example. Press the right arrow for the next page.' }, faces, prev, next);
  const sound = h('button', { class: 'sound', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Turn sound on' }, icon('soundOff'));
  let at = 0;
  const show = (to) => {
    at = (to + faces.length) % faces.length;
    // Focus on a button of the page being left (or a back arrow about to hide) goes back to the card.
    const focused = document.activeElement;
    if (card.contains(focused) && !(focused === card || focused === next || (focused === prev && at > 0))) card.focus({ preventScroll: true });
    faces.forEach((face, i) => {
      face.classList.toggle('on', i === at);
      // (A page fading out takes no taps or focus.)
      face.inert = i !== at;
    });
    stops.forEach((stop, i) => stop.classList.toggle('on', i <= at));
    counter.textContent = `${String(at + 1).padStart(2, '0')} / ${String(faces.length).padStart(2, '0')}`;
    prev.hidden = at === 0;
    // The orbit turns only while it shows (with reduced motion, only once the sound is asked for).
    if (at === 0 && near && (!still || !video.muted)) play();
    else video.pause();
  };
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, a')) return;
    const box = card.getBoundingClientRect();
    show(at + (at > 0 && event.clientX - box.left < box.width * 0.3 ? -1 : 1));
  });
  card.addEventListener('keydown', (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.target.closest('button, a') && (event.key === 'Enter' || event.key === ' ')) return;
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') (event.preventDefault(), show(at + 1));
    if (event.key === 'ArrowLeft') (event.preventDefault(), show(at - 1));
  });
  prev.addEventListener('click', () => show(at - 1));
  next.addEventListener('click', () => show(at + 1));
  // The sound icon: on, it plays the orbit with its soundtrack (and turns back to it).
  sound.addEventListener('click', () => {
    near = true;
    video.muted = !video.muted;
    sound.setAttribute('aria-pressed', String(!video.muted));
    sound.setAttribute('aria-label', video.muted ? 'Turn sound on' : 'Turn sound off');
    sound.replaceChildren(icon(video.muted ? 'soundOff' : 'soundOn'));
    if (!video.muted) show(0);
    else if (still) video.pause();
  });
  show(0);
  // It starts turning once it comes near the screen (with reduced motion, it waits for the sound).
  if (!still) {
    if ('IntersectionObserver' in window) {
      const watch = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && (watch.disconnect(), (near = true), at === 0 && play()), { rootMargin: '300px' });
      watch.observe(card);
    } else play();
  }
  const section = h(
    'section',
    { class: 'example', id: 'example', 'aria-labelledby': 'example-title' },
    h('div', { class: 'example-head' }, h('p', { class: 'eyebrow' }, 'Example / Slop Cannon'), sound),
    h('div', { class: 'story-count', 'aria-hidden': 'true' }, counter, h('span', { class: 'bars' }, stops)),
    card,
    status,
  );
  // (The Example button turns the card back to its front before landing on its name.)
  section.toFront = () => show(0);
  return section;
}

// The mobile Example button: to the example's card, on this page, landing
// on its name.
function toExample() {
  const section = document.getElementById('example');
  section.toFront?.();
  section.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  document.getElementById('example-title').focus({ preventScroll: true });
}

function join() {
  show(h('h1', {}, 'Join ZKAds'), h('p', { class: 'lead' }, 'Your invite code unlocks an account protected by a passkey: your device’s fingerprint, face or PIN. There is no password and no email.'), joinPanel(params.get('code') ?? ''));
}

function signin() {
  show(h('h1', {}, 'Sign in'), h('p', { class: 'lead' }, 'Use the passkey you made when you joined.'), signInButton(), h('p', { class: 'muted small' }, 'New here? ', h('a', { href: withNext('/join') }, 'Join with an invite'), '.'));
}

function joinPanel(code) {
  const input = h('input', { id: 'invite', value: code, placeholder: 'ZK-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Create my passkey');
  const message = notice();
  const form = h('form', { class: 'panel' }, h('h2', {}, 'Have an invite?'), field('Invite code', input), h('div', { class: 'row' }, button), message);
  form.addEventListener(
    'submit',
    busy(button, message, async () => {
      const { data } = await api('/v1/auth/register/options', { method: 'POST', body: { invite: input.value } });
      const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: data.options });
      const { data: done } = await api('/v1/auth/register/verify', { method: 'POST', body: { ceremony: data.ceremony, response } });
      write(SESSION, done.session);
      location.assign(nextPath());
    }),
  );
  return form;
}

// Saves a guest account with a passkey: from the claim link an assistant
// gave its person, or this browser's own guest account.
async function claim() {
  // A claim link's code leaves the address bar (and history) at once; this
  // tab keeps it, for a reload, until it is used. Without a link, this
  // browser's own guest account is the one to save.
  const linked = location.hash.slice(1);
  if (linked) {
    write(LINK, linked, sessionStorage);
    history.replaceState(null, '', '/claim?link');
  }
  addEventListener('hashchange', () => location.reload());
  const fromLink = Boolean(linked) || params.has('link');
  const code = fromLink ? linked || read(LINK, sessionStorage) : read(CLAIM);
  if (!code) return show(h('h1', {}, 'Save your cards'), notice('There is no guest account to save here. Open the link your assistant gave you with your card.'), h('a', { href: '/' }, 'Back to ZKAds'));
  const button = h('button', { class: 'primary' }, 'Create my passkey');
  const message = notice();
  button.addEventListener(
    'click',
    busy(button, message, async () => {
      await claimAccount(code);
      location.replace(nextPath());
    }),
  );
  show(
    h('h1', {}, 'Save your cards'),
    h('p', { class: 'lead' }, 'Create a passkey for your ZKAds account: your device’s fingerprint, face or PIN. There is no password and no email. Your cards stay yours, and you can fuse them with other people’s.'),
    read(SESSION) && notice('You are signed in to another ZKAds account in this browser. Saving this one switches this browser to it.'),
    fromLink && read(CLAIM) && read(CLAIM) !== code && notice('This link saves a different guest account from the one in this browser, whose cards stay here unsaved.'),
    h('div', { class: 'row' }, button),
    message,
    h('p', { class: 'muted small' }, 'If it says the account was already saved and that was not you, someone else opened this link first: start again with the event code.'),
  );
}

// Saves the guest account behind claim code `code` with a new passkey: the
// same account and its cards, never a new one. A link that is used up or
// unknown is forgotten.
async function claimAccount(code) {
  const { data } = await api('/v1/auth/claim/options', { method: 'POST', body: { claim: code } }).catch((error) => {
    if (error.code === 'bad_claim') {
      // The link, or this browser's own guest account, can no longer be saved.
      if (code === read(LINK, sessionStorage)) forget(LINK, sessionStorage);
      if (code === read(CLAIM)) [GUEST, CLAIM].forEach((key) => forget(key));
      renderNav();
    }
    throw error;
  });
  const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: data.options });
  const { data: done } = await api('/v1/auth/claim/verify', { method: 'POST', body: { ceremony: data.ceremony, response } });
  write(SESSION, done.session);
  forget(LINK, sessionStorage);
  // Saving ended the account's guest sign-ins, this browser's own among them.
  if (code === read(CLAIM)) [GUEST, CLAIM].forEach((key) => forget(key));
}

// For a guest account (from an event code): save it with a passkey.
function savePanel() {
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Save your cards'),
    h('p', {}, 'You are a guest in this browser. Save your cards with a passkey (your device’s fingerprint, face or PIN; no password or email) to keep them and to fuse them with other people’s.'),
    h('div', { class: 'row' }, h('a', { class: 'button primary', href: withNext('/claim') }, 'Save with a passkey')),
    h('p', { class: 'muted small' }, 'Already a member? ', h('a', { href: withNext('/signin') }, 'Sign in'), ' (these guest cards stay out of your account).'),
  );
}

// What a page that needs a passkey shows without one.
function needPasskey() {
  return read(GUEST) ? savePanel() : signInButton();
}

function signInButton() {
  const button = h('button', { class: 'primary' }, 'Sign in with a passkey');
  const message = notice();
  button.addEventListener(
    'click',
    busy(button, message, async () => {
      const { data } = await api('/v1/auth/login/options', { method: 'POST', body: {} });
      const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options });
      const { data: done } = await api('/v1/auth/login/verify', { method: 'POST', body: { ceremony: data.ceremony, response } });
      write(SESSION, done.session);
      location.assign(nextPath());
    }),
  );
  return h('div', {}, h('div', { class: 'row' }, button), message);
}

function connectPanel() {
  const input = h('input', { id: 'approve-code', placeholder: 'ABCD-EFGH', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', {}, 'Use your assistant'),
    h('p', {}, 'Ask Claude Code, Hermes, Muse or any assistant that can open links:'),
    h('pre', { class: 'say' }, `Read ${API}/skill.md and make me a ZKAds card.`),
    h('p', { class: 'muted small' }, 'It will show you a sign-in code. Approve it here:'),
    field('Sign-in code', input),
    h('div', { class: 'row' }, h('button', { class: 'secondary', type: 'submit' }, 'Approve')),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    location.assign(`/approve?code=${encodeURIComponent(userCode(input.value))}`);
  });
  return form;
}

// The person approves (or declines) the code their own assistant showed them.
async function approve() {
  const code = userCode(params.get('code') ?? '');
  const token = read(SESSION);
  if (!token && read(GUEST)) return show(h('h1', {}, 'Approve your assistant'), savePanel());
  if (!token) {
    return show(
      h('h1', {}, 'Approve your assistant'),
      h('p', { class: 'lead' }, 'Sign in first.'),
      signInButton(),
      h('p', { class: 'muted small' }, 'New here? ', h('a', { href: withNext('/join') }, 'Join with an invite'), '.'),
    );
  }
  if (!/^[A-Z]{4}-[A-Z]{4}$/.test(code)) return show(h('h1', {}, 'Approve your assistant'), connectPanel());
  let info;
  try {
    ({ data: info } = await api(`/v1/agent/device/${code}`, { token }));
  } catch (error) {
    return show(h('h1', {}, 'Approve your assistant'), notice(friendly(error)), h('a', { href: '/' }, 'Your cards'));
  }
  const yes = h('button', { class: 'primary' }, 'Approve');
  const no = h('button', { class: 'secondary' }, 'Decline');
  const message = notice();
  const decide = (approved) =>
    busy(approved ? yes : no, message, async () => {
      await api('/v1/agent/approve', { method: 'POST', token, body: { user_code: code, approve: approved } });
      // A reload must not look up the code again (it would warn that someone else used it).
      history.replaceState(null, '', '/approve');
      show(
        h('h1', {}, approved ? 'Approved' : 'Declined'),
        h('p', { class: 'lead' }, approved ? `“${info.agent_name}” can now make cards for you. Go back to it; it carries on by itself, and tells you which account approved it: that should be ${info.account ?? 'yours'}.` : 'Nothing was shared. You can close this page.'),
        h('a', { href: '/' }, 'Your cards'),
      );
    });
  yes.addEventListener('click', decide(true));
  no.addEventListener('click', decide(false));
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(info.asked_at)) / 60_000));
  show(
    h('h1', {}, 'Approve your assistant?'),
    h('p', { class: 'lead' }, `“${info.agent_name}” wants to act for you on ZKAds.`),
    h('div', { class: 'code' }, code),
    h('p', { class: 'muted small' }, `Asked ${minutes ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : 'just now'} · you are signed in as ${info.account ?? 'this account'}`),
    h(
      'p',
      { class: 'muted' },
      'For 30 days it can make and list your cards, add badges and sponsored items to them, open them to matching with a summary it writes, list partners and fusion requests, decline requests, and make fusion invites. Asking for, accepting and joining fusions still needs you, signed in here with your passkey. It never gets your passkey, and you can revoke it from your cards page. Only approve a code your own assistant showed you just now; if someone else gave you this link, decline.',
    ),
    h('div', { class: 'row' }, yes, no),
    message,
  );
}

// For assistants that drive a browser (Muse, for one): sign in with a code
// the person approves, then paste the concept.
async function agentSignIn() {
  const existing = read(AGENT, sessionStorage);
  // A sign-in that was revoked or ran out is dropped, so a new code can be had here.
  if (existing && (await api('/v1/me', { token: existing }).then(() => true, (error) => error.status !== 401))) return make(existing);
  forget(AGENT, sessionStorage);
  const name = h('input', { id: 'agent-name', value: 'My assistant', maxlength: '40' });
  const start = h('button', { class: 'primary' }, 'Get a sign-in code');
  const message = notice();
  start.addEventListener(
    'click',
    busy(start, message, async () => {
      const { data } = await api('/v1/agent/device', { method: 'POST', body: { agent_name: name.value } });
      awaitApproval(data);
    }),
  );
  show(
    h('h1', {}, 'Sign in as an assistant'),
    h('p', { class: 'lead' }, 'For AI assistants that use a browser. Get a code, ask your person to approve it, then paste the card concept.'),
    field('Your name, as your person will see it', name),
    h('div', { class: 'row' }, start),
    message,
  );
}

function awaitApproval(device) {
  const status = h('p', { class: 'muted' }, 'Waiting for approval…');
  show(
    h('h1', {}, 'Ask your person to approve'),
    h('p', {}, 'Ask them to open this link, sign in and approve the code:'),
    h('p', {}, h('a', { href: safe(device.verify_url) }, device.verify_url)),
    h('div', { class: 'code' }, device.user_code),
    status,
  );
  const poll = async () => {
    try {
      const { status: code, data } = await api('/v1/agent/token', { method: 'POST', body: { device_code: device.device_code } });
      if (code === 202) return setTimeout(poll, (device.interval ?? 5) * 1000);
      confirmApprover(data);
    } catch (error) {
      status.replaceWith(notice(friendly(error)));
    }
  };
  setTimeout(poll, (device.interval ?? 5) * 1000);
}

// Anyone who saw the code could have approved it first, so the person checks
// which account did before this sign-in is kept or used.
function confirmApprover(data) {
  const yes = h('button', { class: 'primary' }, 'Yes, that is my account');
  const no = h('button', { class: 'secondary' }, 'No');
  const message = notice();
  yes.addEventListener('click', () => {
    no.disabled = true;
    write(AGENT, data.token, sessionStorage);
    make(data.token);
  });
  no.addEventListener(
    'click',
    busy(no, message, async () => {
      yes.disabled = true;
      forget(AGENT, sessionStorage);
      const cancelled = await api('/v1/auth/logout', { method: 'POST', token: data.token }).then(() => true, () => false);
      const outcome = cancelled ? 'this sign-in was thrown away' : 'this sign-in was not kept (ZKAds could not be reached to cancel it, but nothing here will use it)';
      show(h('h1', {}, 'Signed out'), h('p', { class: 'lead' }, `Someone else approved that code, so ${outcome}, and nothing was sent. Start again with a new code, and keep it off shared screens.`), h('a', { class: 'button primary', href: '/agent' }, 'Get a new code'));
    }),
  );
  show(
    h('h1', {}, 'Check who approved'),
    h('p', { class: 'lead' }, data.approved_by ? `Approved by ${data.approved_by}. Ask your person: is that exactly the handle under “Signed in as” on their cards page?` : 'Approved by an account without a handle, so it cannot be checked. Choose No and start again.'),
    h('div', { class: 'row' }, data.approved_by ? yes : null, no),
    message,
  );
}

async function make(agentToken) {
  // (This tab's assistant sign-in comes before a guest account left in the browser.)
  let token = agentToken ?? read(SESSION) ?? read(AGENT, sessionStorage) ?? read(GUEST);
  // With an event code (the link skill.md gives chat apps), a stale sign-in is
  // dropped so this browser can start a fresh guest account instead.
  const code = agentToken ? null : inviteCodeOf(params.get('code') ?? '');
  if (code) token = (await live(SESSION)) ?? read(AGENT, sessionStorage) ?? (await live(GUEST));
  if (!token && code) return startGuest(code);
  if (!token) {
    return show(h('h1', {}, 'Make a card'), h('p', {}, 'Sign in first. Assistants using a browser can ', h('a', { href: '/agent' }, 'sign in as an assistant'), '.'), signInButton());
  }
  const reply = h('textarea', { id: 'reply', placeholder: 'Paste the whole reply here', spellcheck: 'false' });
  const name = h('input', { id: 'name', maxlength: '40', placeholder: 'Optional' });
  const submit = h('button', { class: 'primary' }, 'Make my card');
  const copyPrompt = h('button', { class: 'secondary' }, 'Copy the prompt');
  const message = notice();
  copyPrompt.addEventListener(
    'click',
    busy(copyPrompt, message, async () => {
      const res = await fetch(`${API}/v1/prompt`);
      if (!res.ok) throw new Error('Could not load the prompt.');
      await navigator.clipboard.writeText(await res.text());
      say(message, 'Prompt copied. Paste it into your assistant, then paste its whole reply here.', true);
    }),
  );
  submit.addEventListener(
    'click',
    busy(submit, message, async () => {
      const text = reply.value.trim();
      if (!text) throw new Error('Paste your assistant’s reply first.');
      // The whole reply works; ZKAds finds its JSON block. Plain JSON works too.
      let concept = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) concept = parsed.concept ?? parsed;
      } catch {
        // Not bare JSON: send the reply as text.
      }
      const { data } = await api('/v1/cards', { method: 'POST', token, body: { concept, name: name.value.trim() || undefined } });
      location.assign(`/card?id=${data.id}`);
    }),
  );
  show(
    h('h1', {}, 'Make a card'),
    h('ol', { class: 'steps' }, h('li', {}, 'Copy the prompt and paste it into your assistant (Claude, ChatGPT…).'), h('li', {}, 'Paste its whole reply below. Only the card concept is kept.')),
    h('div', { class: 'row' }, copyPrompt),
    field('Your assistant’s reply', reply),
    field('Name on the card', name),
    h('div', { class: 'row' }, submit),
    message,
    summaryPanel(token, name),
  );
}

// For a chat app that cannot make web requests: this browser starts the
// guest account from the event code (only when asked), then takes the reply.
function startGuest(code) {
  const start = h('button', { class: 'primary', type: 'button' }, 'Start with the event code');
  const message = notice();
  start.addEventListener(
    'click',
    busy(start, message, async () => {
      // A guest account kept nowhere could never be saved, so none is started.
      if (!storageWorks()) throw new Error('This browser is not keeping anything (a private window?), so a guest account started here could not be saved later. Open this page in a normal browser window.');
      const { data } = await api('/v1/agent/guest', { method: 'POST', body: { code, agent_name: 'ZKAds web app' } });
      write(GUEST, data.token);
      write(CLAIM, new URL(data.claim_url).hash.slice(1));
      guest = 'ok';
      renderNav();
      history.replaceState(null, '', '/make');
      await make(data.token);
    }),
  );
  show(
    h('h1', {}, 'Make a card'),
    h('p', { class: 'lead' }, 'For a chat app that cannot open links itself: start a guest account here with the event code, copy the prompt into your chat app, then paste its whole reply here.'),
    h('div', { class: 'row' }, start),
    message,
  );
}

// The fallback: the assistant only summarises, and the enclave writes the
// concept. Given a waiting card's id, it finishes that card instead of
// starting one.
function summaryPanel(token, name, waitingId = null) {
  const summary = h('textarea', { id: 'draft-summary', placeholder: 'Paste the summary here', spellcheck: 'false' });
  const copyPrompt = h('button', { class: 'secondary' }, 'Copy the summary prompt');
  const submit = h('button', { class: 'secondary' }, 'Seal it and make my card');
  const message = notice();
  copyPrompt.addEventListener(
    'click',
    busy(copyPrompt, message, async () => {
      const res = await fetch(`${API}/v1/summary-prompt`);
      await navigator.clipboard.writeText(await res.text());
      say(message, 'Prompt copied. Paste it into your assistant, then paste its summary here.', true);
    }),
  );
  // A retry reuses the waiting card with a fresh upload link, never a new card.
  let draftId = waitingId;
  submit.addEventListener(
    'click',
    busy(submit, message, async () => {
      if (summary.value.trim().length < 40) throw new Error('Paste the summary your assistant wrote first.');
      const { upload } = draftId
        ? (await api(`/v1/cards/${draftId}/upload`, { method: 'POST', token })).data
        : await api('/v1/cards/from-summary', { method: 'POST', token, body: { name: name?.value.trim() || undefined } }).then(({ data }) => ((draftId = data.id), data));
      // Straight to the enclave: the ZKAds worker never sees the summary.
      const sealed = await seal(upload, `draft:${draftId}`, summary.value);
      if (!sealed.ok) throw new Error((await sealed.json().catch(() => ({}))).error?.message ?? 'The enclave did not accept the summary.');
      await api(`/v1/cards/${draftId}/start`, { method: 'POST', token });
      location.assign(`/card?id=${draftId}`);
    }),
  );
  if (waitingId) {
    return h(
      'section',
      { class: 'panel' },
      h('p', { class: 'muted' }, 'Nothing is being made yet: this card is written from a short private summary that your assistant writes. Paste it here and it goes straight into the ZKAds enclave, which writes the card from it and then deletes it. A waiting card lasts a day.'),
      h('div', { class: 'row' }, copyPrompt),
      field('Your assistant’s summary', summary),
      h('div', { class: 'row' }, submit),
      message,
    );
  }
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Or let the enclave write it'),
    h('p', { class: 'muted' }, 'If your assistant cannot do the whole creative step, it can write a short private summary of you instead. The summary goes straight into the ZKAds enclave, which writes your card from it and then deletes it (or deletes it within 24 hours if the card is never started).'),
    h('div', { class: 'row' }, copyPrompt),
    field('Your assistant’s summary', summary),
    h('div', { class: 'row' }, submit),
    message,
  );
}

// "Make this one" on a card's catalogue page: for the card's owner, that
// item's card is made at once, for the same account, and followed here.
// (Asking again just finds the same card, so a reload makes nothing new.)
async function catalogue() {
  const id = idFrom(params.get('card'));
  const item = params.get('item');
  if (!id || !['0', '1'].includes(item)) return notFound();
  const [key, storage] = read(SESSION) ? [SESSION, localStorage] : read(AGENT, sessionStorage) ? [AGENT, sessionStorage] : [GUEST, localStorage];
  const token = read(key, storage);
  const whose = h('p', { class: 'lead' }, 'Only the card’s owner can make its catalogue items. If it is yours, sign in, or save your account with the link your assistant gave you, or ask your assistant to make it.');
  if (!token) return show(h('h1', {}, 'Make this one'), whose, signInButton());
  show(h('h1', {}, 'Making it…'));
  try {
    const { data } = await api(`/v1/cards/${id}/catalogue/${item}`, { method: 'POST', token });
    location.replace(`/card?id=${data.id}`);
  } catch (error) {
    if (![401, 404].includes(error.status)) throw error;
    // A sign-in that ran out is forgotten.
    if (error.status === 401) {
      if (read(key, storage) === token) {
        forget(key, storage);
        if (key === GUEST) forget(CLAIM);
      }
      renderNav();
    }
    show(h('h1', {}, 'Make this one'), notice(friendly(error)), whose, signInButton());
  }
}

async function cardView() {
  const id = params.get('id') ?? '';
  if (!/^[a-z2-7]{20}$/.test(id)) return notFound();
  const eyebrow = h('p', { class: 'eyebrow' }, 'Making your card');
  const title = h('h1', {}, 'Something custom is taking shape');
  // The latest status, for the help beside each stage (which software does it, for this card).
  let card = null;
  const list = h(
    'ol',
    { class: 'stages' },
    STEPS.map((step) =>
      h('li', { class: 'stage', 'data-step': step, hidden: step === 'concept' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', { class: 'sr' }), h('span', { class: 'label' }, STEP_LABELS[step]), help(`Software used for: ${STEP_LABELS[step].toLowerCase()}`, () => stageSoftware(step, card))),
    ),
  );
  const extra = h('div', {}, h('p', { class: 'muted' }, 'Usually 2–6 minutes. You can leave and come back.'));
  show(h('div', { class: 'making' }, eyebrow, title, list, extra));
  const tick = async () => {
    try {
      ({ data: card } = await api(`/v1/cards/${id}`));
    } catch (error) {
      return extra.replaceChildren(notice(friendly(error)));
    }
    // Only a fused card (or one written from a summary) has a concept step.
    list.querySelector('[data-step="concept"]').hidden = card.kind !== 'fusion' && card.step !== 'concept';
    const at = STEPS.indexOf(card.status === 'queued' ? 'queued' : card.step);
    [...list.children].forEach((item, i) => {
      const state = card.status === 'ready' || i < at ? 'done' : i === at ? 'now' : '';
      item.className = `stage ${state}`;
      item.querySelector('.mark').replaceChildren(...(state === 'done' ? [icon('check')] : []));
      item.querySelector('.sr').textContent = state === 'done' ? 'Done: ' : state === 'now' ? 'Now: ' : 'Next: ';
      if (state === 'now') item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    if (card.status === 'ready') {
      eyebrow.textContent = 'Your card';
      title.textContent = card.product_name;
      list.hidden = true;
      return extra.replaceChildren(...[readyCard(card), !read(SESSION) && read(GUEST) && savePanel()].filter(Boolean));
    }
    if (card.status === 'failed') {
      title.textContent = 'This card could not be made';
      return extra.replaceChildren(notice(card.error || 'Rendering failed.'));
    }
    if (card.status === 'waiting_summary') {
      title.textContent = 'Waiting for your summary';
      list.hidden = true;
      const token = read(SESSION) ?? read(AGENT, sessionStorage) ?? read(GUEST);
      return extra.replaceChildren(token ? summaryPanel(token, null, id) : signInButton());
    }
    setTimeout(tick, 4000);
  };
  tick();
}

function readyCard(card) {
  const share = navigator.share && h('button', { class: 'secondary' }, 'Share');
  share?.addEventListener('click', () => navigator.share({ title: card.product_name, url: card.page_url }).catch(() => {}));
  return h(
    'div',
    {},
    card.update_error && notice(`The last change to this card did not go through, so it is as it was. ${card.update_error}`),
    safe(card.poster_url) && h('a', { href: safe(card.page_url) }, h('img', { class: 'poster', src: safe(card.poster_url), alt: card.product_name })),
    h('div', { class: 'row' }, h('a', { class: 'button primary', href: safe(card.page_url) }, 'Open the card'), safe(card.video_url) && h('a', { class: 'button', href: safe(card.video_url), download: '' }, 'Download the video'), share),
  );
}

function cardRow(card, token) {
  const message = notice();
  let actions;
  if (card.status === 'ready') {
    actions = h('span', { class: 'row small' }, h('a', { href: `/invite?card=${card.id}` }, 'Fuse with someone'), h('a', { href: `/match?card=${card.id}` }, card.matching?.open ? 'Partners' : 'Find partners'));
    if (token && card.badge?.source !== 'zktls') {
      const prove = h('button', { class: 'secondary' }, 'Prove Codex usage');
      prove.addEventListener(
        'click',
        busy(prove, message, async () => {
          const { data } = await api(`/v1/cards/${card.id}/proofs/codex`, { method: 'POST', token });
          window.open(data.request_url, '_blank', 'noopener');
          say(message, 'A secure browser opened: sign in to ChatGPT there and it proves your Codex usage. This page updates when the proof arrives.', true);
          for (const deadline = Date.now() + 30 * 60_000; Date.now() < deadline; ) {
            await new Promise((resolve) => setTimeout(resolve, 4000));
            const { data: status } = await api(`/v1/proofs/${data.session}`, { token });
            if (status.status === 'verified') return location.assign(`/card?id=${card.id}`);
            if (status.status === 'failed') throw new Error(status.error || 'The proof did not verify.');
          }
          throw new Error('No proof arrived within 30 minutes. Try again when you are ready to sign in.');
        }),
      );
      actions.append(prove);
    }
    if (card.sponsored) actions.append(h('span', { class: 'badge ready' }, `sponsored · ${card.sponsored.brand}`));
    else if (token) {
      const bid = h('button', { class: 'secondary' }, 'Let brands bid');
      bid.addEventListener(
        'click',
        busy(bid, message, async () => {
          const { data } = await api(`/v1/cards/${card.id}/sponsor`, { method: 'POST', token });
          if (!data.sponsored) return say(message, data.message, true);
          say(message, `${data.sponsored.brand} won the slot. You earned ${data.sponsored.credits} credits; the card is being updated.`, true);
          setTimeout(() => location.assign(`/card?id=${card.id}`), 2500);
        }),
      );
      actions.append(bid);
    }
  } else {
    actions = h('span', { class: `badge ${card.status}` }, card.status === 'rendering' ? 'making' : card.status.replace('_', ' '));
  }
  const row = h('li', {}, h('a', { href: card.status === 'ready' ? safe(card.page_url) : `/card?id=${card.id}` }, card.product_name), actions, message);
  // Deleting is for good: the page, the video and the enclave's copy go, and the link stops working.
  if (token) {
    const drop = h('button', { class: 'secondary' }, 'Delete');
    drop.addEventListener(
      'click',
      busy(drop, message, async () => {
        if (!confirm(`Delete “${card.product_name}” for good? Its page and video go, and its link stops working.`)) return;
        await api(`/v1/cards/${card.id}/delete`, { method: 'POST', token });
        row.remove();
      }),
    );
    row.insertBefore(drop, message);
  }
  return row;
}

// For brands: the roster that can win slots, and a form to enter one with
// play credits (an admin approves each entry before it can win).
async function sponsor() {
  const { data } = await api('/v1/brands');
  const token = read(SESSION);
  const fields = {
    name: h('input', { id: 'brand-name', maxlength: '40', placeholder: 'Squared Soda' }),
    product: h('input', { id: 'brand-product', maxlength: '80', placeholder: 'Fizzy drink in a brass-capped bottle' }),
    tagline: h('input', { id: 'brand-tagline', maxlength: '80', placeholder: 'Every sip costs the square of the last.' }),
    targets: h('input', { id: 'brand-targets', maxlength: '240', placeholder: 'voting, game theory, governance' }),
    bid: h('input', { id: 'brand-bid', type: 'number', min: '1', max: '100', value: '10' }),
  };
  const submit = h('button', { class: 'primary' }, 'Enter the auction');
  const message = notice();
  submit.addEventListener(
    'click',
    busy(submit, message, async () => {
      const body = { name: fields.name.value, product: fields.product.value, tagline: fields.tagline.value, targets: fields.targets.value, bid: Number(fields.bid.value) };
      const { data: entered } = await api('/v1/brands/bids', { method: 'POST', token, body });
      say(message, `${entered.message} You start with ${entered.budget} play credits.`, true);
    }),
  );
  show(
    h('h1', {}, 'Sponsor a catalogue'),
    h('p', { class: 'lead' }, 'Brands bid play credits for a slot in people’s catalogues. The auction runs inside the ZKAds enclave: it weighs each bid by how well the brand fits the card itself (never anything private), the winner pays the second price, and no brand ever learns who saw it.'),
    token
      ? h(
          'section',
          { class: 'panel' },
          h('h2', {}, 'Enter a brand'),
          field('Brand name', fields.name),
          field('Product', fields.product),
          field('Tagline', fields.tagline),
          field('Traits you want (comma-separated)', fields.targets),
          field('Bid per slot (play credits, 1–100)', fields.bid),
          h('div', { class: 'row' }, submit),
          message,
        )
      : read(GUEST)
        ? savePanel()
        : h('section', { class: 'panel' }, h('p', {}, 'Sign in to enter a brand.'), signInButton()),
    h('h2', {}, 'In the auction now'),
    h('ul', { class: 'cards' }, data.brands.map((brand) => h('li', {}, h('span', {}, h('b', {}, brand.name), h('br'), h('span', { class: 'muted small' }, `${brand.product}. “${brand.tagline}”`)), brand.fictional ? h('span', { class: 'badge' }, 'fictional') : null))),
  );
}

// A fusion invite as a big QR code, for showing on a screen (or sending the link).
async function invite() {
  const token = read(SESSION) ?? read(AGENT, sessionStorage) ?? read(GUEST);
  const id = idFrom(params.get('card'));
  if (!id) return notFound();
  if (!token) return show(h('h1', {}, 'Fuse with someone'), h('p', { class: 'lead' }, 'Inviting someone needs your account: sign in, or open the save link your assistant gave you.'), signInButton());
  const { data } = await api(`/v1/cards/${id}/invite`, { method: 'POST', token }).catch((error) => {
    if (error.status === 404) error.message = 'Only the card’s owner can invite someone to fuse with it. If it is yours, sign in with the account it belongs to.';
    throw error;
  });
  // One short line for the friend's own assistant, which does the rest.
  const line = `Read ${API}/skill.md and fuse my ZKAds card with yours: ${data.fuse_url}`;
  const canvas = qrCanvas(data.fuse_url);
  const copyLine = h('button', { class: 'primary' }, 'Copy');
  const copyLink = h('button', { class: 'secondary' }, 'Copy just the link');
  const message = notice();
  copyLine.addEventListener('click', busy(copyLine, message, async () => (await navigator.clipboard.writeText(line), say(message, 'Copied. Send it to your friend for their assistant.', true))));
  copyLink.addEventListener('click', busy(copyLink, message, async () => (await navigator.clipboard.writeText(data.fuse_url), say(message, 'Link copied.', true))));
  show(
    h('h1', {}, 'Fuse with someone'),
    h('p', { class: 'lead' }, `Send your friend this line for their AI assistant, or let them scan the code. Whoever uses it first can fuse your item with theirs, once. ${read(SESSION) ? 'Their summary and yours are read only inside the enclave.' : 'Their summary is read only inside the enclave; your side comes from your card.'}`),
    h('pre', { class: 'say' }, line),
    h('div', { class: 'row' }, copyLine, copyLink),
    message,
    h('div', { class: 'qr' }, canvas),
    h('div', { class: 'code' }, data.code),
    h('p', { class: 'muted small' }, `Works until ${new Date(data.expires_at).toLocaleString()}. Newcomers can join with the same code.`),
  );
}

function qrCanvas(text) {
  const { data, size } = encode(text, { border: 2, ecc: 'M' });
  const scale = Math.max(4, Math.floor(320 / size));
  const canvas = h('canvas', { width: size * scale, height: size * scale, class: 'qr-code', role: 'img', 'aria-label': 'QR code for the fusion link' });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0e0d0c';
  data.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(x * scale, y * scale, scale, scale)));
  return canvas;
}

// The friend's side of a fusion invite: join or sign in, then seal a summary
// in the enclave (straight from this browser) and make the shared card.
async function fuse() {
  const code = params.get('code') ?? '';
  const fusionId = idFrom(params.get('fusion'));
  if (params.get('fusion') && !fusionId) return notFound();
  const token = read(SESSION);
  let face = null;
  if (code) {
    try {
      ({ data: face } = await api(`/v1/fusion-invites/${encodeURIComponent(code)}`));
    } catch (error) {
      if (!fusionId) return show(h('h1', {}, 'Fuse items'), notice(friendly(error)), h('a', { href: '/' }, 'Back to ZKAds'));
    }
  }
  const header = [
    h('h1', {}, face?.card.name ? `Fuse with ${face.card.name}’s card` : face ? 'Fuse with this card' : 'Fuse items'),
    face && safe(face.card.poster_url) && h('img', { class: 'poster', src: safe(face.card.poster_url), alt: face.card.product_name ?? '' }),
    face && h('p', { class: 'lead' }, `${face.card.product_name}: fuse it with your own interests into one shared item, for both of you.`),
  ];
  if (!token && read(GUEST)) return show(...header, savePanel());
  if (!token) {
    return show(...header, joinPanel(code), h('section', { class: 'panel' }, h('h2', {}, 'Already a member?'), signInButton()));
  }
  const summary = h('textarea', { id: 'summary', placeholder: 'Paste the summary here', spellcheck: 'false' });
  const name = h('input', { id: 'fuse-name', maxlength: '40', placeholder: 'Optional' });
  const copyPrompt = h('button', { class: 'secondary' }, 'Copy the summary prompt');
  const submit = h('button', { class: 'primary' }, 'Seal it and fuse');
  const message = notice();
  copyPrompt.addEventListener(
    'click',
    busy(copyPrompt, message, async () => {
      const res = await fetch(`${API}/v1/summary-prompt`);
      if (!res.ok) throw new Error('Could not load the prompt.');
      await navigator.clipboard.writeText(await res.text());
      say(message, 'Prompt copied. Paste it into your assistant, then paste its summary here.', true);
    }),
  );
  // Once the invite is claimed, a retry asks for a fresh upload link instead.
  let claimedId = fusionId;
  submit.addEventListener(
    'click',
    busy(submit, message, async () => {
      if (summary.value.trim().length < 40) throw new Error('Paste the summary your assistant wrote first.');
      const claimed = claimedId
        ? { fusion_id: claimedId, ...(await api(`/v1/fusions/${claimedId}/upload`, { method: 'POST', token })).data }
        : (await api(`/v1/fusion-invites/${encodeURIComponent(code)}/accept`, { method: 'POST', token, body: { name: name.value.trim() || undefined } })).data;
      claimedId = claimed.fusion_id;
      // Straight to the enclave: the ZKAds worker never sees the summary.
      const sealed = await seal(claimed.upload, `fusion:${claimed.fusion_id}`, summary.value);
      if (!sealed.ok) throw new Error((await sealed.json().catch(() => ({}))).error?.message ?? 'The enclave did not accept the summary.');
      const { data: card } = await api(`/v1/fusions/${claimed.fusion_id}/start`, { method: 'POST', token });
      location.assign(`/card?id=${card.id}`);
    }),
  );
  show(
    ...header,
    h('ol', { class: 'steps' }, h('li', {}, 'Copy the summary prompt and paste it into your assistant (Claude, ChatGPT…).'), h('li', {}, 'Paste its summary below. It goes straight into the enclave, is read only there, and is deleted once your shared idea is written (or within 24 hours if it never is).')),
    h('div', { class: 'row' }, copyPrompt),
    field('Your assistant’s summary', summary),
    fusionId ? null : field('Your name on the shared card', name),
    h('div', { class: 'row' }, submit),
    message,
  );
}

// find_fusion_partner from the web: open a card to matching (sealing a
// summary in the enclave), then see who shares the most and ask to fuse.
async function match() {
  const token = read(SESSION);
  const id = idFrom(params.get('card'));
  if (!id) return notFound();
  if (!token) return show(h('h1', {}, 'Find partners'), needPasskey());
  const { data: card } = await api(`/v1/cards/${id}`);
  const message = notice();
  const results = h('div');
  const summary = h('textarea', { id: 'match-summary', placeholder: 'Paste the summary here', spellcheck: 'false' });
  const copyPrompt = h('button', { class: 'secondary' }, 'Copy the summary prompt');
  const openButton = h('button', { class: 'primary' }, 'Seal it and open for 72 hours');
  const findButton = h('button', { class: 'primary' }, 'Find partners');
  const stopButton = h('button', { class: 'secondary' }, 'Stop matching');
  copyPrompt.addEventListener(
    'click',
    busy(copyPrompt, message, async () => {
      const res = await fetch(`${API}/v1/summary-prompt`);
      await navigator.clipboard.writeText(await res.text());
      say(message, 'Prompt copied. Paste it into your assistant, then paste its summary here.', true);
    }),
  );
  const findPartners = async () => {
    const { data } = await api(`/v1/cards/${id}/partners`, { token });
    results.replaceChildren(
      data.partners.length
        ? h(
            'ul',
            { class: 'cards' },
            data.partners.map((partner) => {
              const ask = h('button', { class: 'secondary' }, 'Ask to fuse');
              const note = notice();
              ask.addEventListener('click', busy(ask, note, async () => (await api('/v1/fusions', { method: 'POST', token, body: { card_id: id, partner_card_id: partner.card.id } }), ask.replaceWith(h('span', { class: 'badge' }, 'asked')))));
              return h('li', {}, h('span', {}, h('a', { href: safe(partner.card.page_url) }, partner.card.product_name ?? 'A card'), h('br'), h('span', { class: 'muted small' }, partner.reason)), ask, note);
            }),
          )
        : h('p', { class: 'muted' }, 'Nobody in the pool shares enough with you yet. Check back later.'),
    );
  };
  openButton.addEventListener(
    'click',
    busy(openButton, message, async () => {
      if (summary.value.trim().length < 40) throw new Error('Paste the summary your assistant wrote first.');
      if (summary.value.trim().length > 12_000) throw new Error('That summary is too long: keep it under 12,000 characters.');
      const { data } = await api(`/v1/cards/${id}/matching`, { method: 'POST', token, body: { open: true } });
      const sealed = await seal(data.upload, `card:${id}`, summary.value);
      if (!sealed.ok) throw new Error((await sealed.json().catch(() => ({}))).error?.message ?? 'The enclave did not accept the summary.');
      location.reload();
    }),
  );
  findButton.addEventListener('click', busy(findButton, message, findPartners));
  stopButton.addEventListener(
    'click',
    busy(stopButton, message, async () => {
      const { data } = await api(`/v1/cards/${id}/matching`, { method: 'POST', token, body: { open: false } });
      location.assign(`/match?card=${id}${data.summary_deleted === false ? '&kept=1' : ''}`);
    }),
  );
  if (card.matching?.open) {
    openButton.textContent = 'Seal a new summary';
    return show(
      h('h1', {}, card.product_name),
      h('p', { class: 'lead' }, `Open to matching until ${new Date(card.matching.until).toLocaleString()}. Your summary is sealed in the enclave. Other people in matching can see this card (its page, name and picture) and what you have in common, never your summary.`),
      h('div', { class: 'row' }, findButton, stopButton),
      message,
      results,
      h(
        'details',
        { class: 'panel' },
        h('summary', {}, 'Replace your summary'),
        h('p', { class: 'muted small' }, 'If the search says no summary is sealed, or you want a fresh one, paste it here. It also restarts the 72 hours.'),
        h('div', { class: 'row' }, copyPrompt),
        field('Your assistant’s summary', summary),
        h('div', { class: 'row' }, openButton),
      ),
    );
  }
  show(
    h('h1', {}, 'Find partners'),
    params.get('kept') && notice('Matching is stopped. The enclave could not delete your summary just now, so it expires on its own within 72 hours; opening matching again deletes it first.'),
    h('p', { class: 'lead' }, `Open “${card.product_name}” to matching. Inside the enclave, a model reads your summary on its own and notes a few interest tags and harmless traits. People are suggested by the tags you share, and a fusion is written from the traits. Others in matching see this card and what you have in common, never your summary. It is deleted after 72 hours or when you stop.`),
    h('div', { class: 'row' }, copyPrompt),
    field('Your assistant’s summary', summary),
    h('div', { class: 'row' }, openButton),
    message,
  );
}

// Sends a summary straight to the enclave's upload link: only into the slot
// this page means (`key`; a link for another slot, such as a draft that gets
// a whole card written from it, is refused) and, if an enclave is pinned in
// config.js, only to that enclave.
function seal(upload, key, summary) {
  if (ENCLAVE && new URL(upload.url).origin !== new URL(ENCLAVE).origin) throw new Error('The upload link does not point at this site’s ZKAds enclave, so the summary was not sent.');
  if (uploadKey(upload.token) !== key) throw new Error('The upload link is for a different summary, so the summary was not sent.');
  return fetch(upload.url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${upload.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ summary }) });
}

// The summary slot an upload token is for (signed for the enclave; read here only).
function uploadKey(token) {
  try {
    const payload = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).k ?? null;
  } catch {
    return null;
  }
}

function notFound() {
  show(h('h1', {}, 'Nothing here'), h('a', { href: '/' }, 'Back to ZKAds'));
}

// The passkey mark beside the buttons that use one (fixed markup, no data in
// it). A function, so the nav can be drawn before this line runs.
function fingerprint() {
  const holder = document.createElement('template');
  holder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5.2 6.2A8.6 8.6 0 0 1 20.4 11.5c0 1.6-.2 3.1-.6 4.5"/><path d="M3.8 10.5c-.3 1-.4 2-.4 3 0 1.9.4 3.7 1.1 5.3"/><path d="M7.4 20.2c-.8-2-1.2-4.2-1.2-6.7a5.8 5.8 0 0 1 11.3-1.8"/><path d="M17.8 14.6c-.1 2-.5 3.9-1.2 5.6"/><path d="M10.4 21.4c-1-2.5-1.4-5.1-1.4-7.9a3 3 0 0 1 6 0c0 3-.4 5.6-1.3 7.6"/><path d="M12 13.4c0 2.9.4 5.6 1.2 8"/></svg>';
  return holder.content.firstElementChild;
}

// The header: "account" for a member (their cards), or "save" for a guest
// account this browser has (checked first) or a claim link this tab is
// handling, otherwise "login" (both open the passkey choice). The About
// link sits last.
function renderNav() {
  const nav = document.getElementById('nav');
  const about = h('a', { class: 'about-link', href: aboutHref(), 'aria-label': 'About ZK Ads' }, icon('about'));
  if (read(SESSION)) {
    const account = h('button', { class: 'account', type: 'button', 'aria-haspopup': 'dialog' }, fingerprint(), 'account');
    account.addEventListener('click', () => accountDialog(account));
    return nav.replaceChildren(account, about);
  }
  const label = accountLabel();
  // (While a guest account is being checked, the control waits, hidden.)
  const button = h('button', { class: `account${label ? '' : ' pending'}`, type: 'button', 'aria-haspopup': 'dialog', disabled: !label }, fingerprint(), label ?? 'save');
  button.addEventListener('click', () => openAuth(button));
  nav.replaceChildren(button, about);
}

function accountLabel() {
  if (linkHere()) return 'save';
  if (guest === 'checking') return null;
  return guest === 'ok' && read(CLAIM) ? 'save' : 'login';
}

// Checks this browser's guest account (again), then redraws the header.
function checkGuest() {
  const token = read(GUEST);
  guest = token ? 'checking' : 'none';
  renderNav();
  if (!token) return;
  live(GUEST).then((ok) => {
    // A guest account stored meanwhile has its own check.
    if (read(GUEST) && read(GUEST) !== token) return;
    guest = ok ? 'ok' : 'none';
    renderNav();
  });
}

// The claim link this tab is handling, read as claim() reads it: only on the
// claim page in link mode (the link's code, or the tab's copy of it).
function linkHere() {
  if (location.pathname !== '/claim' || !(location.hash.length > 1 || new URLSearchParams(location.search).has('link'))) return null;
  return location.hash.slice(1) || read(LINK, sessionStorage);
}

// The guest account that "Create" saves here: that claim link, otherwise
// this browser's own guest account once it checks out.
function claimCodeHere() {
  return linkHere() ?? (guest === 'ok' ? read(CLAIM) : null);
}

// Log in or create, each with the real passkey ceremony from the chosen
// button. Create saves the guest account or claim link at hand (the same
// account and cards); otherwise it joins with the event code in the link.
function openAuth(trigger) {
  const claimCode = claimCodeHere();
  const fromLink = Boolean(linkHere());
  const invite = eventCode();
  const message = notice();
  const login = h('button', { class: 'btn big choice', type: 'button' }, fingerprint(), 'Log in');
  const create = h('button', { class: 'btn primary big choice', type: 'button' }, fingerprint(), 'Create');
  // One ceremony at a time; a cancelled or failed one leaves the choice open.
  const run = (task) => async () => {
    login.disabled = create.disabled = true;
    message.hidden = true;
    try {
      await task();
      location.assign(nextPath());
    } catch (error) {
      say(message, friendly(error));
      login.disabled = create.disabled = false;
    }
  };
  login.addEventListener(
    'click',
    run(async () => {
      const { data } = await api('/v1/auth/login/options', { method: 'POST', body: {} });
      const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options });
      const { data: done } = await api('/v1/auth/login/verify', { method: 'POST', body: { ceremony: data.ceremony, response } });
      write(SESSION, done.session);
    }),
  );
  create.addEventListener(
    'click',
    run(async () => {
      // Create acts on the account the choice named when it opened: a link that
      // has failed since says so, and never falls back to another account.
      if (fromLink && !linkHere()) throw new Error('This link was already used or has expired. Ask your assistant for a new one, or log in.');
      if (claimCode) return claimAccount(claimCode);
      // It named no account; one started in another tab meanwhile is not passed over for a new one.
      if (guest === 'checking') guest = (await live(GUEST)) ? 'ok' : 'none';
      if (claimCodeHere()) throw new Error('A guest account was started in this browser meanwhile. Close this and choose “save” to keep its cards.');
      if (!invite) throw new Error('Creating an account needs your event’s link: scan its QR code, then choose Create.');
      const { data } = await api('/v1/auth/register/options', { method: 'POST', body: { invite } });
      const response = await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: data.options });
      const { data: done } = await api('/v1/auth/register/verify', { method: 'POST', body: { ceremony: data.ceremony, response } });
      write(SESSION, done.session);
    }),
  );
  modal({
    title: 'Save your cards',
    trigger,
    className: 'auth',
    initial: login,
    content: [
      h('div', { class: 'choices' }, login, create),
      claimCode && h('p', { class: 'note' }, fromLink ? 'Create saves the guest account from your assistant’s link with a passkey. Log in keeps it apart: its cards are not moved into your account.' : 'Create saves this browser’s guest cards with a passkey. Log in keeps them apart: they are not moved into your account.'),
      message,
    ],
  });
}

// An accessible modal over the page: named by its title, focus moved in and
// kept there (the page behind is inert while it is open), closed by its X,
// Escape or a click on the backdrop, and focus handed back to its trigger.
function modal({ title, trigger, className = '', initial = null, content }) {
  const id = `modal-${++uid}`;
  const close = h('button', { class: 'close', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const dialog = h('dialog', { class: `modal ${className}`, 'aria-labelledby': id }, h('div', { class: 'modal-head' }, h('h2', { id }, title), close), h('div', { class: 'modal-body' }, content));
  close.addEventListener('click', () => dialog.close());
  // A click on the backdrop closes it, unless it began inside (selecting text, say).
  let fromBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => (fromBackdrop = event.target === dialog));
  dialog.addEventListener('click', (event) => event.target === dialog && fromBackdrop && dialog.close());
  // Escape first closes a help note open inside it.
  dialog.addEventListener('cancel', (event) => {
    const open = dialog.querySelector('.help[aria-expanded="true"]');
    if (open) {
      event.preventDefault();
      open.click();
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    document.documentElement.classList.remove('modal-open');
    // (The header may have been redrawn meanwhile; its control takes focus then.)
    (trigger?.isConnected ? trigger : document.querySelector('.account:not([disabled])') ?? document.querySelector('.about-link'))?.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  document.documentElement.classList.add('modal-open');
  dialog.showModal();
  (initial ?? close).focus();
  return dialog;
}

// The prompt reader: the whole text, selectable, as plain text (never
// markup), with a copy button that copies exactly the same string.
function promptDialog({ title, text, trigger, copyLabel = 'Copy prompt', after = null }) {
  const message = notice();
  const body = h('div', { class: 'prompt-text', tabindex: '0', 'aria-label': `${title} text` }, text);
  const copy = h('button', { class: 'btn primary big', type: 'button' }, h('span', {}, copyLabel), icon('copy'));
  copy.addEventListener('click', () => copyText(text, copy, message, 'Copying is blocked in this browser: select the text above and copy it.'));
  modal({ title, trigger, className: 'reader', initial: body, content: [body, h('div', { class: 'modal-actions' }, copy), message, after] });
}

// Copies `text`; only a real success says so (on the button, briefly, and
// in a toast). A failure says what to do instead.
async function copyText(text, button, message, failure = 'Copying is blocked in this browser. Open “read prompt” and copy the text from there.') {
  message.hidden = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    say(message, failure);
    return false;
  }
  const label = button.querySelector('span');
  button.dataset.label ??= label.textContent;
  label.textContent = 'Copied';
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => (label.textContent = button.dataset.label), 2200);
  toast('Copied. Paste it into your assistant.');
  return true;
}

function toast(text) {
  const box = document.querySelector('.toast') ?? h('div', { class: 'toast', role: 'status' });
  // Inside an open modal (the page behind is inert), so it is seen and announced.
  const host = document.querySelector('dialog.modal[open]') ?? document.body;
  if (box.parentElement !== host) host.append(box);
  box.textContent = text;
  box.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('on'), 3500);
}

// The software behind one rendering stage of `card`, from what its status
// says: who writes the concept, and which renderer runs. Only the Phala one is
// a TEE; Venice and Phala Confidential AI run their own models, asked by the
// render service. Until the status arrives, nothing is claimed about either.
function stageSoftware(step, card) {
  const renderer = card?.renderer;
  const tee = renderer === 'phala';
  const local = renderer === 'local';
  // Where the render service runs, as a closing remark (none until known).
  const venice = local ? 'Venice, or saved test media' : 'Venice';
  const where = tee ? ' The render service runs inside a Phala TEE (a confidential virtual machine).' : local ? ' This site uses a render service on a local machine for testing, not a TEE, and its media may be saved test media.' : renderer === 'remote' ? ' This site’s render service is not the Phala one, so treat it as an ordinary server.' : '';
  if (step === 'queued') return [tee ? 'ZK Ads render service on Phala' : local ? 'A local ZK Ads render service' : 'The ZK Ads render service', `Your card waits its turn in the ZK Ads render service.${where}`];
  if (step === 'concept') {
    if (card?.concept_by === 'assistant') return ['Your own assistant', 'Your assistant wrote this idea and sent only the finished concept.'];
    if (card?.concept_by === 'venice') return [local ? 'Venice, or a test stand-in' : 'Venice', `The render service asks a Venice text model${local ? ' (or, in a test setup, a stand-in)' : ''} to write this card from the public text of your earlier card’s catalogue item; no history is read.${where}`];
    if (tee) return ['Phala Confidential AI', `The render service asks a confidential model in Phala’s GPU TEE to write the idea from the sealed summaries; ZK Ads never sees them.${where}`];
    return [local ? 'Phala Confidential AI, or a test stand-in' : 'Phala Confidential AI', `The render service reads the summaries and asks Phala Confidential AI${local ? ' (or, in a test setup, a stand-in)' : ''} to write the idea from them.${where}`];
  }
  if (step === 'image') return [venice, `The render service asks Venice’s image model to draw the product from the idea’s picture description.${where}`];
  if (step === 'orbit') return [venice, `The render service asks Venice’s image-to-video model to film a 360° orbit around the product, starting from its picture.${where}`];
  if (step === 'music') return [venice, `By default the sound is the orbit model’s own soundtrack. A separate Venice music model writes it here only when the render service is set to use one.${where}`];
  return ['ZK Ads templates, headless Chrome and ffmpeg', `The render service sets the story pages in HTML, renders them with headless Chrome and mixes the story video with ffmpeg.${where}`];
}

// A small question mark beside a rendering stage: a click or tap opens a note
// naming the software behind it (`content`: [name, text], or a function
// giving them when opened).
function help(label, content) {
  const id = `help-${++uid}`;
  const button = h('button', { class: 'help', type: 'button', 'aria-label': label, 'aria-expanded': 'false', 'aria-controls': id });
  const note = h('div', { class: 'popover', id, role: 'dialog', 'aria-label': label, tabindex: '-1', hidden: true });
  const place = () => {
    const box = button.getBoundingClientRect();
    const width = note.offsetWidth;
    const left = Math.min(Math.max(12, box.left + box.width / 2 - width / 2), window.innerWidth - width - 12);
    const below = box.bottom + 6;
    note.style.left = `${left}px`;
    note.style.top = `${below + note.offsetHeight + 12 > window.innerHeight ? Math.max(12, box.top - note.offsetHeight - 6) : below}px`;
  };
  const onScroll = () => requestAnimationFrame(place);
  const outside = (event) => !button.contains(event.target) && !note.contains(event.target) && hide();
  const escape = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    hide(true);
  };
  function hide(refocus = false) {
    if (note.hidden) return;
    note.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onScroll);
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) button.focus();
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!note.hidden) return hide();
    const [name, text] = typeof content === 'function' ? content() : content;
    note.replaceChildren(h('strong', {}, name), h('p', {}, text));
    note.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    note.focus({ preventScroll: true });
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', onScroll);
    document.addEventListener('pointerdown', outside, true);
  });
  button.addEventListener('keydown', escape);
  note.addEventListener('keydown', escape);
  // Closes once focus moves on to anything else.
  note.addEventListener('focusout', (event) => event.relatedTarget && event.relatedTarget !== button && !note.contains(event.relatedTarget) && hide());
  return [button, note];
}

// About: the main project in brief, Charlie's badge and links, and a prompt
// for a visitor's own assistant to find where their work and his overlap.
function about() {
  document.title = 'About · ZK Ads';
  const actions = copyActions({ label: 'Copy intro prompt', text: INTRO_PROMPT, title: 'Find our overlap' });
  const out = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text, icon('outward'), h('span', { class: 'sr' }, ' (opens in a new tab)'));
  show(
    h(
      'div',
      { class: 'about' },
      h('h1', { class: 'sr' }, 'About ZK Ads'),
      h(
        'div',
        { class: 'summary' },
        h('p', {}, 'ZK Ads is a privacy-focused advertising system in development. It is designed to make ads relevant without giving advertisers the underlying personal data.'),
        h('p', {}, 'Its design combines a user-controlled vault, zero-knowledge proofs and confidential matching. The broader plan shares value with readers and publishers through rewards or access to content.'),
      ),
      h(
        'aside',
        { class: 'side' },
        h('figure', { class: 'badge-fig' }, h('img', { src: '/media/charlie-frontiers-badge.jpg', width: '572', height: '854', alt: "Charlie Thompson's Paradigm Frontiers badge, with the handle @doctor-gonzo and colorful abstract artwork." })),
        h('p', { class: 'links' }, out('https://charliethompson.lol/', 'charliethompson.lol')),
        h('p', { class: 'links' }, out('https://www.linkedin.com/in/charlie-thompson-2a8293aa/', 'LinkedIn'), out('https://x.com/charlie______t', 'Twitter')),
        h('p', { class: 'links' }, h('a', { href: 'mailto:charlie_thompson@protonmail.com' }, 'charlie_thompson@protonmail.com')),
      ),
      h(
        'section',
        { class: 'overlap', 'aria-labelledby': 'overlap-title' },
        h('h2', { id: 'overlap-title' }, 'Where do we overlap?'),
        h('p', { class: 'helper' }, 'Paste this into your AI assistant to find connections between your work and mine.'),
        actions.nodes,
      ),
    ),
  );
  view.classList.add('wide');
}

// About keeps the landing page's event code. Only a landing page's code
// travels (never a fusion invite's, an approval's or a claim code).
function landingCode() {
  return ['/', '/event', '/about'].includes(location.pathname) ? inviteCodeOf(params.get('code') ?? '') : null;
}

function aboutHref() {
  const query = new URLSearchParams();
  const from = location.pathname === '/event' || (location.pathname === '/about' && params.get('from') === 'event');
  if (from) query.set('from', 'event');
  const code = landingCode();
  if (code) query.set('code', code);
  return `/about${query.toString() ? `?${query}` : ''}`;
}

function icon(name) {
  const holder = document.createElement('template');
  holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return holder.content.firstElementChild;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `The request failed (${res.status}).`), { status: res.status, code: data.error?.code });
  return { status: res.status, data };
}

// Disables the button while `task` runs and shows its error, if any.
function busy(button, message, task) {
  return async (event) => {
    event?.preventDefault();
    button.disabled = true;
    message.hidden = true;
    try {
      await task();
    } catch (error) {
      say(message, friendly(error));
    } finally {
      button.disabled = false;
    }
  };
}

function friendly(error) {
  if (error?.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out. Try again.';
  if (error?.name === 'InvalidStateError') return 'This device already has a ZKAds passkey. Sign in instead.';
  return error?.message || 'Something went wrong.';
}

function show(...nodes) {
  view.className = '';
  view.replaceChildren(...nodes.flat().filter(Boolean));
  window.scrollTo(0, 0);
}

function field(text, input) {
  return h('div', { class: 'field' }, h('label', { for: input.id }, text), input);
}

function notice(text) {
  const box = h('div', { class: 'notice', role: 'status' });
  if (text) box.textContent = text;
  else box.hidden = true;
  return box;
}

function say(box, text, ok = false) {
  box.textContent = text;
  box.className = ok ? 'notice ok' : 'notice';
  box.hidden = false;
}

// Builds an element; strings become text, never markup.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

function safe(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : undefined;
}

// Ids from a link go into API paths only if they are ids (no "../accept?").
function idFrom(value) {
  return /^[a-z2-7]{20}$/.test(value ?? '') ? value : null;
}

function userCode(value) {
  const letters = value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

// A stored sign-in, or null if there is none or it was revoked or ran out
// (then it is forgotten).
async function live(key) {
  const token = read(key);
  if (!token || (await api('/v1/me', { token }).then(() => true, (error) => error.status !== 401))) return token;
  // (Only that sign-in: another may have been stored while it was checked.)
  if (read(key) === token) {
    forget(key);
    if (key === GUEST) forget(CLAIM);
  }
  renderNav();
  return null;
}

function storageWorks() {
  write('zkads.check', '1');
  const works = read('zkads.check') === '1';
  forget('zkads.check');
  return works;
}

// The event code for this page: the link's own, else the event's (config.js).
function eventCode() {
  return inviteCodeOf(params.get('code') ?? '') ?? inviteCodeOf(window.ZKADS_EVENT_CODE ?? '');
}

// An invite or event code as shown ("ZK-ABCD-2345"), or null if it is not one.
function inviteCodeOf(value) {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ZK(?=.{8}$)/, '');
  return /^[2-9A-HJKMNP-TV-Z]{8}$/.test(code) ? `ZK-${code.slice(0, 4)}-${code.slice(4)}` : null;
}

// After signing in, return only to a path on this site: the `next` one, or
// the page the person was on (an approval or a fusion invite).
function nextPath() {
  const next = params.get('next');
  if (next) {
    // Resolved by the browser's own rules, and returned whole: a bare path
    // such as "//evil.example" (from "/..//evil.example") would leave the site.
    const target = new URL(next, location.origin);
    if (target.origin === location.origin) return target.href;
  }
  return ['/', '/join', '/signin', '/claim', '/event', '/about'].includes(location.pathname) ? '/' : location.pathname + location.search;
}

function withNext(path) {
  return `${path}?next=${encodeURIComponent(location.pathname + location.search)}`;
}

function read(key, storage = localStorage) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value, storage = localStorage) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage is blocked (private mode); the sign-in lasts for this page only.
  }
}

function forget(key, storage = localStorage) {
  try {
    storage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}
