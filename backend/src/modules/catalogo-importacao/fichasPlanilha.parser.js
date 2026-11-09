// Leitor das planilhas "Ficha Técnica 3.2" (Salgados / Doces / Bebidas da Caramelle Café).
//
// SÓ LEITURA e PURO: recebe um workbook do SheetJS (já lido pelo chamador) e devolve uma
// estrutura neutra. Não toca banco, não infere unidade, não cria nada — isso é do planejador.
//
// Layout do modelo (validado contra os 3 arquivos originais — ver docs/caramelle-fichas/):
//   Ingredientes  A=nome B=unidade C=qtd da embalagem D=valor (linhas 2..501)
//   Embalagem     idem (2..301)        MOD  A=função B=salário C=impostos D=valor (2..51)
//   P1..P300      fichas dos produtos: D3 nome · M6 custo total · M7 rendimento · M8 custo unit ·
//                 M12 margem desejada · M18 preço de venda · linhas 6..25 ingredientes, 26..30 bases
//                 (preparações), 31 desperdício de material, 35..44 embalagens, 45 desperdício de
//                 embalagem, 50..55 mão de obra (B função, F minutos por receita, H custo/minuto)
//   B1..B80       preparações intermediárias: D3 nome · M6 custo total (inclui embalagem e MOD) · M7 rendimento ·
//                 K11 unidade do rendimento · 6..25 componentes (23..25 = bases aninhadas) · 26 desperdício ·
//                 30..33 embalagens · 34 desperdício de embalagem · 39..44 mão de obra · 46 custo total
// Valores de fórmula vêm do CACHE gravado no arquivo ("#N/A" é preservado como texto de erro).

import { createRequire } from "node:module";

export const LAYOUT = Object.freeze({
  ingredientes: { aba: "Ingredientes", ate: 501 },
  embalagens: { aba: "Embalagem", ate: 301 },
  mod: { aba: "MOD", ate: 51 },
  fichas: { prefixo: "P", total: 300 },
  bases: { prefixo: "B", total: 80 },
  linhasFicha: { ingredientes: [6, 25], bases: [26, 30], embalagens: [35, 44], mod: [50, 55] },
  // Preparações têm as MESMAS seções da ficha (ingredientes/bases 6..25, embalagem, mão de obra), em outras linhas.
  linhasBase: { componentes: [6, 25], embalagens: [30, 33], mod: [39, 44] },
  // rótulos esperados em colunas B — se diferirem, a aba está FORA do padrão e o planejador avisa
  rotulos: {
    ficha: { B31: "Desperd", B45: "Desperd", B57: "CUSTO TOTAL" },
    base:  { B26: "Desperd", B34: "Desperd", B46: "CUSTO TOTAL" },
  },
});

/** Carrega o SheetJS do projeto (dependência já usada pelo Parser Food Delivery). */
export function lerWorkbook(caminho) {
  const XLSX = createRequire(import.meta.url)("xlsx");
  return XLSX.readFile(caminho, { cellFormula: false, cellStyles: false, cellHTML: false });
}

const colNum = (c) => c.charCodeAt(0) - 64; // 'A' -> 1

function cel(ws, ref) {
  const c = ws?.[ref];
  if (!c) return null;
  if (c.t === "e") return String(c.w ?? "#ERRO");
  return c.v ?? null;
}
const celRC = (ws, r, col) => cel(ws, `${String.fromCharCode(64 + col)}${r}`);

/** Texto "útil": vazio, espaços e o 0 de fórmula sem preenchimento viram null. */
export function texto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "0" ? null : s;
}

function mestre(ws, ate) {
  const out = [];
  if (!ws) return out;
  for (let r = 2; r <= ate; r++) {
    const nome = texto(celRC(ws, r, 1));
    if (!nome) continue;
    out.push({ linha: r, nome, unidade: celRC(ws, r, 2), qtd_embalagem: celRC(ws, r, 3), valor: celRC(ws, r, 4) });
  }
  return out;
}

function rotulosOk(ws, esperado) {
  return Object.entries(esperado).filter(([ref, ini]) => !String(cel(ws, ref) ?? "").toUpperCase().startsWith(ini.toUpperCase())).map(([ref]) => ref);
}

