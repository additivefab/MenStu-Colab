export function mutationKeyForForm(form: HTMLFormElement) {
  const existing = form.dataset.idempotencyKey;
  if (existing) return existing;
  const key = crypto.randomUUID().replaceAll("-", "_");
  form.dataset.idempotencyKey = key;
  return key;
}

export function clearMutationKey(form: HTMLFormElement) {
  delete form.dataset.idempotencyKey;
}
