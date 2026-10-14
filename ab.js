/* ===========================================================================
   POWER RUSH — Test A/B de precio (cliente)
   Va en el <head> de cada página, sin defer y antes que cart.js: define el precio del
   grupo del visitante antes de que se dibuje la página.
   El middleware sortea el grupo y deja la cookie pr_ab=<test>.<grupo>.<visitante>[.qa].
   En Node (tests, scripts y funciones de /api) este archivo exporta la config y los
   cálculos; en el navegador arranca solo (boot).
   Los grupos y pesos tienen que coincidir con AB en middleware.js.
   =========================================================================== */
(function (factory) {
  var AB = factory();
  if (typeof module === 'object' && module.exports) { module.exports = AB; return; }
  AB.boot(window);
})(function () {
  'use strict';

  var CONFIG = {
    activo: true,
    test: 'precio1',
    control: 'A',
    porciones: 30,
    grupos: {
      A: { precio: 44999, peso: 1, variantes: { bf: 'gid://shopify/ProductVariant/50221562495224', cp: 'gid://shopify/ProductVariant/50221562462456' } },
      B: { precio: 47749, peso: 1, variantes: { bf: null, cp: null } },   // Task 4 completa los IDs
      C: { precio: 49999, peso: 1, variantes: { bf: null, cp: null } }
    }
  };

  var RE_COOKIE = /^([a-z0-9-]+)\.([A-Z])\.([a-f0-9]{16})(\.qa)?$/;

  function grupoValido(g) { return Object.prototype.hasOwnProperty.call(CONFIG.grupos, g); }

  /* AHORROPACK (−10% desde 2 potes) y AHORRO15% (−15% desde 3) en Shopify. */
  function pct(cantidad) { return cantidad >= 3 ? 15 : cantidad === 2 ? 10 : 0; }

  /* Total como lo calcula Shopify: porcentaje sobre el total, en centavos exactos. */
  function total(precio, cantidad) {
    if (!(cantidad > 0)) return 0;
    return Math.round(precio * cantidad * (100 - pct(cantidad))) / 100;
  }
  function porUnidad(precio, cantidad) { return cantidad > 0 ? total(precio, cantidad) / cantidad : 0; }
  function porPorcion(precio) { return precio / CONFIG.porciones; }

  /* $80.998: sin centavos y con punto de miles en cualquier navegador. */
  function money(n) { return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

  function texto(tipo, precio, n) {
    n = n || 1;
    if (tipo === 'total') return money(total(precio, n));
    if (tipo === 'cu') return money(porUnidad(precio, n));
    if (tipo === 'porcion') return money(porPorcion(precio));
    return null;
  }

  function leerCookie(cookieHeader) {
    var m = String(cookieHeader || '').match(/(?:^|;\s*)pr_ab=([^;]+)/);
    var p = m && m[1].match(RE_COOKIE);
    return p ? { test: p[1], grupo: p[2], visitante: p[3], qa: !!p[4] } : null;
  }

  /* Qué grupo usa la página: cookie del test activo > ?ab= (solo sin cookie: desarrollo
     local, que no corre el middleware) > control. Sin cookie no se registra nada. */
  function resolver(cookieHeader, search) {
    if (!CONFIG.activo) return { grupo: CONFIG.control, visitante: null, qa: false, registra: false, error: null };
    var c = leerCookie(cookieHeader);
    if (c && c.test === CONFIG.test) {
      if (grupoValido(c.grupo)) return { grupo: c.grupo, visitante: c.visitante, qa: c.qa, registra: true, error: null };
      return { grupo: CONFIG.control, visitante: c.visitante, qa: c.qa, registra: true, error: 'grupo ' + c.grupo + ' no está en la config' };
    }
    var q = (String(search || '').match(/[?&]ab=([A-Za-z])(?:&|$)/) || [])[1];
    q = q ? q.toUpperCase() : null;
    return { grupo: q && grupoValido(q) ? q : CONFIG.control, visitante: null, qa: true, registra: false, error: null };
  }

  /* Atributos ocultos del carrito: Shopify los copia a la orden. */
  function atributosCarrito(r) {
    if (!r.registra) return [];
    var a = [
      { key: '_ab_test', value: CONFIG.test },
      { key: '_ab_group', value: r.grupo },
      { key: '_ab_visitor', value: r.visitante }
    ];
    if (r.qa) a.push({ key: '_ab_qa', value: '1' });
    return a;
  }

  function origenDe(search, referrer, host) {
    var p = new URLSearchParams(search || '');
    if (p.get('utm_source')) {
      return { source: p.get('utm_source'), medium: p.get('utm_medium') || null, campaign: p.get('utm_campaign') || null };
    }
    var ref = '';
    try { ref = referrer ? new URL(referrer).hostname : ''; } catch (e) { ref = ''; }
    if (ref && ref !== host) return { source: ref.replace(/^www\./, ''), medium: 'referral', campaign: null };
    return { source: 'directo', medium: null, campaign: null };
  }

  function payload(r, evento, datos, ctx) {
    datos = datos || {};
    return {
      t: CONFIG.test, g: r.grupo, v: r.visitante, s: ctx.sesion, e: evento, p: ctx.path,
      f: datos.sabor || null,
      q: datos.cantidad == null ? null : datos.cantidad,
      val: datos.valor == null ? null : datos.valor,
      d: datos.detalle || null,
      src: ctx.origen.source, med: ctx.origen.medium, cmp: ctx.origen.campaign
    };
  }

  function boot() {}   // Task 6

  return {
    CONFIG: CONFIG, pct: pct, total: total, porUnidad: porUnidad, porPorcion: porPorcion, money: money,
    texto: texto, leerCookie: leerCookie, resolver: resolver, atributosCarrito: atributosCarrito,
    origenDe: origenDe, payload: payload, boot: boot
  };
});
