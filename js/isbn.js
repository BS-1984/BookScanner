// ISBN-Hilfsfunktionen. Intern wird immer ISBN-13 gespeichert.

export function clean(input) {
  return String(input || '').toUpperCase().replace(/[^0-9X]/g, '');
}

export function isValid13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

export function isValid10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

export function to13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

export function to10(isbn13) {
  if (!isbn13.startsWith('978')) return null;
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

// Liefert eine gültige ISBN-13 oder null.
export function normalize(input) {
  const s = clean(input);
  if (s.length === 13 && isValid13(s)) return s;
  if (s.length === 10 && isValid10(s)) return to13(s);
  return null;
}

// Ein EAN-13 ist nur dann ein Buch, wenn er mit 978/979 beginnt ("Bookland").
export function isBookEan(code) {
  return /^97[89]\d{10}$/.test(code) && isValid13(code);
}

// Korrekte Bindestriche bräuchten die Verlagsnummern-Tabelle der ISBN-Agentur;
// daher nur die Ziffern anzeigen.
export function format(isbn13) {
  return isbn13 || '';
}
