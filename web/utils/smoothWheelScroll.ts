// Ease-out wheel scrolling for either axis. Discrete mouse-wheel ticks feel
// jumpy at 1:1; a short glide (~0.22 per frame) softens them without lag.
// Returns a dispose function. Non-passive wheel so preventDefault can stop
// the page/popover from scrolling instead.
//
// External scrollers (e.g. Virtuoso scrollTo / followOutput) must be able to
// win: if a scroll event lands far from the position we just wrote, treat it
// as external, cancel the ease animation, and re-sync the target.
export function attachSmoothWheelScroll(
  element: HTMLElement,
  axis: 'x' | 'y',
): () => void {
  // Local alias so scrollLeft/Top writes do not trip no-param-reassign.
  const node = element;
  let target = axis === 'x' ? node.scrollLeft : node.scrollTop;
  // Internal float position. We advance this in fractional pixels and round
  // when writing to the DOM: writing fractional scrollTop makes the browser
  // paint text at sub-pixel offsets, which looks blurry while scrolling.
  let pos = target;
  let raf = 0;
  // Position we last wrote; used to tell our setPos scroll events from
  // external ones (Virtuoso API, touch drag, etc.).
  let lastWritten: number | null = null;

  const getPos = () => (axis === 'x' ? node.scrollLeft : node.scrollTop);
  const setPos = (v: number) => {
    lastWritten = v;
    if (axis === 'x') node.scrollLeft = v;
    else node.scrollTop = v;
  };
  const getMax = () =>
    axis === 'x' ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
  const canScroll = () =>
    axis === 'x' ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight;
  const pageSize = () => (axis === 'x' ? node.clientWidth : node.clientHeight);
  const clamp = (v: number) => Math.max(0, Math.min(getMax(), v));

  // Round to a device-pixel boundary. At fractional display scales (e.g. 175%
  // => devicePixelRatio 1.75) an integer CSS pixel is still a fractional
  // physical pixel, which forces re-rasterization every frame and causes jank
  // when scrolling past heavy content.
  const roundToDevicePixel = (v: number) => {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(v * dpr) / dpr;
  };

  const stop = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    lastWritten = null;
    pos = target = getPos();
  };

  const tick = () => {
    const diff = target - pos;
    if (Math.abs(diff) < 0.4) {
      setPos(roundToDevicePixel(target));
      pos = target;
      raf = 0;
      return;
    }
    pos += diff * 0.22;
    setPos(roundToDevicePixel(pos));
    raf = requestAnimationFrame(tick);
  };

  const onWheel = (e: WheelEvent) => {
    if (!canScroll()) return;
    // Prefer the delta that matches our axis when significant; otherwise use
    // the larger of the two so mouse wheels (deltaY) still drive horizontal.
    let raw: number;
    if (axis === 'x') {
      raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    } else {
      raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    }
    if (raw === 0) return;
    // deltaMode: 1 = lines, 2 = pages. Normalize to pixels-ish.
    let scale = 1;
    if (e.deltaMode === 1) scale = 16;
    else if (e.deltaMode === 2) scale = pageSize();
    // If content grew (new messages) max can change mid-scroll — re-clamp.
    target = clamp(target + raw * scale);
    e.preventDefault();
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const onScroll = () => {
    const pos = getPos();
    // Our own setPos: position matches what we just wrote (allow 1px rounding).
    if (lastWritten !== null && Math.abs(pos - lastWritten) < 1.5) {
      lastWritten = null;
      return;
    }
    // External scroll (Virtuoso scrollTo, followOutput, touch/drag, scrollbar):
    // yield — cancel ease animation and adopt the real position as the new base.
    stop();
  };

  node.addEventListener('wheel', onWheel, { passive: false });
  node.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    stop();
    node.removeEventListener('wheel', onWheel);
    node.removeEventListener('scroll', onScroll);
  };
}
