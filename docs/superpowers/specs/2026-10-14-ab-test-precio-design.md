# Test A/B de precio — diseño

Fecha: 2026-10-14 · Estado: borrador para revisión

## Objetivo

Medir cuál de tres precios del pote deja más ingreso por visitante. A cada persona
se le asigna un precio al azar en su primera visita y lo ve siempre igual; el link es
el mismo para todos y nada en la web, el checkout, los anuncios o los mails delata el
test. Todo queda registrado (visitas, carrito, checkout y cada orden con su grupo)
para comparar conversión, ingreso por visitante, ticket promedio y el resto del embudo.

## Grupos

| Grupo | Rol | Precio 1 pote | 2 potes (−10%) | 3 potes (−15%) | Por porción | Tráfico |
|---|---|---|---|---|---|---|
| A | control | $44.999 | $80.998,20 | $114.747,45 | $1.500 | 1/3 |
| B | | $47.749 | $85.948,20 | $121.759,95 | $1.592 | 1/3 |
| C | | $49.999 | $89.998,20 | $127.497,45 | $1.667 | 1/3 |

- Precios sin centavos. Los descuentos por cantidad (AHORROPACK −10% desde 2 potes,
  AHORRO15% −15% desde 3) son descuentos automáticos de pedido en Shopify, aplican a
  todos los productos y generan centavos en el checkout; la web
  calcula igual que Shopify (porcentaje sobre el total) y muestra el total redondeado
  al peso. La diferencia es siempre menor a $1 y ya existe hoy.
- El producto original en Shopify pasa de $44.950 a $44.999 (precio A). Cualquier
  catálogo o feed que lea Shopify muestra el precio A.
- Los anuncios y los mails no muestran precio durante el test (hoy ya es así).

## Restricciones que condicionan el diseño

1. El checkout es de Shopify y cobra el precio de la variante del carrito. Cambiar el
   número en la web no alcanza.
2. La tienda está en el plan "Shopify", no Plus. Shopify solo permite apps propias con
   Functions en Plus, y la operación `update` de Cart Transform (sobrescribir precio)
   figura deshabilitada para esta tienda (`eligibleOperations.updateOperation: false`).
   El método principal de Intelligems (Cart Transform) no se puede replicar.
3. Intelligems como app: USD 499/mes en el plan con tests de precio, y su SDK headless
   es para React. El sitio es HTML estático sin build.
4. El sitio ya tiene un middleware de Vercel en cada página (portada "en construcción").
   Vercel lo compila como CommonJS: no puede tener imports.
5. El repo es público: tokens y secretos van solo en variables de entorno de Vercel.

## Alternativas evaluadas

| Opción | ¿Se nota en checkout? | Stock | Costo | Decisión |
|---|---|---|---|---|
| Pack fijo de 1 unidad (bundle nativo) | Casi nada: checkout agrupa pack + contenido | Compartido nativo | $0 | **Primera opción, sujeta a la prueba del paso 0** |
| Productos duplicados ocultos | No | Separado, sincronizado por webhook | $0 | **Respaldo** si el pack falla |
| Draft orders con precio a medida | Probablemente no | Compartido | $0 | Descartada: órdenes como "pedido preliminar", sin mails de carrito abandonado, peor atribución |
| Precio alto + descuento oculto por grupo | Sí, "Descuento" y precio tachado | Compartido | $0 | Descartada: se nota |
| Intelligems | No | Compartido | USD 499/mes | Descartada: costo e integración React |
| App propia con Shopify Function | No | Compartido | Exige Plus | Descartada |
| Rotar el precio por semana | No | Compartido | $0 | Descartada: no es al azar por visitante ni respeta la cookie |

El método del checkout queda aislado detrás de un mapa `grupo → variantes`: el resto
del sistema es igual con pack o con duplicados.

## Arquitectura

