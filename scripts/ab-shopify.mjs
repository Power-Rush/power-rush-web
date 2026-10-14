/* Configuración del test A/B en Shopify (Admin API). Uso:
     npm run ab:shopify -- <comando> [argumento]
   Comandos:
     spike                    pack de prueba: grupo B, solo Blue Fizz, en el canal de la web
     borrar <productId>       borra un producto creado por este script (tag ab-test)
     catalogo <pack|duplicado>  crea los productos de B y C con los dos sabores (Task 4)
     precio-control           pone las variantes originales al precio de A (Task 4)
     webhooks                 registra orders/create y orders/updated (Task 11)
     estado                   productos del test, precios, canales y webhooks */
import AB from '../ab.js';
import { adminGql, sinErrores } from '../api/_lib/shopify.mjs';

const { CONFIG } = AB;
const PRODUCTO_ORIGINAL = 'gid://shopify/Product/10286359806200';
const CANAL_WEB = 'gid://shopify/Publication/213151154424';
const WEBHOOK_URI = 'https://www.powerrush.com.ar/api/ab/order';
const STOREFRONT = { url: 'https://6q1n8a-jw.myshopify.com/api/2026-01/graphql.json', token: '86f826b1c8e239cacd6e97100784c83f' };
const SABORES = ['bf', 'cp'];

