// Execução 09 — CONTRASTE (WCAG 2.x) dos componentes críticos do Financeiro v2, medido a partir dos tokens REAIS de
// fv2.css, nos temas claro e escuro. Texto normal exige 4,5:1; texto grande (≥ 18,66 px em negrito) exige 3:1.
// Não substitui a inspeção visual: cores calculadas por elementos sobrepostos, imagens e foco não entram aqui.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../financeiro-v2/fv2.css", import.meta.url), "utf8");
const tokens = (trecho) => Object.fromEntries([...trecho.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
// Tema escuro = o da plataforma (data-theme="dark", aplicado por financeiro-v2/tema.js com a regra de src/tema.js), não a preferência do sistema.
const inicioEscuro = css.indexOf(":root[data-theme=\"dark\"]");
const CLARO = tokens(css.slice(0, inicioEscuro));
const ESCURO = { ...CLARO, ...tokens(css.slice(inicioEscuro, css.indexOf("* { box-sizing"))) };
const luminancia = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const razao = (a, b) => { const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const cor = (t, nome) => (nome.startsWith("#") ? nome : t[nome]);

// [texto, fundo, componente, mínimo]
const PARES = [
  ["texto", "bg", "corpo da página", 4.5], ["texto", "card", "texto em cartões, tabelas e painéis", 4.5],
  ["suave", "card", "notas (12 px)", 4.5], ["suave", "bg", "notas e selo neutro no fundo", 4.5],
  ["marca-texto", "card", "links de ação (Detalhar, pendências)", 4.5], ["#ffffff", "marca-escura", "botão primário e navegação ativa", 4.5],
  ["ok", "ok-bg", "selo ok (12 px)", 4.5], ["info", "info-bg", "selo info", 4.5], ["alerta", "alerta-bg", "selo alerta", 4.5], ["erro", "erro-bg", "selo erro", 4.5],
  ["info", "card", "aviso", 4.5], ["alerta", "card", "aviso de alerta (pagamento antecipado, bloqueios)", 4.5], ["erro", "card", "aviso de erro", 4.5],
  ["marca", "card", "logotipo (20 px, texto grande)", 3],
];

for (const [tema, t] of [["claro", CLARO], ["escuro", ESCURO]]) {
  test(`contraste — tema ${tema}: componentes críticos atendem WCAG AA`, () => {
    const falhas = PARES.map(([a, b, nome, min]) => ({ nome, valor: razao(cor(t, a), cor(t, b)), min })).filter((x) => x.valor < x.min);
    assert.deepEqual(falhas.map((f) => `${f.nome}: ${f.valor.toFixed(2)} < ${f.min}`), []);
  });
}
