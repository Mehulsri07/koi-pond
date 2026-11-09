// The legend panel: opens from the header button, closes with Escape or its close button.
// Focus moves into the panel when it opens and back to the button when it closes.
// renderLegend fills #legend-body with plain sentences from legend_json() and pads_json();
// every text goes in with textContent and every attribute with setAttribute, never markup.
// The panel redraws when it opens and, while open, once a second (for the clock line), but
// only when its text would change, so focus on a repo link is never lost.

import { repoUrl } from './url.js';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const number = (value) => Number(value).toLocaleString('en-US');

// "2026-11-07" -> "Nov 7, 2026", read as a plain date (no timezone shift).
export function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!match) return String(iso);
  return `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}, ${match[1]}`;
}

export function moodLine(reason) {
  const known = typeof reason?.value === 'number' && Number.isFinite(reason.value);
  const value = known ? reason.value : null;
  switch (reason?.rule) {
    case 'deep_rest': return known ? `Deep rest: ${number(value)} quiet days` : 'Deep rest: 60+ quiet days';
    case 'rest': return known ? `Resting: ${number(value)} quiet days` : 'Resting';
    case 'first_contribution_of_week': return 'Feeding at the surface: first contribution this week';
    case 'crossed_milestone': return known ? `Darting: crossed ${number(value)} contributions this week` : 'Darting: crossed a milestone this week';
    case 'busy_week': return 'Darting: busiest week in a year';
    default: return 'Cruising';
  }
}

export function flowerSentence(pads) {
  const parts = [];
  for (const color of ['pink', 'white', 'purple']) {
    const pad = pads.find((each) => each.bloom === color && each.language);
    if (pad) parts.push([pad.language, color]);
  }
  if (!parts.length) return 'No repos have a language yet, so nothing blooms.';
  const [[firstName, firstColor], ...rest] = parts;
  return `${[`${firstName} blooms ${firstColor}`, ...rest.map(([name, color]) => `${name} ${color}`)].join(', ')}; other languages bud.`;
}

export function lightLine(phase, now = new Date()) {
  const name = String(phase?.name ?? 'day');
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${clock} your time`;
}

function element(tag, text, attributes) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [name, value] of Object.entries(attributes ?? {})) node.setAttribute(name, value);
  return node;
}

export function renderLegend(legend, pads, phase, renderMode, body = document.getElementById('legend-body'), now = new Date()) {
  if (!legend) return;
  const sections = [];
  const section = (title, ...children) => {
    const node = element('section', null, { class: 'legend-section' });
    node.append(element('h3', title), ...children);
    sections.push(node);
    return node;
  };

  section('Size', element('p', `${number(legend.totalContributions)} contributions through ${formatDate(legend.observedOn)} · a ${legend.growthStage} koi`));

  const languages = element('ul', null, { class: 'legend-languages' });
  for (const language of legend.languages) {
    const item = element('li');
    const dot = element('span', null, { class: 'legend-dot', 'aria-hidden': 'true' });
    dot.style.background = /^#[0-9a-fA-F]{6}$/.test(language.color ?? '') ? language.color : '#8a9a96';
    item.append(dot, element('span', language.name, { class: 'legend-name' }), element('span', `${Math.round(language.share * 100)}%`, { class: 'legend-num' }));
    languages.append(item);
  }
  section('Colors', languages);

  section('Mood', element('p', moodLine(legend.reason)));

  const count = legend.padCount;
  const pad = `${number(count)} ${count === 1 ? 'lilypad, one per public repo' : 'lilypads, one per public repo'}.`;
  section('Lilypads',
    element('p', `${pad} Bigger pads have more commits (≤10, 11–20, 21–40, 41–80, 81+).`),
    element('p', flowerSentence(pads)));

  const repos = element('ul', null, { class: 'legend-repos' });
  for (const each of [...pads].sort((a, b) => b.commits - a.commits)) {
    const item = element('li');
    const short = String(each.repo).split('/').filter(Boolean).pop() ?? String(each.repo);
    const name = repoUrl(each.url) ? element('a', short, { href: repoUrl(each.url), target: '_blank', rel: 'noopener' }) : element('span', short);
    name.classList.add('legend-repo');
    item.append(name, element('span', `${each.language ?? 'no language'} · ${number(each.commits)} ${each.commits === 1 ? 'commit' : 'commits'}`, { class: 'legend-meta' }));
    repos.append(item);
  }
  section('Repos', repos);

  section('Light', element('p', lightLine(phase, now), { class: 'legend-light' }));
  section('Data',
    element('p', renderMode === '20-per-second' ? 'Koi drawn 20 times a second on this device' : 'Koi drawn every frame'),
    element('p', `Data from ${formatDate(legend.observedOn)}, refreshed nightly.`));

  body.replaceChildren(...sections);
}

export function setupLegend({
  panel = document.getElementById('legend'),
  button = document.getElementById('legend-button'),
  closeButton = document.getElementById('legend-close'),
  getState = null,
} = {}) {
  const body = panel.querySelector('#legend-body');
  let shownKey = null;
  let timer = null;

  // Draw the legend from the page's state; skip when nothing it says has changed.
  function refresh() {
    const state = getState?.();
    if (!state?.legend) return;
    const now = new Date();
    // A full redraw only when what the legend describes changes; a new minute or phase
    // updates just the light line, so focus, selection and scroll stay put.
    const key = JSON.stringify([state.legend, state.pads, state.renderMode]);
    if (key !== shownKey) {
      shownKey = key;
      renderLegend(state.legend, state.pads, state.phase, state.renderMode, body, now);
      return;
    }
    const light = body.querySelector('.legend-light');
    const text = lightLine(state.phase, now);
    if (light && light.textContent !== text) light.textContent = text;
  }

  const isOpen = () => panel.classList.contains('open');

  function open() {
    if (isOpen()) return;
    panel.classList.add('open');
    panel.removeAttribute('inert');
    button.setAttribute('aria-expanded', 'true');
    refresh();
    timer = setInterval(refresh, 1000);
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    panel.classList.remove('open');
    panel.setAttribute('inert', '');
    button.setAttribute('aria-expanded', 'false');
    clearInterval(timer);
    timer = null;
    button.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  return { open, close, isOpen };
}