```
Visitante ──► middleware.js ── sortea grupo, cookie pr_ab (servidor)
                 │
                 ▼
          HTML estático ── ab.js en <head>: lee el grupo, define precios, oculta
                 │          precios hasta pintarlos, manda eventos
                 ▼
             cart.js ── precio base y variantes del grupo; atributos _ab_* en el carrito
                 │
                 ├──► /api/ab/event ──► Postgres (ab_events)
                 ▼
     Checkout Shopify ── pixel personalizado ──► /api/ab/event
                 │
                 ▼
     Orden creada ── webhook orders/create ──► /api/ab/order
                                                 ├─ tag ab-precio1-B
                                                 ├─ Postgres (ab_orders)
                                                 └─ stock del original (solo duplicados)

     Admin Shopify › Apps › Power Rush AB (iframe /app)
                 ◄── /api/ab/report ◄── Postgres + órdenes frescas de Shopify
```

### Archivos

| Archivo | Rol |
|---|---|
| `middleware.js` | Sorteo del grupo y cookie, exclusión de bots, links de QA. Sigue sin imports. |
| `ab.js` (nuevo) | Config del test en el cliente (test, grupos, precios, variantes), lectura de la cookie, cálculo de precios, pintado de precios sin parpadeo, envío de eventos. |
| `cart.js` | Usa `window.PR_AB` para precio base, variantes y atributos del carrito; emite eventos. |
| `index.html`, `products/powerrush/index.html` | Precios escritos a mano reemplazados por elementos que pinta `ab.js` (incluida la fila "Precio por porción"). |
| `api/ab/event.mjs` | Recibe eventos de la web y del pixel y los guarda. |
| `api/ab/order.mjs` | Webhook de órdenes: verifica HMAC, etiqueta, guarda y sincroniza stock si hay duplicados. |
| `app.html` (ruta `/app`) + `api/ab/report.mjs` | Informe dentro del admin de Shopify (app embebida); la API valida el token de sesión de Shopify. |
| `vercel.json` | Header `frame-ancestors` para `/app`. |
| `shopify/ab-pixel.js` | Código del pixel personalizado (se pega en Shopify; vive en el repo para versionarlo). |
| `db/ab-schema.sql` | Tablas. |
| `scripts/ab-shopify-setup.mjs` | Crea packs o duplicados, los publica solo en el canal headless y registra el webhook. |
| `package.json` | Dependencia `@neondatabase/serverless` para las funciones de `api/ab/`. |

## 1. Asignación

- El middleware sortea el grupo en la primera visita con `crypto.getRandomValues`,
  ponderado por la config (1/3 cada uno).
- Cookie `pr_ab=<test>.<grupo>.<visitante>` (por ejemplo `precio1.B.k3j2h4q9…`):
  180 días, `Path=/`, `Secure`, `SameSite=Lax`, legible por JavaScript (no
  `HttpOnly`). `Domain=.powerrush.com.ar` solo cuando el host es de ese dominio (en
  los deploys de preview `*.vercel.app` va sin `Domain`). La pone el servidor para
  evitar el tope de 7 días que Safari aplica a cookies creadas por scripts.
- Sin cookie (desarrollo local con live-server, que no corre el middleware): `ab.js`
  usa A, o el grupo de `?ab=`, y no registra eventos.
- Si la cookie existe, es válida y es del test activo, se respeta. Si es de otro test o
  está mal formada, se sortea de nuevo.
- Bots (user agent de Google, Meta, crawlers, previews de links): sin cookie; ven el
  precio A y no se registran.
- Equipo: si existe la cookie de acceso `pr_acceso`, los eventos se marcan `internal`.
- Links de QA: `?ab=A|B|C` fija ese grupo en ese navegador y marca la cookie como QA
  (`precio1.B.<visitante>.qa`); sus eventos quedan fuera del análisis.
- Mientras `ABIERTO = false`, solo el equipo pasa la portada, así que solo hay
  asignaciones de QA o internas. El test cuenta desde que abre la tienda.
- Con el test apagado (`AB_ACTIVO = false`) no se asigna nada y todos ven el precio
  del producto original.
- La config del test vive en dos lugares por la restricción del middleware sin imports:
  el middleware conoce `id`, grupos y pesos; `ab.js` conoce además precios y
  variantes. `ab.js` valida que el grupo de la cookie exista en su config; si no,
  usa A y registra `error_config`.

## 2. Precio en la web

- `ab.js` se carga en el `<head>` (bloqueante y chico). Lee la cookie, expone
  `window.PR_AB = { test, group, visitor, qa, internal, price, variants, track }` y
  agrega una regla CSS que oculta los elementos de precio hasta que se pintan.
