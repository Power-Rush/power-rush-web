/* Validación de los eventos del test A/B (web y pixel del checkout). */
import AB from '../../ab.js';

export const EVENTOS = new Set([
  'vista', 'agregar_carrito', 'abrir_carrito', 'clic_comprar',
  'checkout_iniciado', 'pago_ingresado', 'compra',
  'error_precio', 'error_config', 'error_checkout',
]);
// Igual que BOTS en middleware.js
export const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegram|discord|slack|preview|lighthouse|pagespeed|headless|curl|wget|python|axios|node-fetch|go-http|java\//i;

// Los manda el pixel desde el checkout de Shopify: no llevan la cookie de la web.
const DEL_CHECKOUT = new Set(['checkout_iniciado', 'pago_ingresado', 'compra']);

const corto = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const entero = (v) => (Number.isInteger(v) && v >= 0 && v < 1000 ? v : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : null);

export function dispositivo(ua) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

/* Fila para ab_events, o null si el evento no es válido o viene de un bot. */
export function filaEvento(cuerpo, { cookies = '', ua = '', pais = null, esEquipo = false } = {}) {
  const { CONFIG } = AB;
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (cuerpo.t !== CONFIG.test) return null;
  if (typeof cuerpo.g !== 'string' || !Object.hasOwn(CONFIG.grupos, cuerpo.g)) return null;
  if (typeof cuerpo.v !== 'string' || !/^[a-f0-9]{16}$/.test(cuerpo.v)) return null;
  if (!EVENTOS.has(cuerpo.e)) return null;
  if (BOTS.test(ua)) return null;
  /* Los eventos de la web tienen que coincidir con la cookie pr_ab del que los manda:
     así nadie puede inventar visitas de otro grupo o visitante desde afuera. */
  const c = String(cookies).match(/(?:^|;\s*)pr_ab=([a-z0-9-]+)\.([A-Z])\.([a-f0-9]{16})(\.qa)?(?:;|$)/);
  if (!DEL_CHECKOUT.has(cuerpo.e) && !(c && c[1] === cuerpo.t && c[2] === cuerpo.g && c[3] === cuerpo.v)) return null;
  const qa = !!(c && c[4]);
  return {
    test: cuerpo.t, grp: cuerpo.g, visitor: cuerpo.v, session: corto(cuerpo.s, 32), event: cuerpo.e,
    path: corto(cuerpo.p, 200), flavor: corto(cuerpo.f, 8), qty: entero(cuerpo.q), value: numero(cuerpo.val),
    order_id: corto(cuerpo.oid, 64), detail: corto(cuerpo.d, 300),
    source: corto(cuerpo.src, 100), medium: corto(cuerpo.med, 100), campaign: corto(cuerpo.cmp, 150),
    device: dispositivo(ua), country: corto(pais, 2),
    excluded: qa ? 'qa' : esEquipo ? 'internal' : null,
  };
}
