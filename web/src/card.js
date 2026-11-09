// The pad card: a small panel naming a pad's repository, shown on hover or on a first
// tap.
//
//   show(pad, clientX, clientY) / hide()   the page's card (#pad-card)
//   const card = createCard(element)       a card on another element (the page's is
//                                          pageCardInstance())
//   card.show(pad, clientX, clientY, {interactive})  fill the card for a pads_json()
//                                     entry and place it beside the point, inside the
//                                     viewport; interactive: false (a mouse-hover card)
//                                     lets the pointer through to the pond
//   card.hide()
//   card.shownFor()                   the pad shown, or null
//   card.element
//
// It shows the repo's name, its language with the language's color dot (a neutral dot
// for a repo with no language or no color), "N commits by Mehul", and an "Open repo"
// link (target _blank, rel noopener) when the pad has a url. Every text goes in with
// textContent and every attribute with setAttribute, never as markup.

const GAP = 14; // px between the pointer and the card
const MARGIN = 8; // px kept clear at the viewport's edges
const NEUTRAL_DOT = '#8a9a96';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createCard(root = document.getElementById('pad-card')) {
  let shown = null;

  function fill(pad) {
    const [owner, repoName] = pad.repo.includes('/') ? [pad.repo.slice(0, pad.repo.indexOf('/')), pad.repo.slice(pad.repo.indexOf('/') + 1)] : ['', pad.repo];
    const title = element('p', 'pad-card-name', repoName);
    title.setAttribute('title', pad.repo);
    const language = element('p', 'pad-card-language');
    const dot = element('span', 'pad-card-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(pad.languageColor ?? '') ? pad.languageColor : NEUTRAL_DOT;
    language.append(dot, document.createTextNode(pad.language ?? 'No language'));
    const commits = element('p', 'pad-card-commits', `${pad.commits} ${pad.commits === 1 ? 'commit' : 'commits'} by Mehul`);
    const children = [title, language, commits];
    if (pad.url) {
      const link = element('a', 'pad-card-link', 'Open repo');
      link.setAttribute('href', pad.url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
      children.push(link);
    }
    root.replaceChildren(...children);
    root.setAttribute('aria-label', owner ? `${repoName} by ${owner}` : repoName);
  }

  function place(clientX, clientY) {
    // Measured where it is, then moved: the card's size depends on its text.
    root.style.transform = 'translate(-9999px, -9999px)';
    const { width, height } = root.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    let left = clientX + GAP;
    let top = clientY + GAP;
    if (left + width > viewWidth - MARGIN) left = clientX - GAP - width;
    if (top + height > viewHeight - MARGIN) top = clientY - GAP - height;
    left = Math.max(MARGIN, Math.min(left, viewWidth - MARGIN - width));
    top = Math.max(MARGIN, Math.min(top, viewHeight - MARGIN - height));
    root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  return {
    element: root,
    show(pad, clientX, clientY, { interactive = true } = {}) {
      fill(pad);
      root.classList.toggle('pad-card-hover', !interactive);
      root.hidden = false;
      shown = pad;
      place(clientX, clientY);
    },
    hide() {
      if (!shown && root.hidden) return;
      root.hidden = true;
      shown = null;
    },
    shownFor() {
      return shown;
    },
  };
}

// The page's one card, for show(pad, clientX, clientY) and hide().
let pageCard = null;
export function pageCardInstance() {
  pageCard ??= createCard();
  return pageCard;
}
export function show(pad, clientX, clientY, options) {
  pageCardInstance().show(pad, clientX, clientY, options);
}
export function hide() {
  pageCardInstance().hide();
}