- Cada lugar con precio lleva un atributo que indica qué mostrar (precio de 1 pote,
  total o por unidad para 1/2/3 potes, por porción). `ab.js` los completa en cuanto
  existen en el DOM y los vuelve visibles. No queda ningún número escrito a mano en el
  HTML: nunca se ve un precio y después otro.
- Lugares cubiertos: tarjetas del home (2), fila "Precio por porción" de la tabla
  comparativa, selector de cantidad del producto (3 tarjetas: total y c/u), precio
  total, barra fija de compra y el carrito.
- `cart.js` toma el precio base de `PR_AB.price` en vez de esperar a Shopify (se borra
  el `BASE_FALLBACK` de $24.999). Shopify sigue mandando stock y fotos.
- Control de configuración: cuando responde el catálogo de Shopify, `cart.js` compara
  el precio de la variante del grupo con `PR_AB.price`. Si no coincide, registra
  `error_precio`; el informe lo muestra como alarma.

## 3. Checkout y órdenes

- Al tocar "Comprar", `cart.js` arma el carrito con `PR_AB.variants[sabor]`:
  - A: variantes originales (Blue Fizz `…/50221562495224`, Cherry Pop `…/50221562462456`).
  - B y C: la variante del pack de 1 unidad (o del duplicado) de cada sabor.
- Packs o duplicados: mismo título, sabor y fotos que el original; publicados solo en
  el canal headless `powerrush` (`gid://shopify/Publication/213151154424`), no en
  Online Store, Point of Sale ni Facebook & Instagram.
- El carrito lleva atributos ocultos `_ab_test`, `_ab_group` y `_ab_visitor`. Shopify
  los copia a la orden (`customAttributes`). Ya verificado: `cartCreate` los acepta.
- Si `cartCreate` falla con la variante del grupo, se muestra el error actual y se
  registra `error_checkout`. No se cae a la variante de A: cambiaría el precio sin aviso.
- Webhooks `orders/create` y `orders/updated` → `/api/ab/order`:
  1. Verifica la firma HMAC de Shopify.
  2. Lee el grupo de los atributos; si faltan, lo deduce del precio unitario de las
     líneas (44.999 → A, 47.749 → B, 49.999 → C), marcado como `inferido`.
  3. Agrega el tag `ab-precio1-<grupo>` a la orden (y `ab-qa` / `ab-inferido` si
     corresponde), sin repetir tags que ya tenga.
  4. Guarda o actualiza la orden en `ab_orders` (una fila por ID de orden). Con
     `orders/updated`, cancelaciones y reembolsos quedan reflejados en la base.
  5. Solo con duplicados y solo en `orders/create`: descuenta del original las
     unidades vendidas.
  Si falla, Shopify reintenta; todo es idempotente.
- Descuentos: AHORROPACK, AHORRO15%, el código FOCUS10 y "Envio Gratis" están
  configurados para todos los productos (verificado), así que aplican igual en los tres
  grupos. El paso 0 confirma que también aplican sobre el pack.
- Un mail de carrito abandonado lleva al checkout con el mismo precio que vio esa persona.
- Al terminar el test, los packs o duplicados quedan activos 30 días más y después
  se archivan.

## 4. Registro de eventos

Base: Postgres de Neon, instalada desde el Marketplace de Vercel en el proyecto
`power-rush-playground`.

```sql
create table ab_events (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  test        text not null,
  grp         text not null,
  visitor     text not null,
  session     text,
  event       text not null,
  path        text,
  flavor      text,
  qty         int,
  value       numeric(12,2),
  order_id    text,
  detail      text,          -- botón de origen o detalle del error
  source      text,          -- utm_source o dominio del referrer
  medium      text,
  campaign    text,
  device      text,          -- mobile | desktop | tablet
  country     text,          -- header x-vercel-ip-country
  excluded    text           -- null | internal | qa
);
create index on ab_events (test, grp, event);
create index on ab_events (test, visitor);

create table ab_orders (
  order_id      text primary key,
  order_name    text,
  created_at    timestamptz not null,
  updated_at    timestamptz not null default now(),
  test          text not null,
  grp           text not null,
  visitor       text,
  inferred      boolean not null default false,
  qa            boolean not null default false,  -- compra de prueba (_ab_qa)
  units         int not null,
  subtotal      numeric(12,2) not null,          -- antes de descuentos
  discounts     numeric(12,2) not null,
  total         numeric(12,2) not null,          -- mercadería neta de descuentos y reembolsos
  discount_codes text[],
  status        text not null  -- paid | pending | cancelled | refunded | partially_refunded
);
```

