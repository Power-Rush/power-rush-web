/* ===========================================================================
   POWER RUSH — Reseñas reales desde Judge.me
   Se incluye en index.html y products/powerrush con: <script src="/reviews.js" defer></script>
   Lee el mismo JSON público que usa el widget de Judge.me (sin token, CORS
   abierto, cacheado 20 min en su CDN) y lo vuelca en el diseño propio:
     [data-rv-rating]  → promedio con un decimal ("4.6")
     [data-rv-count]   → total de reseñas ("738")
     [data-rv-cols]    → columnas de tarjetas que scrollean
                         data-rv-per-col="3" tarjetas por columna
                         data-rv-quotes  comillas en el texto (la PDP las pone por CSS)
     [data-rv-all]     → sección "Todas las reseñas" de la PDP: resumen con barras
                         por estrella (filtran), orden y "Ver más". Arranca oculta
                         y solo aparece si Judge.me respondió.
   Si Judge.me no responde, queda lo que ya está escrito en el HTML.
   Las reseñas fijadas (pin) en Judge.me salen primero; después, las más nuevas.
   =========================================================================== */
(function () {
  'use strict';

  var SHOP = '6q1n8a-jw.myshopify.com';
  var PRODUCT_ID = '10286359806200';                 // Power Rush en Shopify
  var BASE = 'https://api.judge.me/reviews/reviews_for_widget?platform=shopify' +
    '&shop_domain=' + SHOP + '&url=' + SHOP + '&product_id=' + PRODUCT_ID;
  var MAX_PAGES = 3;
  var COLORS = ['#00D47A', '#F97316', '#3B82F6', '#FFD100'];
  var TZ = 'America/Argentina/Buenos_Aires';         // fechas iguales para cualquier visitante

  function get(params, cb) {
    fetch(BASE + '&' + params)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(cb, function () { cb(null); });
  }

  /* El texto viene en HTML escrito por clientes: se pasa a texto plano en un
     documento inerte (DOMParser no ejecuta nada) y se escapa al pintarlo. */
  var parser = window.DOMParser ? new DOMParser() : null;
  function plain(html, keepBreaks) {
    html = String(html || '').replace(/<br\s*\/?>|<\/p>/gi, '\n');
    var t = parser ? parser.parseFromString(html, 'text/html').body.textContent : html.replace(/<[^>]+>/g, ' ');
    if (keepBreaks) return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    return t.replace(/\s+/g, ' ').trim();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Solo las que entran en una tarjeta del diseño: ni muy cortas ni muy largas,
     sin links y sin texto todo en mayúsculas. */
  function fits(t) {
    if (t.length < 60 || t.length > 240) return false;
    if (/https?:|www\./i.test(t)) return false;
    var letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    var upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
    return upper / Math.max(1, letters.length) < 0.5;
  }

  function firstName(r) {
    var n = r.is_anonymous_reviewer ? '' : String(r.reviewer_name || '').trim().split(/\s+/)[0];
    return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : 'Cliente';
  }
  // "Compra verificada" solo si Judge.me lo marca; si no, lugar y fecha reales
  function role(r) {
    var parts = [];
    if (r.verified_buyer) parts.push('Compra verificada');
    if (r.location) parts.push(r.location);
    var d = new Date(r.created_at);
    if (!isNaN(d)) parts.push(d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: TZ }));
    return parts.join(' · ');
  }

  function toCard(r, i) {
    var t = plain(r.body_html);
    return { text: t.charAt(0).toUpperCase() + t.slice(1), name: firstName(r), role: role(r), color: COLORS[i % COLORS.length] };
  }

  function cardHtml(c, quotes) {
    var t = quotes ? '"' + c.text + '"' : c.text;
    return '<div class="rev-card"><div class="rev-stars">★★★★★</div>' +
      '<p class="rev-text">' + esc(t) + '</p>' +
      '<div class="rev-author"><div class="rev-ava" style="background:' + c.color + ';">' + esc(c.name.charAt(0)) + '</div>' +
      '<div><div class="rev-name">' + esc(c.name) + '</div><div class="rev-role">' + esc(c.role) + '</div></div></div></div>';
  }

  function paintSummary(avg, count) {
    if (avg > 0) {
      var a = (Math.round(avg * 10) / 10).toFixed(1);
      [].forEach.call(document.querySelectorAll('[data-rv-rating]'), function (el) { el.textContent = a; });
    }
    if (count > 0) {
      var n = count.toLocaleString('es-AR');
      [].forEach.call(document.querySelectorAll('[data-rv-count]'), function (el) { el.textContent = n; });
    }
  }

  function paintCols(cards) {
    [].forEach.call(document.querySelectorAll('[data-rv-cols]'), function (box) {
      var per = parseInt(box.getAttribute('data-rv-per-col'), 10) || 3;
      if (cards.length < per * 3) return;                     // no alcanza para llenar: queda el fallback
      var quotes = box.hasAttribute('data-rv-quotes');
      var html = '';
      for (var ci = 0; ci < 3; ci++) {
        var set = cards.slice(ci * per, ci * per + per).map(function (c) { return cardHtml(c, quotes); }).join('');
        html += '<div class="rev-col"><div class="rev-col-inner">' + set + set + '</div></div>'; // duplicado para el loop infinito
      }
      box.innerHTML = html;
    });
  }

  function need() {
    var max = 0;
    [].forEach.call(document.querySelectorAll('[data-rv-cols]'), function (box) {
      max = Math.max(max, (parseInt(box.getAttribute('data-rv-per-col'), 10) || 3) * 3);
    });
    return max;
  }

  /* ---- Carga ------------------------------------------------------------- */
  var picked = [], seen = {}, wanted = need();

  function loadCols(page) {
    get('filter_rating=5&per_page=30&page=' + page, function (d) {
      if (!d) return;                                       // sin Judge.me: queda el HTML de fallback
      if (page === 1) paintSummary(parseFloat(d.average_rating), parseInt(d.number_of_reviews, 10));
      if (!wanted) return;

      var list = (d.reviews || []).filter(function (r) { return Number(r.rating) === 5; });
      list.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); }); // pin primero, después por fecha
      list.forEach(function (r) {
        var t = plain(r.body_html);
        if (!fits(t) || seen[t]) return;
        seen[t] = 1;
        picked.push(r);
      });

      var pages = d.pagination && d.pagination.total_pages || 1;
      if (picked.length < wanted && page < pages && page < MAX_PAGES) return loadCols(page + 1);
      paintCols(picked.map(toCard));
    });
  }

  /* ---- Lista completa ("Todas las reseñas", solo en la PDP) --------------- */
  // Nombre + inicial del apellido ("Mauricio S."), como muestra Judge.me
  function shortName(r) {
    var first = firstName(r);
    if (r.is_anonymous_reviewer) return first;
    var last = String(r.reviewer_name || '').trim().split(/\s+/).slice(1)
      .filter(function (w) { return /^[A-Za-zÀ-ÿ]/.test(w); })[0];
    return last ? first + ' ' + last.charAt(0).toUpperCase() + '.' : first;
  }
  function stars(n) {
    n = Math.max(0, Math.min(5, Math.round(n)));
    return '★★★★★'.slice(0, n) + '<span class="off">' + '★★★★★'.slice(n) + '</span>';
  }
  function safeUrl(u) { return /^https:\/\//.test(u || '') ? u : ''; }

  function itemHtml(r, i) {
    var name = shortName(r), n = Number(r.rating) || 0, d = new Date(r.created_at);
    var date = isNaN(d) ? '' : [                         // "29 dic 2025", sin los "de"
      d.toLocaleDateString('es-AR', { day: 'numeric', timeZone: TZ }),
      d.toLocaleDateString('es-AR', { month: 'short', timeZone: TZ }).replace('.', ''),
      d.toLocaleDateString('es-AR', { year: 'numeric', timeZone: TZ })
    ].join(' ');
    var text = plain(r.body_html, true), reply = plain(r.reply_content, true);
    var pics = (r.pictures_urls || []).map(function (p) {
      var big = safeUrl(p.huge || p.original), thumb = safeUrl(p.compact || p.small);
      return big && thumb ? '<button type="button" class="ar-pic" data-rv-zoom="' + esc(big) + '" aria-label="Ampliar la foto de ' + esc(name) + '">' +
        '<img src="' + esc(thumb) + '" alt="" loading="lazy"></button>' : '';
    }).join('');
    return '<article class="ar-item">' +
      '<div class="ar-item-head">' +
        '<div class="ar-ava" style="background:' + COLORS[i % COLORS.length] + ';">' + esc(name.charAt(0)) + '</div>' +
        '<div class="ar-who"><div class="ar-name">' + esc(name) + '</div>' +
          '<div class="ar-meta"><span class="ar-item-stars" role="img" aria-label="' + n + ' de 5 estrellas">' + stars(n) + '</span>' +
          (r.verified_buyer ? '<span class="ar-verified">Compra verificada</span>' : '') + '</div></div>' +
        (date ? '<time class="ar-date" datetime="' + esc(r.created_at) + '">' + esc(date) + '</time>' : '') +
      '</div>' +
      (r.title ? '<div class="ar-item-title">' + esc(plain(r.title)) + '</div>' : '') +
      (text ? '<p class="ar-text">' + esc(text) + '</p>' : '') +
      (pics ? '<div class="ar-pics">' + pics + '</div>' : '') +
      (reply ? '<div class="ar-reply"><div class="ar-reply-by">Respuesta de Power Rush</div><p>' + esc(reply) + '</p></div>' : '') +
    '</article>';
  }

  function zoom(src, from) {
    var box = document.createElement('div');
    box.className = 'ar-zoom';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Foto de la reseña');
    box.innerHTML = '<img alt="Foto de la reseña"><button type="button" class="ar-zoom-close" aria-label="Cerrar">×</button>';
    box.querySelector('img').src = src;
    function key(e) { if (e.key === 'Escape') close(); }
    function close() { document.removeEventListener('keydown', key); box.remove(); from.focus(); }
    box.addEventListener('click', close);
    document.addEventListener('keydown', key);
    document.body.appendChild(box);
    box.querySelector('button').focus();
  }

  function initAll(sec) {
    var PER = 8;
    var list = sec.querySelector('[data-rv-list]'), more = sec.querySelector('[data-rv-more]'),
        bars = sec.querySelector('[data-rv-bars]'), clear = sec.querySelector('[data-rv-clear]'),
        hint = sec.querySelector('[data-rv-hint]'), showing = sec.querySelector('[data-rv-showing]'),
        sort = sec.querySelector('.ar-sort'), main = sec.querySelector('.ar-main');
    var st = { rating: 0, sort: '', page: 0, shown: 0, seq: 0 }, hist = {};

    function drawBars(h) {
      var total = 0, html = '';
      (h || []).forEach(function (b) { hist[b.rating] = b.frequency; total += b.frequency; });
      for (var s = 5; s >= 1; s--) {
        var n = hist[s] || 0, pct = total ? Math.round(n / total * 100) : 0;
        html += '<button type="button" class="ar-bar" data-rv-rate="' + s + '" aria-pressed="false"' + (n ? '' : ' disabled') +
          ' aria-label="Ver reseñas de ' + s + ' estrellas (' + n + ')">' +
          '<span class="ar-bar-l">' + s + ' <b>★</b></span>' +
          '<span class="ar-bar-track"><span class="ar-bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="ar-bar-n">' + n.toLocaleString('es-AR') + '</span></button>';
      }
      bars.innerHTML = html;
    }

    function load(reset) {
      if (reset) { st.page = 0; st.shown = 0; list.classList.add('loading'); }
      var seq = ++st.seq, page = st.page + 1;
      more.disabled = true; more.textContent = 'Cargando…';
      get('per_page=' + PER + '&page=' + page +
          (st.rating ? '&filter_rating=' + st.rating : '') + (st.sort ? '&sort_by=' + st.sort : ''), function (d) {
        if (seq !== st.seq) return;                         // llegó tarde: ya se pidió otro filtro
        list.classList.remove('loading');
        more.disabled = false; more.textContent = 'Ver más reseñas';
        if (!d || !d.reviews) {
          if (sec.hidden) return;                           // nunca respondió: la sección queda oculta
          if (reset) { list.innerHTML = '<p class="ar-empty">No pudimos cargar las reseñas. Probá de nuevo en un rato.</p>'; more.hidden = true; }
          else more.textContent = 'Probá de nuevo';
          return;
        }
        if (sec.hidden) {                                   // primera respuesta: se muestra la sección
          drawBars(d.histogram);
          sec.hidden = false;
          [].forEach.call(document.querySelectorAll('[data-rv-all-link]'), function (a) { a.setAttribute('href', '#' + sec.id); });
        }
        if (reset) list.innerHTML = '';
        list.insertAdjacentHTML('beforeend', d.reviews.map(function (r) { return itemHtml(r, st.shown++); }).join(''));
        if (!st.shown) list.innerHTML = '<p class="ar-empty">Todavía no hay reseñas de ' + st.rating + ' estrellas.</p>';

        st.page = page;
        more.hidden = page >= (d.pagination && d.pagination.total_pages || 1);
        var of = st.rating ? (hist[st.rating] || 0) : (parseInt(d.number_of_reviews, 10) || 0);
        showing.textContent = st.shown + ' de ' + of.toLocaleString('es-AR') + ' reseñas' + (st.rating ? ' de ' + st.rating + '★' : '');
      });
    }

    // al cambiar el filtro con la lista ya larga, volver al principio de la lista
    function refresh() {
      var top = main.getBoundingClientRect().top;
      if (top < 0) window.scrollBy(0, top - 120);
      load(true);
    }
    function setRating(s) {
      st.rating = s;
      [].forEach.call(bars.children, function (b) {
        var on = +b.getAttribute('data-rv-rate') === s;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      clear.hidden = !s; hint.hidden = !!s;
      refresh();
    }

    bars.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rv-rate]');
      if (!b || b.disabled) return;
      var s = +b.getAttribute('data-rv-rate');
      setRating(st.rating === s ? 0 : s);                   // tocar la misma barra saca el filtro
    });
    clear.addEventListener('click', function () { setRating(0); });
    sort.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rv-sort]');
      if (!b || b.getAttribute('data-rv-sort') === st.sort) return;
      st.sort = b.getAttribute('data-rv-sort');
      [].forEach.call(sort.children, function (x) {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      refresh();
    });
    more.addEventListener('click', function () { load(false); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rv-zoom]');
      if (b) zoom(b.getAttribute('data-rv-zoom'), b);
    });

    load(true);
  }

  if (!window.fetch) return;
  loadCols(1);
  var all = document.querySelector('[data-rv-all]');
  if (all) initAll(all);
})();
