window.T = {
  async wait(predicate) {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${predicate.toString()}\n${document.body.innerText.slice(-1800)}`);
  },
  key(key, options = {}) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  },
  click(text, scope = 'body') {
    const el = [...document.querySelector(scope).querySelectorAll('button,[role=radio]')]
      .find(el => el.textContent.trim() === text || el.getAttribute('aria-label') === text);
    if (!el) throw new Error(`Missing control: ${text}`);
    el.click();
  },
  fill(el, text) {
    if (!el) throw new Error('Missing editor');
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  async dragGroup(id) {
    const title = document.querySelector(`[data-region="${id}"] .rl-focus`);
    const vp = document.querySelector('.map-viewport');
    const rect = title.getBoundingClientRect();
    const event = (target, type, dx, dy) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 101, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: rect.x + 20 + dx, clientY: rect.y + 8 + dy, bubbles: true, cancelable: true,
    }));
    event(title, 'pointerdown', 0, 0);
    for (let i = 1; i <= 14; i++) {
      event(vp, 'pointermove', i * 400 / 14, i * 250 / 14);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    event(vp, 'pointerup', 400, 250);
  },
  async dropImage() {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 150;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2e7d6b'; ctx.fillRect(0, 0, 240, 150);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
    const el = document.querySelector('.wp-reply .reply-box');
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  },
};
