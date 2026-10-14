/* Pixel personalizado del test A/B de precio.
   Se pega en Shopify: Configuración → Eventos de clientes → Agregar pixel personalizado
   ("Power Rush AB"). Este archivo es la copia versionada; si cambia, volver a pegarlo.
   Lee el grupo de los atributos del carrito y manda el evento a la web. */
const ENDPOINT = 'https://www.powerrush.com.ar/api/ab/event';
const EVENTOS = {
  checkout_started: 'checkout_iniciado',
  payment_info_submitted: 'pago_ingresado',
  checkout_completed: 'compra',
};

function atributo(checkout, clave) {
  const a = (checkout.attributes || []).find((x) => x.key === clave);
  return a ? a.value : null;
}

Object.keys(EVENTOS).forEach((nombre) => {
  analytics.subscribe(nombre, (event) => {
    const checkout = event.data && event.data.checkout;
    if (!checkout || !atributo(checkout, '_ab_test')) return;
    const cuerpo = {
      t: atributo(checkout, '_ab_test'),
      g: atributo(checkout, '_ab_group'),
      v: atributo(checkout, '_ab_visitor'),
      e: EVENTOS[nombre],
      p: 'checkout',
      q: (checkout.lineItems || []).reduce((s, l) => s + (l.quantity || 0), 0),
      val: checkout.subtotalPrice ? Number(checkout.subtotalPrice.amount) : null,
      oid: checkout.order && checkout.order.id ? String(checkout.order.id) : null,
    };
    fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(cuerpo), keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } });
  });
});