function linhas(ws, [r0, r1], cols) {
  const out = [];
  for (let r = r0; r <= r1; r++) {
    const nome = texto(celRC(ws, r, 2)); // coluna B
    if (!nome) continue;
    const l = { linha: r, nome };
    for (const [k, c] of Object.entries(cols)) l[k] = celRC(ws, r, colNum(c));
    out.push(l);
  }
  return out;
}

const COLS_COMPONENTE = { un: "D", qtd_emb: "E", qtd: "F", valor_emb: "G", unit: "H", total: "I" };
const COLS_MOD = { salario: "D", min_mes: "E", min_rec: "F", unit: "H", total: "I" };

/**
 * @param {import('xlsx').WorkBook} wb
 * @param {string} categoria 'SALGADOS' | 'DOCES' | 'BEBIDAS' (rótulo do arquivo)
 * @param {{arquivo?: string}} [meta]
 */
export function extrairFichas(wb, categoria, meta = {}) {
  const S = wb.Sheets ?? {};
  const out = {
    categoria, arquivo: meta.arquivo ?? null,
    ingredientes: mestre(S[LAYOUT.ingredientes.aba], LAYOUT.ingredientes.ate),
    embalagens: mestre(S[LAYOUT.embalagens.aba], LAYOUT.embalagens.ate),
    mod: [], bases: [], fichas: [],
  };
  const wsMod = S[LAYOUT.mod.aba];
  if (wsMod) {
    for (let r = 2; r <= LAYOUT.mod.ate; r++) {
      const nome = texto(celRC(wsMod, r, 1));
      if (nome) out.mod.push({ linha: r, nome, salario: celRC(wsMod, r, 2), impostos: celRC(wsMod, r, 3), valor: celRC(wsMod, r, 4) });
    }
  }
  for (let i = 1; i <= LAYOUT.bases.total; i++) {
    const ws = S[`${LAYOUT.bases.prefixo}${i}`];
    const nome = texto(cel(ws, "D3"));
    if (!ws || !nome) continue;
    out.bases.push({
      aba: `B${i}`, nome, rendimento: cel(ws, "M7"), unidade_rend: texto(cel(ws, "K11")),
      custo_total: cel(ws, "M6"), custo_unit: cel(ws, "M8"), desperdicio: cel(ws, "G26"), desp_emb: cel(ws, "G34"),
      linhas: linhas(ws, LAYOUT.linhasBase.componentes, COLS_COMPONENTE),
      embalagens: linhas(ws, LAYOUT.linhasBase.embalagens, COLS_COMPONENTE),
      mod: linhas(ws, LAYOUT.linhasBase.mod, COLS_MOD),
      layout_fora_do_padrao: rotulosOk(ws, LAYOUT.rotulos.base),
    });
  }
  for (let i = 1; i <= LAYOUT.fichas.total; i++) {
    const ws = S[`${LAYOUT.fichas.prefixo}${i}`];
    const nome = texto(cel(ws, "D3"));
    if (!ws || !nome) continue;
    out.fichas.push({
      aba: `P${i}`, ficha_no: cel(ws, "B3"), nome,
      rendimento: cel(ws, "M7"), custo_total: cel(ws, "M6"), custo_unit: cel(ws, "M8"),
      margem_desejada: cel(ws, "M12"), preco_venda: cel(ws, "M18"),
      desp_mat: cel(ws, "G31"), desp_emb: cel(ws, "G45"),
      ingredientes: linhas(ws, LAYOUT.linhasFicha.ingredientes, COLS_COMPONENTE),
      bases: linhas(ws, LAYOUT.linhasFicha.bases, COLS_COMPONENTE),
      embalagens: linhas(ws, LAYOUT.linhasFicha.embalagens, COLS_COMPONENTE),
      mod: linhas(ws, LAYOUT.linhasFicha.mod, COLS_MOD),
      layout_fora_do_padrao: rotulosOk(ws, LAYOUT.rotulos.ficha),
    });
  }
  return out;
}
