export function processPayment(amount: number) {
  const valid = validateAmount(amount);
  return valid ? chargeCard(amount) : reject("invalid amount");
}

function validateAmount(a: number) {
  return a > 0;
}

function chargeCard(a: number) {
  return { charged: a };
}

function reject(reason: string) {
  return { error: reason };
}

export function refundPayment(id: string, amount: number) {
  const ok = validateAmount(amount);
  return ok ? chargeCard(-amount) : reject("cannot refund");
}