| Evento | Origen | Datos |
|---|---|---|
| `vista` | web | página, origen del tráfico, dispositivo |
| `agregar_carrito` | web | sabor, cantidad, botón de origen |
| `abrir_carrito` | web | — |
| `clic_comprar` | web | unidades, subtotal |
| `checkout_iniciado` | pixel | subtotal |
| `pago_ingresado` | pixel | — |
| `compra` | pixel | número de orden, total |
| `error_precio`, `error_config`, `error_checkout` | web | detalle |

- La web envía con `navigator.sendBeacon` (no frena la página ni la salida al
  checkout). La sesión es un ID en `sessionStorage`.
- El pixel personalizado (Configuración → Eventos de clientes) se suscribe a
  `checkout_started`, `payment_info_submitted` y `checkout_completed`, lee
  `event.data.checkout.attributes` y envía con `fetch` (`keepalive`, cuerpo
  `text/plain` para evitar preflight). Si el carrito no tiene `_ab_test`, no envía nada.
- `/api/ab/event` valida test, grupo y tipo de evento, descarta user agents de bots,
  agrega país y dispositivo, y responde 204. Nunca devuelve error a la página.
- Ningún dato personal: el visitante es un ID al azar y no se guardan emails ni
  direcciones.

## 5. Informe

El informe vive dentro del admin de Shopify, en **Apps → Power Rush AB**. No hay página
de resultados pública ni `/ab` aparte.

- La app del Dev Dashboard se configura como app embebida: *App URL*
  `https://www.powerrush.com.ar/app` y *Embed in Shopify admin* activado. Shopify carga
  esa página en un iframe del admin.
- `app.html` (servida en `/app`) es HTML estático: carga App Bridge
  (`cdn.shopify.com/shopifycloud/app-bridge.js`, con `<meta name="shopify-api-key">` =
  client ID) y los componentes web de Polaris desde el CDN de Shopify, sin build.
- La página pide los datos a `/api/ab/report` con `Authorization: Bearer
  <shopify.idToken()>`. La API verifica el JWT de sesión con `node:crypto` (HS256 con el
  client secret; `aud` = client ID, `dest` = `https://6q1n8a-jw.myshopify.com`, `exp` y
  `nbf` vigentes). Sin token válido responde 401.
- Quién lo ve lo decide Shopify: el staff con acceso a la app.
- `/app` responde con `Content-Security-Policy: frame-ancestors
  https://6q1n8a-jw.myshopify.com https://admin.shopify.com` (vía `vercel.json`) y queda
  fuera de la portada "en construcción" y del sorteo del test (matcher del middleware).
- El CSV se descarga desde la misma página.

Contenido: una columna por grupo, excluyendo `internal` y `qa`:

- Visitantes únicos, % que agrega al carrito, % que llega al checkout, % que compra.
- Órdenes, unidades, unidades por orden, ticket promedio.
- Ingreso total e **ingreso por visitante** (métrica principal).
- Probabilidad de que B y C le ganen a A:
  - conversión: modelo Beta-Binomial;
  - ingreso por visitante: bootstrap por visitante (10.000 remuestreos), intervalo
    del 95%.
- Control del reparto: chi-cuadrado sobre visitantes por grupo. Si da p < 0,01, la
  página muestra una alarma (asignación rota).
- Alarmas de `error_precio`, `error_config` y `error_checkout`.
- Cortes por dispositivo y por origen del tráfico. Exportación a CSV.
- Ingreso: mercadería neta de descuentos y reembolsos (`current_subtotal_price`), sin
  envío (no depende del grupo) y sin órdenes canceladas. El estado se mantiene al día
  con el webhook `orders/updated`.
