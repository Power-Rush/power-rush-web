/* Informe del test A/B: lectura de la base y cálculo de métricas por grupo.
   Excluye a los visitantes del equipo y de QA (por cualquier evento o orden marcada). */
import { probGanaConversion, bootstrapRpv, srm } from './estadistica.mjs';

const EXCL = `excl as (
  select distinct visitor from ab_events where test = $1 and excluded is not null
  union
  select visitor from ab_orders where test = $1 and qa and visitor is not null
)`;

function segmentoSql(columna) {   // columna fija: 'device' o 'source'
  return `with ${EXCL},
    primera as (
      select distinct on (visitor) visitor, grp, coalesce(${columna}, 'desconocido') as segmento
      from ab_events
      where test = $1 and event = 'vista'
        and not exists (select 1 from excl where excl.visitor = ab_events.visitor)
      order by visitor, at
    ),
    compras as (
      select visitor, sum(total) as ingreso from ab_orders
      where test = $1 and not qa and not inferred and status <> 'cancelled' and visitor is not null
      group by visitor
    )
    select p.grp, p.segmento, count(*)::int as visitantes, count(c.visitor)::int as compradores,
           coalesce(sum(c.ingreso), 0) as ingreso
    from primera p left join compras c on c.visitor = p.visitor
    group by p.grp, p.segmento
    order by p.grp, visitantes desc`;
}

export async function leerDatos(sql, test) {
  const [embudo, ordenes, porDispositivo, porOrigen, errores] = await Promise.all([
    sql.query(`with ${EXCL}
      select grp,
        count(distinct visitor) filter (where event = 'vista')::int as visitantes,
        count(distinct visitor) filter (where event = 'agregar_carrito')::int as agregaron,
        count(distinct visitor) filter (where event = 'clic_comprar')::int as fueron_checkout,
        count(distinct visitor) filter (where event = 'checkout_iniciado')::int as iniciaron_checkout
      from ab_events
      where test = $1 and not exists (select 1 from excl where excl.visitor = ab_events.visitor)
      group by grp`, [test]),
    sql.query(`with ${EXCL}
      select grp, visitor, total, units, inferred from ab_orders
      where test = $1 and not qa and status <> 'cancelled'
        and not exists (select 1 from excl where excl.visitor = ab_orders.visitor)`, [test]),
    sql.query(segmentoSql('device'), [test]),
    sql.query(segmentoSql('source'), [test]),
    sql.query(`select event, count(*)::int as n from ab_events
      where test = $1 and event in ('error_precio', 'error_config', 'error_checkout') group by event`, [test]),
  ]);
  return { embudo, ordenes, porDispositivo, porOrigen, errores };
}

const tasa = (a, b) => (b ? Number(a || 0) / b : null);

function segmentos(filas) {
  return filas.map((s) => {
    const visitantes = Number(s.visitantes), ingreso = Number(s.ingreso), compradores = Number(s.compradores);
    return { grupo: s.grp, segmento: s.segmento, visitantes, compradores, ingreso, conversion: tasa(compradores, visitantes), rpv: tasa(ingreso, visitantes) };
  });
}

export function armarInforme(datos, CONFIG, ahora = new Date()) {
  const ids = Object.keys(CONFIG.grupos);
  const grupos = ids.map((id) => {
    const e = datos.embudo.find((x) => x.grp === id) || {};
    const delGrupo = datos.ordenes.filter((o) => o.grp === id);
    // Las órdenes inferidas (sin atributos del test) no tienen visitante en el denominador:
    // se muestran aparte y no entran en conversión, ingreso ni estadística.
    const ords = delGrupo.filter((o) => !o.inferred);
    const porVisitante = new Map();
    ords.forEach((o, i) => {
      const k = o.visitor || `orden-${i}`;
      porVisitante.set(k, (porVisitante.get(k) || 0) + Number(o.total));
    });
    const visitantes = Number(e.visitantes) || 0;
    const ingreso = Math.round(ords.reduce((s, o) => s + Number(o.total), 0) * 100) / 100;
    const unidades = ords.reduce((s, o) => s + Number(o.units), 0);
    return {
      id, precio: CONFIG.grupos[id].precio, visitantes,
      agregaron: Number(e.agregaron) || 0, fueronCheckout: Number(e.fueron_checkout) || 0, iniciaronCheckout: Number(e.iniciaron_checkout) || 0,
      compradores: porVisitante.size, ordenes: ords.length, inferidas: delGrupo.length - ords.length,
      unidades, ingreso,
      tasaCarrito: tasa(e.agregaron, visitantes), tasaCheckout: tasa(e.fueron_checkout, visitantes),
      conversion: tasa(porVisitante.size, visitantes),
      ticket: ords.length ? ingreso / ords.length : null,
      unidadesPorOrden: ords.length ? unidades / ords.length : null,
      rpv: tasa(ingreso, visitantes),
      ingresos: [...porVisitante.values()],
    };
  });

  const control = grupos.find((g) => g.id === CONFIG.control);
  for (const g of grupos) {
    if (g === control || !control.visitantes || !g.visitantes) { g.vsControl = null; continue; }
    const conBootstrap = control.compradores > 0 && g.compradores > 0;
    const b = conBootstrap ? bootstrapRpv({ visitantes: control.visitantes, ingresos: control.ingresos }, { visitantes: g.visitantes, ingresos: g.ingresos }) : null;
    g.vsControl = {
      probConversion: probGanaConversion({ exitos: control.compradores, n: control.visitantes }, { exitos: g.compradores, n: g.visitantes }),
      probRpv: b ? b.prob : null,
      difRpv: b ? b.dif : null,
    };
  }
  for (const g of grupos) delete g.ingresos;

  const visitantes = grupos.map((g) => g.visitantes);
  const reparto = srm(visitantes, ids.map((id) => CONFIG.grupos[id].peso));
  return {
    test: CONFIG.test,
    generado: ahora.toISOString(),
    control: CONFIG.control,
    grupos,
    reparto: { ...reparto, alarma: reparto.p < 0.01 && visitantes.reduce((s, v) => s + v, 0) >= 300 },
    errores: Object.fromEntries(datos.errores.map((e) => [e.event, Number(e.n)])),
    porDispositivo: segmentos(datos.porDispositivo),
    porOrigen: segmentos(datos.porOrigen),
  };
}

export function aCsv(informe) {
  const cab = ['grupo', 'precio', 'visitantes', 'agregaron', 'fueron_checkout', 'iniciaron_checkout', 'compradores', 'ordenes', 'inferidas', 'unidades', 'ingreso', 'conversion', 'rpv', 'prob_rpv', 'prob_conversion'];
  const val = (v) => (v == null ? '' : String(v));
  const filas = informe.grupos.map((g) => [
    g.id, g.precio, g.visitantes, g.agregaron, g.fueronCheckout, g.iniciaronCheckout, g.compradores, g.ordenes, g.inferidas,
    g.unidades, g.ingreso, g.conversion, g.rpv, g.vsControl && g.vsControl.probRpv, g.vsControl && g.vsControl.probConversion,
  ].map(val).join(','));
  return [cab.join(','), ...filas].join('\n');
}
