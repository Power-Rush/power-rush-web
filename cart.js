/* ===========================================================================
   POWER RUSH — Carrito compartido (drawer + estado en localStorage)
   Se incluye en index.html y product.html con: <script src="cart.js" defer></script>
   Inyecta sus propios estilos y el drawer, así hay una sola fuente de verdad.
   El handoff a Shopify se activa cargando SHOPIFY.domain + variants (ver checkout()).
   =========================================================================== */
(function () {
  'use strict';

  /* ---- Config de negocio ------------------------------------------------- */
  var FREE_SHIP_QTY = 2;                 // envío gratis desde 2 potes (es por cantidad, no por monto)
  var KEY = 'pr_cart_v2';
  var ORDER = ['bf', 'cp'];
  var PRODUCTS = {
    bf: { id: 'bf', flavor: 'Blue Fizz', sub: '30 porciones', img: '/assets/blue-fizz.png' },
    cp: { id: 'cp', flavor: 'Cherry Pop', sub: '30 porciones', img: '/assets/cherry-pop.png' }
  };
  /* Backend Shopify (headless). El token de Storefront es público por diseño:
     solo deja leer catálogo y armar carritos, nunca administrar la tienda. */
  var SHOPIFY = {
    domain: '6q1n8a-jw.myshopify.com',
    token: '86f826b1c8e239cacd6e97100784c83f',
    api: '2026-01',
    checkoutHost: 'checkout.powerrush.com.ar',
    variants: {
      bf: 'gid://shopify/ProductVariant/50221562495224',
      cp: 'gid://shopify/ProductVariant/50221562462456'
    }
  };

  /* Catálogo vivo: precio, stock e imágenes reales leídos de Shopify al cargar.
     Hasta que responde (o si falla, o si la tienda no tiene precios cargados),
     la página sigue con los valores locales de fallback. */
  var LIVE = { ready: false, stock: {} }; // stock[id] = { avail: bool, qty: number|null }

  function gql(query, cb, variables) {
    try {
      fetch('https://' + SHOPIFY.domain + '/api/' + SHOPIFY.api + '/graphql.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY.token },
        body: JSON.stringify({ query: query, variables: variables || {} })
      }).then(function (r) { return r.json(); }).then(cb).catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }

  /* ---- Estado ------------------------------------------------------------ */
  var state = load();
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function qtyOf(id) { return state[id] || 0; }
  /* Stock: null = sin límite conocido (Shopify no lo trackea o todavía no respondió) */
  function stockOf(id) { var s = LIVE.stock[id]; return s && s.qty != null ? s.qty : null; }
  function soldOut(id) { var s = LIVE.stock[id]; return !!s && s.avail === false; }
  function maxFor(id) { var q = stockOf(id); return q == null ? Infinity : q; }
  function totalQty() { var s = 0; ORDER.forEach(function (id) { s += qtyOf(id); }); return s; }
  /* Precio y descuentos del test A/B: salen de /ab.js (window.PR_AB), que fija el grupo del
     visitante antes de que cargue la página. Sin ab.js: precio de Shopify, sin descuento. */
  function AB() { return window.PR_AB || null; }
  function base() { var ab = AB(); return ab ? ab.precio : (PRODUCTS.bf.price || PRODUCTS.cp.price || 0); }
  function variante(id) { var ab = AB(); return (ab && ab.variantes[id]) || SHOPIFY.variants[id]; }
  function track(evento, datos) { var ab = AB(); if (ab) ab.track(evento, datos); }
  function discPct(tq) { tq = (tq == null) ? totalQty() : tq; var ab = AB(); return ab ? ab.pct(tq) : 0; }
  function subtotal(tq) { tq = (tq == null) ? totalQty() : tq; var ab = AB(); return ab ? ab.total(tq) : base() * tq; }
  function unitPrice(tq) { tq = (tq == null) ? totalQty() : tq; return tq > 0 ? subtotal(tq) / tq : base(); }
  function baseTotal() { return base() * totalQty(); }
  function savings() { return baseTotal() - subtotal(); }
  function savePct() { var b = baseTotal(); return b > 0 ? Math.round(savings() / b * 100) : 0; }
  function money(n) { var ab = AB(); return ab ? ab.money(n) : '$' + Math.round(n).toLocaleString('es-AR'); }
  // próximo escalón de beneficio: qué desbloquea sumar 1 pote más
  function nextTier() {
    var tq = totalQty();
    if (tq >= 3) return null;                              // máximo descuento alcanzado
    if (tq === 2) return { pct: 15, ship: false };         // 3 potes → −15%
    return { pct: 10, ship: true };                        // 2 potes → −10% + envío gratis
  }

  /* ---- Acciones ---------------------------------------------------------- */
  function add(id, q, origen) {
    if (!PRODUCTS[id] || soldOut(id)) return;
    q = q || 1;
    setQty(id, qtyOf(id) + q);
    track('agregar_carrito', { sabor: id, cantidad: q, detalle: origen || 'pagina' });
    open(); pulse();
  }
  function setQty(id, q) {
    var max = maxFor(id);
    if (q > max) q = max;                                  // nunca por encima del stock real
    if (q <= 0) { delete state[id]; } else { state[id] = q; }
    save(); render();
  }
  function remove(id) { delete state[id]; save(); render(); }

  /* ---- Drawer / DOM ------------------------------------------------------ */
  var overlay, drawer, body, ship, foot;

  function buildShell() {
    var style = document.createElement('style');
    style.id = 'pr-cart-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.className = 'pr-cart-overlay';
    overlay.addEventListener('click', close);

    drawer = document.createElement('aside');
    drawer.className = 'pr-cart';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Tu carrito');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML =
      '<header class="pr-cart-head">' +
        '<span class="pr-cart-title">Tu carrito <span class="pr-cart-hc" data-pr-headcount></span></span>' +
        '<button class="pr-cart-close" data-pr-close aria-label="Cerrar carrito">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
        '</button>' +
      '</header>' +
      '<div class="pr-ship" data-pr-ship></div>' +
      '<div class="pr-cart-body" data-pr-body></div>' +
      '<div class="pr-cart-foot" data-pr-foot></div>';

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    body = drawer.querySelector('[data-pr-body]');
    ship = drawer.querySelector('[data-pr-ship]');
    foot = drawer.querySelector('[data-pr-foot]');

    drawer.addEventListener('click', onDrawerClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.classList.contains('open')) close(); });
  }

  function onDrawerClick(e) {
    var t = e.target;
    if (t.closest('[data-pr-close]')) { close(); return; }
    if (t.closest('[data-pr-checkout]')) { checkout(); return; }
    var inc = t.closest('[data-pr-inc]'); if (inc) { var i = inc.getAttribute('data-pr-inc'); setQty(i, qtyOf(i) + 1); return; }
    var dec = t.closest('[data-pr-dec]'); if (dec) { var d = dec.getAttribute('data-pr-dec'); setQty(d, qtyOf(d) - 1); return; }
    var rm = t.closest('[data-pr-remove]'); if (rm) { remove(rm.getAttribute('data-pr-remove')); return; }
    // [data-pr-add] dentro del drawer lo maneja el listener global (abajo).
  }

  /* ---- Render ------------------------------------------------------------ */
  function render() {
    var tq = totalQty();
    updateBadges(tq);
    var hc = drawer.querySelector('[data-pr-headcount]');
    hc.textContent = tq ? '· ' + tq : '';

    if (tq === 0) {
      ship.style.display = 'none';
      foot.style.display = 'none';
      body.innerHTML =
        '<div class="pr-empty">' +
          '<div class="pr-empty-ic"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg></div>' +
          '<p class="pr-empty-t">Tu carrito está vacío</p>' +
          '<span class="pr-empty-s">Sumá un pote y arrancá la sesión.</span>' +
          '<div class="pr-add-grid">' + ORDER.map(addCard).join('') + '</div>' +
        '</div>';
      return;
    }

    ship.style.display = '';
    foot.style.display = '';

    /* barra de envío gratis */
    var sub = subtotal();
    var faltan = Math.max(0, FREE_SHIP_QTY - tq);
    var freeShip = faltan === 0;
    var pct = Math.max(6, Math.min(100, Math.round(tq / FREE_SHIP_QTY * 100)));
    ship.className = 'pr-ship' + (freeShip ? ' done' : '');
    ship.innerHTML =
      '<div class="pr-ship-msg">' +
        (faltan > 0
          ? 'Sumá <b>' + faltan + (faltan === 1 ? ' pote' : ' potes') + ' más</b> y tenés <b>envío gratis</b>'
          : '<span class="pr-ship-on">✓ ¡Envío gratis desbloqueado!</span>') +
      '</div>' +
      '<div class="pr-ship-track"><div class="pr-ship-fill" style="width:' + pct + '%"></div></div>';

    /* items */
    var unit = unitPrice(tq);
    var disc = discPct();
    var itemsHtml = ORDER.filter(function (id) { return qtyOf(id) > 0; }).map(function (id) {
      var p = PRODUCTS[id], q = qtyOf(id);
      return (
        '<div class="pr-item">' +
          '<div class="pr-item-thumb"><img src="' + p.img + '" alt=""></div>' +
          '<div class="pr-item-mid">' +
            '<div class="pr-item-name">Power Rush · ' + p.flavor + '</div>' +
            '<div class="pr-item-sub">' + p.sub + '</div>' +
            '<div class="pr-item-unit">' + money(unit) + ' c/u' + (disc ? ' <span class="pr-tag">−' + disc + '%</span>' : '') + '</div>' +
            '<button class="pr-item-rm" data-pr-remove="' + id + '">Quitar</button>' +
          '</div>' +
          '<div class="pr-item-end">' +
            '<div class="pr-stepper">' +
              '<button data-pr-dec="' + id + '" aria-label="Quitar uno">−</button>' +
              '<span>' + q + '</span>' +
              '<button data-pr-inc="' + id + '" aria-label="Sumar uno">+</button>' +
            '</div>' +
            '<div class="pr-item-total">' + money(unit * q) + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    /* upsell — "subí de nivel": motiva con el beneficio exacto, mismo u otro sabor */
    var tier = nextTier();
    var upsell = '';
    if (tier) {
      var benefit = tier.ship
        ? '<b>−' + tier.pct + '% + envío gratis</b>'
        : '<b>−' + tier.pct + '% de descuento</b>';
      var bolt = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/></svg>';
      upsell =
        '<div class="pr-reward">' +
          '<div class="pr-reward-head">' + bolt + '<span>Sumá <b>1 pote más</b> y activás ' + benefit + ' — del mismo o de otro sabor.</span></div>' +
          '<div class="pr-reward-grid">' +
            ORDER.map(function (id) {
              var p = PRODUCTS[id];
              return (
                '<button class="pr-radd" data-pr-add="' + id + '">' +
                  '<img src="' + p.img + '" alt="">' +
                  '<span class="pr-radd-name">' + p.flavor + '</span>' +
                  '<span class="pr-radd-plus">+1 pote</span>' +
                '</button>'
              );
            }).join('') +
          '</div>' +
        '</div>';
    } else {
      upsell =
        '<div class="pr-maxed">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
          'Máximo descuento activado · −15%' +
        '</div>';
    }

    body.innerHTML = itemsHtml + upsell;

    /* footer — detalle del pedido + subtotal con ahorro */
    var base = baseTotal();
    var sav = savings();
    var sPct = savePct();
    foot.innerHTML =
      '<div class="pr-detail">' +
        '<div class="pr-detail-h">Detalle del pedido</div>' +
        '<div class="pr-drow"><span>Productos · ' + tq + (tq === 1 ? ' pote' : ' potes') + '</span><span>' + money(base) + '</span></div>' +
        (disc ? '<div class="pr-drow pr-drow-g"><span>Descuento por cantidad (−' + disc + '%)</span><span>−' + money(sav) + '</span></div>' : '') +
        '<div class="pr-drow"><span>Envío' + (freeShip ? ' <span class="pr-tag">Promo</span>' : '') + '</span>' +
          (freeShip ? '<span class="pr-drow-g2">GRATIS</span>' : '<span class="pr-muted">A calcular</span>') + '</div>' +
      '</div>' +
      '<div class="pr-summary">' +
        '<span class="pr-sum-l">Subtotal' + (sPct > 0 ? ' <span class="pr-save-pill">Ahorrás ' + sPct + '%</span>' : '') + '</span>' +
        '<span class="pr-sum-r">' + (sav > 0 ? '<s>' + money(base) + '</s> ' : '') + '<b>' + money(sub) + '</b></span>' +
      '</div>' +
      '<div class="pr-foot-note">IVA incluido</div>' +
      '<button class="pr-checkout" data-pr-checkout>Comprar</button>' +
      '<div class="pr-trust">' +
        '<span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> 30 días de garantía</span>' +
        '<span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Pago seguro</span>' +
      '</div>';
  }

  function addCard(id) {
    var p = PRODUCTS[id];
    return (
      '<button class="pr-add-card" data-pr-add="' + id + '">' +
        '<img src="' + p.img + '" alt="">' +
        '<span class="pr-add-name">' + p.flavor + '</span>' +
        '<span class="pr-add-plus">+ Agregar</span>' +
      '</button>'
    );
  }

  /* ---- Badges del nav ---------------------------------------------------- */
  function updateBadges(tq) {
    tq = (tq == null) ? totalQty() : tq;
    var nodes = document.querySelectorAll('[data-pr-count]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = tq;
      if (tq > 0) nodes[i].removeAttribute('hidden'); else nodes[i].setAttribute('hidden', '');
    }
  }
  function pulse() {
    var btns = document.querySelectorAll('.pr-cart-btn');
    for (var i = 0; i < btns.length; i++) {
      (function (b) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); })(btns[i]);
    }
  }

  /* ---- Open / close ------------------------------------------------------ */
  function open() {
    overlay.classList.add('open');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var c = drawer.querySelector('[data-pr-close]');
    setTimeout(function () { if (c) c.focus(); }, 60);
  }
  function close() {
    overlay.classList.remove('open');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  /* ---- Checkout ----------------------------------------------------------
     Arma un carrito en Shopify con la Cart API y manda al checkout propio
     (checkout.powerrush.com.ar). El cupón del juego, si hay, viaja aplicado. */
  var DISCOUNT_KEY = 'pr_discount';
  function discountCode() { try { return localStorage.getItem(DISCOUNT_KEY) || ''; } catch (e) { return ''; } }

  function checkout() {
    if (totalQty() === 0 || checkout.busy) return;
    var btn = foot.querySelector('[data-pr-checkout]');
    checkout.busy = true;
    if (btn) { btn.classList.add('loading'); btn.textContent = 'Preparando tu pedido…'; }
    track('clic_comprar', { cantidad: totalQty(), valor: subtotal() });

    var input = {
      lines: ORDER.filter(function (id) { return qtyOf(id) > 0 && variante(id); })
        .map(function (id) { return { merchandiseId: variante(id), quantity: qtyOf(id) }; }),
      attributes: AB() ? AB().atributos() : []
    };
    var code = discountCode();
    if (code) input.discountCodes = [code];

    gql('mutation Crear($input: CartInput!){cartCreate(input:$input){cart{checkoutUrl} userErrors{message}}}', function (res) {
      var data = res && res.data && res.data.cartCreate;
      var url = data && data.cart && data.cart.checkoutUrl;
      if (url) { window.location.href = url; return; }
      track('error_checkout', {
        detalle: data && data.userErrors && data.userErrors.length
          ? data.userErrors.map(function (u) { return u.message; }).join('; ')
          : 'sin respuesta de Shopify'
      });
      checkout.busy = false;
      if (btn) { btn.classList.remove('loading'); btn.textContent = 'Comprar'; }
      alert('No pudimos abrir el checkout. Probá de nuevo en unos segundos.');
    }, { input: input });
  }

  /* ---- Sync con Shopify: precio, stock e imágenes ------------------------ */
  function syncCatalog() {
    var ids = [];
    ORDER.forEach(function (id) {
      if (SHOPIFY.variants[id]) ids.push(SHOPIFY.variants[id]);
      if (variante(id) && ids.indexOf(variante(id)) < 0) ids.push(variante(id));
    });
    if (!ids.length) return;

    gql('query Catalogo($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id availableForSale quantityAvailable price{amount} image{url}}}}', function (res) {
      var nodes = res && res.data && res.data.nodes;
      if (!nodes) return;                                   // sin respuesta: se queda el fallback local
      var porId = {};
      nodes.forEach(function (n) { if (n && n.id) porId[n.id] = n; });
      revisarPrecios(porId);

      /* Stock y fotos salen siempre de las variantes originales: el pack comparte su
         stock y el duplicado no lo controla. */
      var priced = 0, found = [];
      ORDER.forEach(function (id) {
        var n = porId[SHOPIFY.variants[id]];
        if (!n) return;
        found.push({ id: id, n: n });
        var img = n.image && n.image.url;                   // solo la foto de la variante, no la del producto
        if (img) PRODUCTS[id].img = img + (img.indexOf('?') > -1 ? '&' : '?') + 'width=420';
        var amount = n.price && parseFloat(n.price.amount);
        if (amount > 0) { PRODUCTS[id].price = amount; priced++; }
      });

      /* Mientras la tienda no tenga precios cargados, no tomamos su stock como
         verdad: la página seguiría con todo "sin stock" por una config a medias. */
      if (!priced) { paintPhotos(); render(); return; }

      found.forEach(function (f) {
        LIVE.stock[f.id] = {
          avail: f.n.availableForSale !== false,
          qty: (typeof f.n.quantityAvailable === 'number' && f.n.quantityAvailable > 0) ? f.n.quantityAvailable : null
        };
      });

      LIVE.ready = true;
      ORDER.forEach(function (id) {                          // el carrito guardado no puede exceder el stock
        var max = maxFor(id);
        if (soldOut(id)) delete state[id];
        else if (qtyOf(id) > max) state[id] = max;
      });
      save();
      paintStock();
      render();
    }, { ids: ids });
  }

  /* Lo que cobra Shopify tiene que ser el precio del grupo; si no, la config del test está mal. */
  function revisarPrecios(porId) {
    var ab = AB();
    if (!ab) return;
    ORDER.forEach(function (id) {
      var n = porId[variante(id)];
      var amount = n && n.price && parseFloat(n.price.amount);
      if (amount > 0 && Math.abs(amount - ab.precio) > 0.005) {
        track('error_precio', { sabor: id, valor: amount, detalle: 'Shopify $' + amount + ' / config $' + ab.precio + ' (grupo ' + ab.grupo + ')' });
      }
    });
  }

  /* Fotos tal como están cargadas en Shopify. Los precios los pinta /ab.js. */
  function paintPhotos() {

    var im = document.querySelectorAll('[data-pr-photo]');
    for (var k = 0; k < im.length; k++) {
      var pid = im[k].getAttribute('data-pr-photo');
      if (PRODUCTS[pid] && PRODUCTS[pid].img) im[k].src = PRODUCTS[pid].img;
    }
  }

  /* Marca agotados en la página y avisa al resto del sitio. */
  function paintStock() {
    paintPhotos();
    ORDER.forEach(function (id) {
      var out = soldOut(id);
      var nodes = document.querySelectorAll('[data-pr-add="' + id + '"]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        el.classList.toggle('pr-out', out);
        if (out) { el.setAttribute('aria-disabled', 'true'); if (!el.dataset.prLabel) el.dataset.prLabel = el.textContent.trim(); }
        else el.removeAttribute('aria-disabled');
      }
      var flags = document.querySelectorAll('[data-pr-stock="' + id + '"]');
      for (var j = 0; j < flags.length; j++) {
        var q = stockOf(id);
        flags[j].textContent = out ? 'Sin stock' : (q != null && q <= 12 ? 'Quedan ' + q : '');
        flags[j].classList.toggle('pr-out-txt', out);
      }
    });
    try {
      document.dispatchEvent(new CustomEvent('pr:catalog', { detail: { stock: LIVE.stock, products: PRODUCTS, base: base() } }));
    } catch (e) {}
  }

  /* ---- Wiring global de botones de "agregar" / "abrir" ------------------- */
  document.addEventListener('click', function (e) {
    var addEl = e.target.closest('[data-pr-add]');
    if (addEl) {
      e.preventDefault();
      add(addEl.getAttribute('data-pr-add'), parseInt(addEl.getAttribute('data-pr-qty'), 10) || 1,
        drawer && drawer.contains(addEl) ? 'carrito' : 'pagina');
      return;
    }
    var openEl = e.target.closest('[data-pr-open]');
    if (openEl) { e.preventDefault(); open(); track('abrir_carrito'); }
  });

  /* ---- API pública ------------------------------------------------------- */
  window.PowerCart = {
    add: add, open: open, close: close, remove: remove,
    setQty: setQty, count: totalQty, subtotal: subtotal,
    unitPrice: unitPrice, money: money,
    stock: function (id) { return LIVE.stock[id] || null; },
    soldOut: soldOut, products: PRODUCTS, live: function () { return LIVE.ready; },
    setDiscount: function (c) { try { localStorage.setItem(DISCOUNT_KEY, c || ''); } catch (e) {} },
    refresh: syncCatalog
  };

  /* ---- Init -------------------------------------------------------------- */
  function init() { buildShell(); render(); syncCatalog(); }

  /* ---- Estilos ----------------------------------------------------------- */
  var CSS = [
    '.pr-cart-overlay{position:fixed;inset:0;background:rgba(4,6,4,.66);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);opacity:0;visibility:hidden;transition:opacity .35s ease,visibility .35s;z-index:2000;}',
    '.pr-cart-overlay.open{opacity:1;visibility:visible;}',
    '.pr-cart{position:fixed;top:0;right:0;height:100%;width:418px;max-width:92vw;display:flex;flex-direction:column;background:var(--bg,#080A08);border-left:1px solid var(--border,rgba(0,212,122,.16));transform:translateX(102%);transition:transform .42s cubic-bezier(.23,1,.32,1);z-index:2001;box-shadow:-34px 0 70px -22px rgba(0,0,0,.78);font-family:var(--bd,"Bricolage Grotesque",system-ui,sans-serif);color:var(--white,#EEF5EE);}',
    '.pr-cart.open{transform:none;}',
    '.pr-cart *,.pr-cart *::before,.pr-cart *::after{box-sizing:border-box;}',
    '.pr-cart button{font-family:inherit;color:inherit;cursor:pointer;}',
    '.pr-cart-head{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--border,rgba(0,212,122,.16));flex:none;}',
    '.pr-cart-title{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:900;font-style:italic;font-size:23px;text-transform:uppercase;letter-spacing:-.3px;}',
    '.pr-cart-hc{color:var(--green,#00D47A);}',
    '.pr-cart-close{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--border,rgba(0,212,122,.16));border-radius:9px;background:transparent;color:var(--gray,#56685A);transition:color .2s,border-color .2s,background .2s;}',
    '.pr-cart-close:hover{color:var(--white,#EEF5EE);border-color:rgba(0,212,122,.4);}',
    '.pr-cart-close:focus-visible{outline:2px solid var(--green,#00D47A);outline-offset:2px;}',
    /* envío */
    '.pr-ship{padding:15px 22px;border-bottom:1px solid var(--border,rgba(0,212,122,.16));flex:none;}',
    '.pr-ship-msg{font-size:12.5px;color:rgba(238,245,238,.78);margin-bottom:9px;letter-spacing:.1px;}',
    '.pr-ship-msg b{color:var(--green,#00D47A);font-weight:700;}',
    '.pr-ship-on{color:var(--green,#00D47A);font-weight:700;font-family:var(--mo,"Space Mono",monospace);font-size:12px;letter-spacing:.5px;}',
    '.pr-ship-track{height:6px;border-radius:6px;background:rgba(255,255,255,.06);overflow:hidden;}',
    '.pr-ship-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--green,#00D47A),var(--yellow,#FFD100));box-shadow:0 0 12px rgba(0,212,122,.5);transition:width .55s cubic-bezier(.23,1,.32,1);}',
    /* body */
    '.pr-cart-body{flex:1;overflow-y:auto;padding:6px 22px 10px;}',
    '.pr-cart-body::-webkit-scrollbar{width:8px;}',
    '.pr-cart-body::-webkit-scrollbar-thumb{background:rgba(0,212,122,.18);border-radius:8px;}',
    /* item */
    '.pr-item{display:flex;gap:13px;padding:18px 0;border-bottom:1px solid var(--border,rgba(0,212,122,.12));}',
    '.pr-item-thumb{flex:none;width:106px;height:106px;border:1px solid var(--border,rgba(0,212,122,.16));border-radius:12px;background:var(--bg2,#0C100C);display:grid;place-items:center;overflow:hidden;}',
    '.pr-item-thumb img{width:96%;height:96%;object-fit:contain;}',
    '.pr-item-mid{flex:1;min-width:0;}',
    '.pr-item-name{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:16px;text-transform:uppercase;letter-spacing:.1px;line-height:1.05;}',
    '.pr-item-sub{font-size:11px;color:var(--gray,#56685A);margin-top:3px;font-family:var(--mo,"Space Mono",monospace);letter-spacing:1px;text-transform:uppercase;}',
    '.pr-item-unit{font-size:12.5px;color:rgba(238,245,238,.66);margin-top:7px;}',
    '.pr-tag{display:inline-block;font-family:var(--mo,"Space Mono",monospace);font-size:9px;font-weight:700;color:var(--green,#00D47A);background:rgba(0,212,122,.12);border:1px solid var(--border,rgba(0,212,122,.16));border-radius:30px;padding:2px 7px;letter-spacing:.5px;vertical-align:middle;}',
    '.pr-item-rm{margin-top:9px;background:none;border:none;padding:0;color:var(--gray,#56685A);font-size:11px;text-decoration:underline;text-underline-offset:2px;transition:color .2s;}',
    '.pr-item-rm:hover{color:var(--red,#FF3C3C);}',
    '.pr-item-end{display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:12px;}',
    '.pr-stepper{display:inline-flex;align-items:center;border:1px solid var(--border,rgba(0,212,122,.2));border-radius:9px;overflow:hidden;}',
    '.pr-stepper button{width:30px;height:30px;background:var(--bg2,#0C100C);border:none;color:var(--white,#EEF5EE);font-size:15px;line-height:1;transition:background .2s,color .2s;}',
    '.pr-stepper button:hover{background:var(--green,#00D47A);color:#04140C;}',
    '.pr-stepper span{min-width:30px;text-align:center;font-family:var(--mo,"Space Mono",monospace);font-size:13px;}',
    '.pr-item-total{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:17px;white-space:nowrap;}',
    /* subí de nivel (reward) */
    '.pr-reward{margin-top:18px;border:1px solid rgba(0,212,122,.3);border-radius:14px;background:linear-gradient(180deg,rgba(0,212,122,.08),rgba(0,212,122,.015));padding:14px;}',
    '.pr-reward-head{display:flex;align-items:flex-start;gap:9px;font-size:13px;color:rgba(238,245,238,.85);line-height:1.45;margin-bottom:13px;}',
    '.pr-reward-head svg{flex:none;color:var(--green,#00D47A);margin-top:1px;}',
    '.pr-reward-head b{color:var(--green,#00D47A);font-weight:700;}',
    '.pr-reward-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
    '.pr-radd{display:flex;flex-direction:column;align-items:center;gap:6px;padding:13px 8px;border:1px solid var(--border,rgba(0,212,122,.16));border-radius:11px;background:var(--bg,#080A08);transition:border-color .2s,transform .2s,background .2s;}',
    '.pr-radd:hover{border-color:rgba(0,212,122,.5);transform:translateY(-2px);background:var(--bg3,#111511);}',
    '.pr-radd img{width:96px;height:96px;object-fit:contain;}',
    '.pr-radd-name{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:13px;text-transform:uppercase;text-align:center;line-height:1;}',
    '.pr-radd-plus{font-family:var(--mo,"Space Mono",monospace);font-size:10px;color:var(--green,#00D47A);letter-spacing:1px;text-transform:uppercase;}',
    '.pr-maxed{margin-top:18px;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border:1px dashed rgba(0,212,122,.32);border-radius:12px;background:rgba(0,212,122,.04);font-family:var(--mo,"Space Mono",monospace);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--green,#00D47A);}',
    /* detalle del pedido */
    '.pr-detail{border:1px solid var(--border,rgba(0,212,122,.16));border-radius:12px;padding:13px 14px 8px;margin-bottom:14px;background:var(--bg,#080A08);}',
    '.pr-detail-h{font-family:var(--mo,"Space Mono",monospace);font-size:9.5px;letter-spacing:2px;text-transform:uppercase;color:var(--gray,#56685A);margin-bottom:9px;}',
    '.pr-drow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;font-size:12.5px;color:rgba(238,245,238,.72);}',
    '.pr-drow span:last-child{font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.pr-drow.pr-drow-g,.pr-drow.pr-drow-g span{color:var(--green,#00D47A);}',
    '.pr-drow-g2{color:var(--green,#00D47A);font-weight:700;font-family:var(--mo,"Space Mono",monospace);font-size:11px;letter-spacing:.5px;}',
    '.pr-muted{color:var(--gray,#56685A);}',
    /* empty */
    '.pr-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:52px 6px 34px;}',
    '.pr-empty-ic{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;border:1px solid var(--border,rgba(0,212,122,.2));color:var(--green,#00D47A);margin-bottom:20px;}',
    '.pr-empty-t{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:900;font-style:italic;font-size:26px;text-transform:uppercase;letter-spacing:-.3px;margin:0 0 6px;line-height:1;}',
    '.pr-empty-s{font-size:13.5px;color:rgba(238,245,238,.92);margin-bottom:30px;line-height:1.7;max-width:240px;}',
    '.pr-add-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;}',
    '.pr-add-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 12px 16px;border:1px solid var(--border,rgba(0,212,122,.16));border-radius:14px;background:var(--bg2,#0C100C);transition:border-color .25s,transform .25s,background .25s;}',
    '.pr-add-card:hover{border-color:rgba(0,212,122,.45);transform:translateY(-3px);background:var(--bg3,#111511);}',
    '.pr-add-card img{width:118px;height:118px;object-fit:contain;filter:drop-shadow(0 8px 18px rgba(0,0,0,.5));}',
    '.pr-add-name{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.2px;}',
    '.pr-add-plus{display:inline-block;font-family:var(--mo,"Space Mono",monospace);font-size:10px;color:var(--green,#00D47A);letter-spacing:1px;text-transform:uppercase;border:1px solid rgba(0,212,122,.32);border-radius:30px;padding:5px 12px;}',
    /* footer */
    '.pr-cart-foot{flex:none;padding:16px 22px 20px;border-top:1px solid var(--border,rgba(0,212,122,.16));background:var(--bg2,#0C100C);}',
    '.pr-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:3px;}',
    '.pr-sum-l{font-size:13px;color:rgba(238,245,238,.7);display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;}',
    '.pr-save-pill{display:inline-block;font-family:var(--mo,"Space Mono",monospace);font-size:9px;font-weight:700;color:#04140C;background:var(--green,#00D47A);border-radius:30px;padding:3px 8px;letter-spacing:.3px;}',
    '.pr-sum-r{display:inline-flex;align-items:baseline;gap:7px;white-space:nowrap;}',
    '.pr-sum-r s{color:var(--gray,#56685A);font-size:15px;text-decoration-thickness:1px;}',
    '.pr-summary b{font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:26px;line-height:1;}',
    '.pr-foot-note{font-size:11px;color:var(--gray,#56685A);margin-bottom:14px;font-family:var(--mo,"Space Mono",monospace);letter-spacing:1px;text-transform:uppercase;}',
    '.pr-checkout{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;border:none;border-radius:12px;background:var(--green,#00D47A);color:#04140C;font-family:var(--hd,"Barlow Condensed",sans-serif);font-weight:700;font-size:18px;text-transform:uppercase;letter-spacing:1.5px;transition:transform .18s ease,box-shadow .25s ease,filter .2s;box-shadow:0 12px 30px -10px rgba(0,212,122,.55);}',
    '.pr-checkout:hover{transform:translateY(-2px);filter:brightness(1.05);box-shadow:0 18px 38px -10px rgba(0,212,122,.7);}',
    '.pr-checkout:active{transform:translateY(0);}',
    '.pr-checkout:focus-visible{outline:2px solid #fff;outline-offset:2px;}',
    '.pr-checkout.loading{pointer-events:none;filter:saturate(.5) brightness(.85);}',
    /* agotado — el stock lo dice Shopify */
    '.pr-out{opacity:.42;pointer-events:none;filter:grayscale(1);}',
    '.pr-out-txt{color:var(--red,#FF3C3C);}',
    '.pr-trust{display:flex;justify-content:center;gap:18px;margin-top:13px;}',
    '.pr-trust span{display:inline-flex;align-items:center;gap:5px;font-family:var(--mo,"Space Mono",monospace);font-size:9.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--gray,#56685A);}',
    '.pr-trust svg{color:var(--green,#00D47A);}',
    /* botón del nav */
    '.nav-actions{display:flex;align-items:center;gap:11px;}',
    '.pr-cart-btn{position:relative;display:inline-grid;place-items:center;width:40px;height:40px;border:1px solid var(--border,rgba(0,212,122,.16));border-radius:10px;background:transparent;color:var(--white,#EEF5EE);transition:border-color .2s,color .2s,background .2s;}',
    '.pr-cart-btn:hover{border-color:rgba(0,212,122,.45);color:var(--green,#00D47A);}',
    '.pr-cart-btn:focus-visible{outline:2px solid var(--green,#00D47A);outline-offset:2px;}',
    '.pr-cart-btn.pulse{animation:prPulse .45s ease;}',
    '@keyframes prPulse{0%{transform:scale(1);}40%{transform:scale(1.16);}100%{transform:scale(1);}}',
    '.pr-cart-count{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 5px;display:grid;place-items:center;border-radius:20px;background:var(--green,#00D47A);color:#04140C;font-family:var(--mo,"Space Mono",monospace);font-size:10px;font-weight:700;line-height:1;}',
    '.pr-cart-count[hidden]{display:none;}',
    '@media (max-width:520px){.pr-cart{width:100%;max-width:100%;}}',
    '@media (prefers-reduced-motion:reduce){.pr-cart,.pr-cart-overlay,.pr-ship-fill,.pr-checkout,.pr-add-card{transition:none;}.pr-cart-btn.pulse{animation:none;}}'
  ].join('');

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