- Exclusión: un visitante con cualquier evento marcado `internal`/`qa`, o con una
  orden `qa`, queda fuera de todas las métricas.
- Ganancia por visitante queda fuera por ahora; se agrega cargando el costo por pote
  en la config.

Tamaño de muestra de referencia: con ~2% de conversión, detectar con seguridad una
diferencia de ~15% pide del orden de 30.000 visitantes (~600 órdenes) por grupo. Regla
de corte, fijada antes de arrancar: mínimo 2 semanas completas y una cantidad mínima de
órdenes por grupo que el equipo define con el tráfico real de las primeras semanas.

## 6. Operación

**Paso 0: prueba del pack de 1 unidad** (antes de escribir el resto). Con Admin API:
crear un pack fijo de B con 1 × Blue Fizz original, publicarlo en el canal headless y
comprobar:

1. Shopify acepta un pack de un solo componente con cantidad 1.
2. `cartCreate` por Storefront API con la variante del pack funciona.
3. El checkout muestra el nombre del producto y $47.749, sin precio original ni
   descuento. Lo que agregue como "contenido del pack" se evalúa con captura.
4. AHORRO10 / AHORRO15 aplican sobre el pack.
5. Una orden de prueba descuenta stock del Blue Fizz original.

Si falla cualquiera de los cinco, se usan duplicados.

**Antes de arrancar:** compra real en cada grupo con `?ab=A|B|C` (después se
reembolsa): precio en web y checkout, tag, fila en la base, stock. Verificar que el
precio nunca parpadea (captura en carga lenta) y que la cookie sobrevive en Safari.

**Primeros días:** revisar el control del reparto.

**Durante:** sin precios en anuncios ni mails; ningún cambio del sitio que afecte a un
solo grupo.

**Al terminar:** precio del original al ganador, `AB_ACTIVO = false` en middleware y
`ab.js`, packs o duplicados archivados a los 30 días. Los datos quedan en la base.

## Pruebas

- Unitarias con `node:test` (sin build): cálculo de precios por grupo y cantidad,
  formato de pesos, parseo y validación de la cookie, sorteo (100.000 sorteos simulados
  quedan en 1/3 ± 1%), verificación HMAC del webhook, verificación del token de sesión
  (firma, `aud`, `dest`, vencimiento), estadística del informe.
- Manuales: las del paso 0 y las de "antes de arrancar".

## Prerrequisitos del equipo

- Hecho: app "Power Rush AB" del Dev Dashboard instalada en la tienda. Las funciones
  piden el token con el *client credentials grant* (dura 24 h) usando
  `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET`, que van como variables de entorno en
  Vercel (en local, `.env.local`, ignorado por git). El mismo secreto valida la firma
  HMAC de los webhooks. Permisos que usa el test: `read/write_products`,
  `read/write_orders`, `read_discounts`, `read/write_publications`,
  `read/write_inventory`.
- Pendiente en el Dev Dashboard: nueva versión con *App URL*
  `https://www.powerrush.com.ar/app`, *Embed in Shopify admin* activado y solo los
  permisos de arriba (hoy tiene casi todos). Si Shopify pide aprobarla, la aprueba el
  dueño. Después, rotar el client secret (quedó escrito en un chat) y actualizarlo en
  Vercel y en `.env.local`.
- Instalar Neon desde el Marketplace de Vercel en `power-rush-playground` (se puede
  hacer por CLI con la cuenta de Marcos).
- Pegar el pixel en Shopify, o dejar que se haga desde el navegador con su sesión.

## Riesgos aceptados

- Una persona que entra desde dos dispositivos puede ver dos precios. Es inherente a
  los tests por cookie (también en Intelligems).
- Si alguien edita a mano el atributo o la variante del carrito podría comprar a otro
  precio del test; nunca a uno fuera de los tres.
- Con poco tráfico, el test solo detecta diferencias grandes.
- Si se activa un banner de consentimiento en Shopify, el pixel depende del
  consentimiento y el embudo del checkout puede subcontarse; las órdenes no se pierden
  porque llegan por webhook.

## Fuera de alcance

Varios tests en paralelo, panel para configurar tests sin tocar código, ganancia por
visitante, integración con píxeles de anuncios.
