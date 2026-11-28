// Documentos SINTÉTICOS com dígitos verificadores válidos (nunca de pessoa real).
export const cnpj = (base) => { // base: 12 dígitos
  const d = String(base).padStart(12, "0").split("").map(Number);
  const dv = (a, p) => { const s = a.reduce((t, x, i) => t + x * p[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); const d2 = dv([...d, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...d, d1, d2].join("");
};
export const cpf = (base) => { // base: 9 dígitos
  const d = String(base).padStart(9, "0").split("").map(Number);
  const dv = (a) => { const s = a.reduce((t, x, i) => t + x * (a.length + 1 - i), 0) * 10 % 11; return s === 10 ? 0 : s; };
  const d1 = dv(d), d2 = dv([...d, d1]); return [...d, d1, d2].join("");
};
