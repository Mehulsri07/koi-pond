// The legend panel: opens from the header button, closes with Escape or its close button.
// Focus moves into the panel when it opens and back to the button when it closes. Its
// content is filled in by renderLegend (Task 10).

export function setupLegend({
  panel = document.getElementById('legend'),
  button = document.getElementById('legend-button'),
  closeButton = document.getElementById('legend-close'),
} = {}) {
  const isOpen = () => panel.classList.contains('open');

  function open() {
    if (isOpen()) return;
    panel.classList.add('open');
    panel.removeAttribute('inert');
    button.setAttribute('aria-expanded', 'true');
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    panel.classList.remove('open');
    panel.setAttribute('inert', '');
    button.setAttribute('aria-expanded', 'false');
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
