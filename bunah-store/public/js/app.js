(function () {
  'use strict';
  var KEY = 'bunah_cart_v1';
  var nf = new Intl.NumberFormat('en-US');
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function write(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} badge(); }
  function badge() {
    var c = read(), n = c.length;
    $$('[data-cart-count]').forEach(function (el) { el.textContent = n; el.hidden = n === 0; });
  }
  function add(item) {
    var c = read();
    var ex = c.find(function (x) { return x.id === item.id; });
    if (ex) ex.amount = Number(ex.amount) + Number(item.amount); else c.push(item);
    write(c);
  }
  var toastTimer;
  function toast(msg) {
    var t = $('.toast'); if (!t) return;
    t.textContent = msg; t.hidden = false; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); t.hidden = true; }, 2600);
  }

  // ---- filters on home -------------------------------------------------------
  $$('[data-filter]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var f = btn.getAttribute('data-filter');
      $$('[data-filter]').forEach(function (b) { var on = b === btn; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on); });
      var shown = 0;
      $$('[data-opp-grid] .opp-card').forEach(function (card) {
        var ok = f === 'all' || card.getAttribute('data-category') === f;
        card.hidden = !ok; if (ok) shown++;
      });
      var e = $('[data-empty]'); if (e) e.hidden = shown > 0;
    });
  });

  // ---- quick add -------------------------------------------------------------
  $$('[data-quick-add]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      add({ id: btn.dataset.id, title: btn.dataset.title, amount: Number(btn.dataset.amount), image: btn.dataset.image });
      toast('أُضيفت «' + btn.dataset.title + '» إلى السلة');
    });
  });

  // ---- donate form (opportunity page) -----------------------------------------
  var form = $('[data-donate-form]');
  if (form) {
    var custom = form.querySelector('[name=custom]');
    custom.addEventListener('input', function () { if (custom.value) $$('[name=preset]', form).forEach(function (r) { r.checked = false; }); });
    $$('[name=preset]', form).forEach(function (r) { r.addEventListener('change', function () { custom.value = ''; }); });
    function amount() {
      var v = custom.value ? Number(custom.value) : Number((form.querySelector('[name=preset]:checked') || {}).value);
      return Math.floor(v || 0);
    }
    function validate() {
      var err = form.querySelector('[data-error]'); var a = amount(); var max = Number(form.dataset.max) || 0;
      var msg = '';
      if (a < 10) msg = 'الحد الأدنى للتبرع 10 ريال.';
      else if (max > 0 && a > max) msg = 'المبلغ أكبر من المتبقي لهذه الفرصة (' + nf.format(max) + ' ريال).';
      err.textContent = msg; err.hidden = !msg; return !msg;
    }
    function item() { return { id: form.dataset.id, title: form.dataset.title, amount: amount(), image: form.dataset.image }; }
    form.addEventListener('submit', function (e) {
      e.preventDefault(); if (!validate()) return;
      add(item()); location.href = '/cart';
    });
    form.querySelector('[data-action=add]').addEventListener('click', function () {
      if (!validate()) return; add(item()); toast('أُضيف تبرعك إلى السلة');
    });
  }

  // ---- gallery ---------------------------------------------------------------
  var g = $('[data-gallery]');
  if (g) $$('.gallery-thumbs button', g).forEach(function (b) {
    b.addEventListener('click', function () {
      $('.gallery-main', g).src = b.dataset.src;
      $$('.gallery-thumbs button', g).forEach(function (x) { x.classList.toggle('is-on', x === b); });
    });
  });

  // ---- copy helpers ----------------------------------------------------------
  function copy(text, label) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(label || 'تم النسخ'); }, function () { toast(text); });
  }
  $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copy(b.dataset.copy); }); });
  $$('[data-copy-link]').forEach(function (b) { b.addEventListener('click', function () { copy(location.href, 'تم نسخ رابط الفرصة'); }); });
  $$('[data-share]').forEach(function (a) { a.href = a.href + encodeURIComponent(' ' + location.href); });

  // ---- cart page -------------------------------------------------------------
  var list = $('[data-cart-items]');
  var checkout = $('[data-checkout-form]');
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function renderCart(live) {
    var c = read();
    var byId = {}; (live || []).forEach(function (o) { byId[o.id] = o; });
    if (live) {
      // drop items that are no longer available, clamp to remaining
      c = c.filter(function (x) { var o = byId[x.id]; return o && o.status === 'active' && !o.completed; }).map(function (x) {
        var o = byId[x.id]; if (o.target > 0 && x.amount > o.remaining) x.amount = o.remaining;
        x.title = o.title; x.image = o.image || x.image; x.slug = o.slug; return x;
      });
      write(c);
    }
    $('[data-cart-empty]').hidden = c.length > 0;
    checkout.hidden = c.length === 0;
    list.innerHTML = c.map(function (x, i) {
      return '<div class="cart-item">' +
        (x.image ? '<img src="' + esc(x.image) + '" alt="">' : '<span class="ph"></span>') +
        '<div class="ci-body"><a href="/o/' + esc(x.slug || '') + '"><b>' + esc(x.title) + '</b></a>' +
        '<label class="ci-amount"><span>المبلغ</span><div class="input-suffix"><input type="number" min="10" step="1" inputmode="numeric" value="' + Number(x.amount) + '" data-i="' + i + '"><em>ر.س</em></div></label></div>' +
        '<button type="button" class="ci-remove" data-remove="' + i + '" aria-label="إزالة ' + esc(x.title) + '">حذف</button></div>';
    }).join('');
    total();
  }
  function total() {
    var t = read().reduce(function (a, b) { return a + (Number(b.amount) || 0); }, 0);
    var el = $('[data-cart-total]'); if (el) el.textContent = nf.format(t);
  }
  if (list && checkout) {
    renderCart();
    fetch('/api/opportunities').then(function (r) { return r.json(); }).then(renderCart).catch(function () {});
    list.addEventListener('input', function (e) {
      var i = e.target.getAttribute('data-i'); if (i == null) return;
      var c = read(); c[i].amount = Math.floor(Number(e.target.value) || 0); write(c); total();
    });
    list.addEventListener('click', function (e) {
      var i = e.target.getAttribute('data-remove'); if (i == null) return;
      var c = read(); c.splice(Number(i), 1); write(c); renderCart();
    });
    checkout.addEventListener('submit', function (e) {
      var c = read(); var min = Number(checkout.dataset.min) || 10;
      var bad = c.find(function (x) { return !(x.amount >= min); });
      var err = checkout.querySelector('[data-error]');
      if (!c.length || bad) { e.preventDefault(); err.textContent = 'الحد الأدنى لكل تبرع ' + min + ' ريال.'; err.hidden = false; return; }
      checkout.querySelector('[data-items-field]').value = JSON.stringify(c.map(function (x) { return { id: x.id, amount: x.amount }; }));
      checkout.querySelector('[data-checkout-btn]').disabled = true;
    });
  }

  // ---- clear cart after a completed order ------------------------------------
  if ($('[data-clear-cart]')) write([]);
  badge();
})();
