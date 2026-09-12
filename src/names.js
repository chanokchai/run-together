export function normalizeName(name) {
  return String(name ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