const Q_ORIGINAL = `query Original($id: ID!) {
  product(id: $id) {
    title
    descriptionHtml
    vendor
    productType
    options { name }
    variants(first: 10) { nodes { id title price media(first: 1) { nodes { ... on MediaImage { image { url altText } } } } } }
  }
}`;
const M_PRODUCT_SET = `mutation CrearProducto($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id variants(first: 10) { nodes { id title price } } }
    userErrors { field message code }
  }
}`;
const M_COMPONENTES = `mutation Componentes($input: [ProductVariantRelationshipUpdateInput!]!) {
  productVariantRelationshipBulkUpdate(input: $input) {
    parentProductVariants { id requiresComponents productVariantComponents(first: 5) { nodes { quantity productVariant { id } } } }
    userErrors { code field message }
  }
}`;
const M_PUBLICAR = `mutation Publicar($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;
const Q_CANALES = `query Canales($id: ID!) {
  product(id: $id) {
    resourcePublicationsV2(first: 10, onlyPublished: true) { nodes { publication { id name } isPublished } }
  }
}`;
const Q_PACK = `query Pack($id: ID!) {
  productVariant(id: $id) {
    id
    price
    requiresComponents
    inventoryQuantity
    productVariantComponents(first: 5) { nodes { quantity productVariant { id title } } }
  }
}`;
const Q_ETIQUETAS = `query Etiquetas($id: ID!) { product(id: $id) { id title tags } }`;
const M_BORRAR = `mutation Borrar($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`;
const Q_POR_TAG = `query PorTag($q: String!) {
  products(first: 20, query: $q) {
    nodes {
      id
      title
      tags
      status
      variants(first: 5) { nodes { id title price } }
      resourcePublicationsV2(first: 10, onlyPublished: true) { nodes { publication { id } } }
    }
  }
}`;
const Q_WEBHOOKS = `query Webhooks { webhookSubscriptions(first: 20) { nodes { id topic uri } } }`;
const M_CART = `mutation Probar($input: CartInput!) {
  cartCreate(input: $input) {
    cart { checkoutUrl attributes { key value } cost { subtotalAmount { amount } totalAmount { amount } } }
    userErrors { message }
  }
}`;

async function storefront(query, variables) {
  const res = await fetch(STOREFRONT.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': STOREFRONT.token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error('Storefront: ' + JSON.stringify(data.errors));
  return data.data;
}

/* Datos del producto original que se copian a los productos del test. */
async function original() {
  const { product } = await adminGql(Q_ORIGINAL, { id: PRODUCTO_ORIGINAL });
  const porId = Object.fromEntries(product.variants.nodes.map((v) => [v.id, v]));
  const sabores = {};
  for (const s of SABORES) {
    const v = porId[CONFIG.grupos.A.variantes[s]];
    if (!v) throw new Error(`La variante original de ${s} no está en el producto`);
    const img = v.media.nodes[0] && v.media.nodes[0].image;
    sabores[s] = { id: v.id, titulo: v.title, imagen: img ? img.url : null, alt: (img && img.altText) || v.title };
  }
  return { producto: product, opcion: product.options[0].name, sabores };
}

async function verificarCanales(id) {
  const { product } = await adminGql(Q_CANALES, { id });
  const canales = product.resourcePublicationsV2.nodes.map((n) => n.publication.id);
  if (canales.length !== 1 || canales[0] !== CANAL_WEB) {
    throw new Error(`${id} está publicado en [${canales.join(', ')}]: tiene que estar solo en el canal de la web`);
  }
}

/* Crea el producto de un grupo: mismo título, descripción, sabores y fotos que el original,
   al precio del grupo, publicado solo en el canal de la web.
   pack: cada variante es un bundle fijo con 1 unidad de la variante original (stock compartido).
   duplicado: variantes sin control de stock (Task 12 descuenta del original). */
async function crearProductoGrupo(grupo, modo, sabores = SABORES) {
  if (!['pack', 'duplicado'].includes(modo)) throw new Error('Modo: pack o duplicado');
  const o = await original();
  const precio = CONFIG.grupos[grupo].precio;
  const input = {
    title: o.producto.title,
    descriptionHtml: o.producto.descriptionHtml,
    vendor: o.producto.vendor,
    productType: o.producto.productType,
    status: 'ACTIVE',
    tags: ['ab-test', `ab-${CONFIG.test}-${grupo}`, `ab-modo-${modo}`],
    productOptions: [{ name: o.opcion, values: sabores.map((s) => ({ name: o.sabores[s].titulo })) }],
    // productSet pide que la foto de cada variante esté también entre los archivos del producto
    files: sabores.filter((s) => o.sabores[s].imagen)
      .map((s) => ({ originalSource: o.sabores[s].imagen, contentType: 'IMAGE', alt: o.sabores[s].alt })),
    variants: sabores.map((s) => ({
      optionValues: [{ optionName: o.opcion, name: o.sabores[s].titulo }],
      price: precio,
      ...(modo === 'duplicado' ? { inventoryItem: { tracked: false } } : {}),
      ...(o.sabores[s].imagen
        ? { file: { originalSource: o.sabores[s].imagen, contentType: 'IMAGE', alt: o.sabores[s].alt } }
        : {}),
    })),
  };
  const creado = sinErrores((await adminGql(M_PRODUCT_SET, { input })).productSet, 'productSet').product;
  const variantes = {};
  for (const s of sabores) variantes[s] = creado.variants.nodes.find((v) => v.title === o.sabores[s].titulo).id;

  if (modo === 'pack') {
    const relaciones = sabores.map((s) => ({
      parentProductVariantId: variantes[s],
      priceInput: { calculation: 'FIXED', price: precio },   // sin esto Shopify pone la suma de los componentes
      productVariantRelationshipsToCreate: [{ id: o.sabores[s].id, quantity: 1 }],
    }));
    sinErrores((await adminGql(M_COMPONENTES, { input: relaciones })).productVariantRelationshipBulkUpdate,
      'productVariantRelationshipBulkUpdate');
  }
  sinErrores((await adminGql(M_PUBLICAR, { id: creado.id, input: [{ publicationId: CANAL_WEB }] })).publishablePublish,
    'publishablePublish');
  await verificarCanales(creado.id);
  return { productId: creado.id, variantes };
}

async function spike() {
  const { productId, variantes } = await crearProductoGrupo('B', 'pack', ['bf']);
  console.log('Producto de prueba:', productId);
  console.log('Variante pack B Blue Fizz:', variantes.bf);
  const { productVariant: v } = await adminGql(Q_PACK, { id: variantes.bf });
  console.log('requiresComponents:', v.requiresComponents, '| precio:', v.price, '| stock vendible:', v.inventoryQuantity);
  console.log('componentes:', v.productVariantComponents.nodes.map((c) => `${c.quantity} × ${c.productVariant.title} (${c.productVariant.id})`).join(', '));
  for (const cantidad of [1, 2]) {
    const { cartCreate } = await storefront(M_CART, {
      input: {
        lines: [{ merchandiseId: variantes.bf, quantity: cantidad }],
        attributes: [{ key: '_ab_test', value: CONFIG.test }, { key: '_ab_group', value: 'B' }, { key: '_ab_qa', value: '1' }],
      },
    });
    if (cartCreate.userErrors.length) { console.log(`cartCreate (${cantidad}):`, cartCreate.userErrors); continue; }
    const c = cartCreate.cart;
    console.log(`\n${cantidad} pote(s): subtotal $${c.cost.subtotalAmount.amount} · total $${c.cost.totalAmount.amount}`);
    console.log('atributos:', JSON.stringify(c.attributes));
    console.log('checkout:', c.checkoutUrl);
  }
}

async function borrar(id) {
  if (!id) throw new Error('Uso: borrar <productId>');
  const { product } = await adminGql(Q_ETIQUETAS, { id });
  if (!product || !product.tags.includes('ab-test')) throw new Error('Solo borro productos con el tag ab-test');
  sinErrores((await adminGql(M_BORRAR, { input: { id } })).productDelete, 'productDelete');
  console.log('Borrado', product.title, id);
}

async function estado() {
  const { products } = await adminGql(Q_POR_TAG, { q: 'tag:ab-test' });
  if (!products.nodes.length) console.log('No hay productos del test.');
  for (const p of products.nodes) {
    console.log(`\n${p.id} · ${p.status} · tags: ${p.tags.join(', ')}`);
    console.log('  canales:', p.resourcePublicationsV2.nodes.map((n) => n.publication.id).join(', ') || 'ninguno');
    for (const v of p.variants.nodes) console.log(`  ${v.title}: $${v.price} (${v.id})`);
  }
  const { webhookSubscriptions } = await adminGql(Q_WEBHOOKS);
  console.log('\nWebhooks:', webhookSubscriptions.nodes.map((w) => `${w.topic} → ${w.uri}`).join('; ') || 'ninguno');
}

const M_WEBHOOK = `mutation Webhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

async function webhooks() {
  const { webhookSubscriptions } = await adminGql(Q_WEBHOOKS);
  for (const topic of ['ORDERS_CREATE', 'ORDERS_UPDATED']) {
    if (webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === WEBHOOK_URI)) {
      console.log(topic, 'ya estaba');
      continue;
    }
    const r = sinErrores((await adminGql(M_WEBHOOK, { topic, sub: { uri: WEBHOOK_URI, format: 'JSON' } })).webhookSubscriptionCreate,
      'webhookSubscriptionCreate');
    console.log(topic, '→', r.webhookSubscription.uri);
  }
}

const [comando, arg] = process.argv.slice(2);
const comandos = { spike, borrar: () => borrar(arg), webhooks, estado };
if (!comandos[comando]) {
  console.error('Comandos: ' + Object.keys(comandos).join(', '));
  process.exit(1);
}
await comandos[comando]();
