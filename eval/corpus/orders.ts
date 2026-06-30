export function createOrder(items: string[]) {
  const total = computeTotal(items);
  return { items, total };
}

function computeTotal(items: string[]) {
  let sum = 0;
  for (const _ of items) sum = sum + 1;
  return sum;
}

export function cancelOrder(orderId: string) {
  return { cancelled: orderId };
}
