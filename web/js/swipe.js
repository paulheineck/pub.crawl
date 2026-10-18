// Wischen auf Touch-Geräten: die vordere Stapelkarte nach rechts (merken) oder links (weg).
//
// Zusammenspiel mit dem Browser: Die Frontkarte hat `touch-action: pan-y` (style.css).
// Senkrechte Bewegungen scrollt der Browser also selbst; waagerechte kommen hier an.
// Erst ab LOCK Pixeln steht fest, ob gewischt oder gescrollt wird – ein einfaches
// Antippen (Link, „mehr", Buttons) funktioniert dadurch wie gewohnt.

const LOCK = 10;             // px Bewegung, ab der die Richtung feststeht
const ROTATE = 7;            // Grad Neigung bei vollem Ausschlag

export function enableSwipe(root, { canSwipe, onSwipe }) {
  let s = null;              // laufende Geste

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || s) return;      // Maus: Buttons/Tasten
    const card = e.target.closest('.item');
    if (!card || !canSwipe(card) || e.target.closest('textarea, input, select')) return;
    s = { card, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, swiping: false,
          pts: [[e.timeStamp, e.clientX]] };
  });

  root.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.swiping) {
      if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) { s = null; return; }   // eher senkrecht → scrollen
      if (!canSwipe(s.card)) { s = null; return; }
      s.swiping = true;
      try { s.card.setPointerCapture(s.id); } catch { /* synthetische Events */ }
      s.card.classList.add('dragging');
      s.card.style.transition = 'none';
    }
    s.dx = dx;
    s.pts.push([e.timeStamp, e.clientX]);
    if (s.pts.length > 6) s.pts.shift();
    const ratio = Math.max(-1, Math.min(1, dx / threshold(s.card)));
    s.card.style.transform = `translateX(${dx}px) rotate(${ratio * ROTATE}deg)`;
    s.card.style.setProperty('--swipe', ratio.toFixed(3));
  });

  const end = (e, cancelled) => {
    if (!s || e.pointerId !== s.id) return;
    const { card, swiping, dx, pts } = s;
    s = null;
    if (!swiping) return;
    card.classList.remove('dragging');
    swallowNextClick();
    try { card.releasePointerCapture(e.pointerId); } catch { /* egal */ }

    const [t0, x0] = pts[0], [t1, x1] = pts[pts.length - 1];
    const v = (x1 - x0) / Math.max(1, t1 - t0);                  // px/ms der letzten Bewegung
    const far = Math.abs(dx) >= threshold(card);
    const flick = Math.abs(v) > 0.5 && Math.abs(dx) > 40 && Math.sign(v) === Math.sign(dx);
    if (!cancelled && (far || flick) && canSwipe(card)) {
      onSwipe(card, dx > 0 ? 'right' : 'left');
    } else {
      snapBack(card);
    }
  };
  root.addEventListener('pointerup', (e) => end(e, false));
  root.addEventListener('pointercancel', (e) => end(e, true));
}

// Ab welcher Strecke ein Wisch zählt: ein Drittel der Kartenbreite, höchstens 130 px
function threshold(card) {
  return Math.min(130, (card.offsetWidth || 320) * 0.33);
}

function snapBack(card) {
  card.style.transition = 'transform .25s ease';
  card.style.transform = '';
  card.style.removeProperty('--swipe');
  setTimeout(() => { if (!card.classList.contains('leaving')) card.style.transition = ''; }, 260);
}

// Nach einem Wisch darf kein „Klick" auf Link oder Button durchrutschen
function swallowNextClick() {
  const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', kill, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', kill, { capture: true }), 400);
}
