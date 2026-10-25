const test = require('node:test');
const assert = require('node:assert/strict');

function node() {
  const classes = new Set();
  return {
    children: [], parentNode: null, hidden: false, open: false, inert: false, scrollTop: 0,
    classList: {
      contains: value => classes.has(value),
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
    },
    append(...items) {
      for (const item of items) {
        item.remove();
        this.children.push(item);
        item.parentNode = this;
      }
    },
    prepend(item) { this.append(item); this.children.unshift(this.children.pop()); },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    },
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector(selector) {
      if (!this.selectors?.has(selector)) throw new Error(`Unexpected selector: ${selector}`);
      return this.selectors.get(selector);
    },
    querySelectorAll(selector) {
      if (!this.groups?.has(selector)) throw new Error(`Unexpected group: ${selector}`);
      return this.groups.get(selector);
    },
  };
}

function fixture() {
  const body = node(), profile = node(), admin = node(), overlay = node(), scroller = node();
  const nfts = node(), list = node(), section = node(), form = node(), approval = node(), mint = node(), queue = node();
  const editor = node(), review = node(), current = node(), other = node();
  body.append(profile, admin, overlay);
  profile.append(nfts, section, approval, other);
  section.append(form);
  admin.append(scroller);
  scroller.append(mint);
  mint.append(queue);
  list.append(node());
  nfts.hidden = true;
  profile.scrollTop = 47;
  scroller.scrollTop = 83;
  other.inert = true;
  admin.classList.add('hidden');
  mint.classList.add('hidden');
  profile.selectors = new Map([
    ['[data-my-nfts-section]', nfts], ['[data-song-section]', section],
    ['[data-song-split-form]', form], ['[data-split-approval]', approval],
  ]);
  profile.groups = new Map([[':scope > :not(dialog)', [nfts, section, approval, other]]]);
  admin.groups = new Map([['#admin-modal-inner > *', [mint]]]);
  nfts.selectors = new Map([['[data-my-nfts-items]', list]]);
  form.selectors = new Map([
    ['[data-song-split-editor]', editor], ['[data-song-split-review]', review], ['[data-song-split-current]', current],
  ]);
  form.draft = 'Keep my actual song settings and unsubmitted edits';
  const ids = new Map([
    ['creator-profile', profile], ['admin-modal', admin], ['admin-modal-inner', scroller],
    ['admin-mint-section', mint], ['admin-mint-queue', queue],
  ]);
  const document = { body, getElementById: id => ids.get(id), createElement: () => node() };
  return { body, profile, admin, overlay, scroller, nfts, section, form, approval, mint, queue, editor, review, current, other, document };
}

test('split guide opens actual panels and targets, preserving a loaded song and restoring UI on exit', async () => {
  const { createSplitTutorialSurfaces } = await import('../js/split-tutorial-surfaces.mjs');
  const f = fixture();
  const tour = createSplitTutorialSurfaces({ overlay: f.overlay, document: f.document });
  for (const [index, target] of [f.nfts, f.editor, f.review, f.approval, f.mint, f.current].entries()) {
    const hop = index + 1;
    assert.equal(tour.show(hop), target);
    assert.equal(f.profile.open, hop !== 5);
    assert.equal(f.overlay.parentNode, hop === 5 ? f.body : f.profile);
    assert.equal(f.admin.classList.contains('hidden'), hop !== 5);
  }
  assert.equal(f.form.draft, 'Keep my actual song settings and unsubmitted edits');
  assert.equal(f.queue.children.length, 1, 'owner queue gets only a disabled tutorial example');
  assert.equal(f.queue.children[0].children[1].disabled, true);
  f.profile.scrollTop = 900;
  f.scroller.scrollTop = 300;
  tour.close();
  assert.equal(f.overlay.parentNode, f.body);
  assert.equal(f.profile.open, false);
  assert.equal(f.nfts.hidden, true);
  assert.equal(f.nfts.open, false);
  assert.equal(f.section.open, false);
  assert.equal(f.profile.scrollTop, 47);
  assert.equal(f.scroller.scrollTop, 83);
  assert.equal(f.admin.classList.contains('hidden'), true);
  assert.equal(f.mint.classList.contains('hidden'), true);
  assert.equal(f.mint.open, false);
  assert.equal(f.nfts.inert, false);
  assert.equal(f.other.inert, true);
  assert.equal(f.queue.children.length, 0);
  assert.equal(f.form.draft, 'Keep my actual song settings and unsubmitted edits');
});

test('surface cleanup restores an already open profile even when leaving from the admin step', async () => {
  const { createSplitTutorialSurfaces } = await import('../js/split-tutorial-surfaces.mjs');
  const f = fixture();
  f.profile.open = true;
  const tour = createSplitTutorialSurfaces({ overlay: f.overlay, document: f.document });
  tour.show(5);
  assert.equal(f.profile.open, false);
  tour.close();
  assert.equal(f.profile.open, true);
  assert.equal(f.overlay.parentNode, f.body);
  tour.close();
});
