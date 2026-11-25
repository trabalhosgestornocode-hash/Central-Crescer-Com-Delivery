#!/usr/bin/env node
// MOVA CORE — §6: AVALIAÇÃO REAL das ferramentas do Agente Crescer pelo MOVA (Claude Haiku 5.5, chave EXCLUSIVA de teste).
// Executores REAIS do agente (produto/CMV, ranking de produtos, ranking de insumos) com dependências SINTÉTICAS injetadas
// (sem banco, sem rede além do modelo) + a base financeira sintética (base.mjs). Perguntas que CRUZAM operação e financeiro.
// Expectativas escritas ANTES da primeira rodada; o SHA-256 deste arquivo vai no resultado.
//   node --env-file=.env.mova-teste scripts/mova-core/avaliacao/agente-crescer-real.mjs [--max-usd=0.05]
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarMovaCore, criarOrcamentoMemoria, LIMITES_HOMOLOGACAO, ferramentasDoAgenteCrescer } from "../../../src/modules/mova-core/index.js";
import { valoresDoTexto } from "../../../src/modules/mova-core/verificador.js";
import * as produtoCmv from "../../../src/modules/agente/tools/produtoCmv.tool.js";
import * as produtosRanking from "../../../src/modules/agente/tools/produtosCmvRanking.tool.js";
import * as insumosRanking from "../../../src/modules/agente/tools/insumosRanking.tool.js";
import { MODULOS } from "../../../src/shared/modulos.js";
import { PERMISSOES } from "../../../src/shared/permissoes.js";
import { CENTRO, HOJE, ORG, UNIDADES, USUARIO, criarPortaSintetica } from "./base.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const MAX_USD = Number(args["max-usd"] ?? 0.05);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const dirR = join(AQUI, "resultados");
const gasto = readdirSync(dirR).filter((f) => /^real-.*\.json$/.test(f)).reduce((a, f) => a + (JSON.parse(readFileSync(join(dirR, f), "utf8")).orcamento?.gastoMicrousd ?? 0), 0) / 1e6;
console.log(`gasto acumulado: US$ ${gasto.toFixed(6)} de US$ 1; teto desta rodada US$ ${MAX_USD}`);
if (gasto + MAX_USD > 1 + 1e-9) throw new Error("recusado: passaria do limite cumulativo de US$ 1");
const chave = process.env.MOVA_CORE_ANTHROPIC_KEY_TESTE;
if (!chave) throw new Error("Defina MOVA_CORE_ANTHROPIC_KEY_TESTE em .env.mova-teste");
if (["ANTHROPIC_API_KEY", "MOVA_ANTHROPIC_API_KEY", "MOVA_IA_CHAVE", "AGENTE_ANTHROPIC_API_KEY"].map((k) => process.env[k]).includes(chave)) throw new Error("chave de teste igual a uma de produção: recusado");
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const cliente = new Anthropic({ apiKey: chave, maxRetries: 2 });
const orcamento = criarOrcamentoMemoria({ ...LIMITES_HOMOLOGACAO, diarioMicrousd: Math.round(MAX_USD * 1e6) }, { totalMicrousd: Math.round(MAX_USD * 1e6) });

// ---------------------------------------------------------------- dados SINTÉTICOS do módulo de produtos/insumos
const PRODUTOS = [
  { id: "p1", nome: "BMT 15cm", tipo: "sanduiche", tamanho: "15cm", ativo: true, ficha: true, linha: { preco: 29.9, custo: 8.72, comissao_pct: 0, lucro_liquido: 21.18, cmv_pct: 29.16 } },
  { id: "p2", nome: "Frango Teriyaki 15cm", tipo: "sanduiche", tamanho: "15cm", ativo: true, ficha: false, linha: { preco: 31.9, custo: 9.4, comissao_pct: 0, lucro_liquido: 22.5, cmv_pct: 29.47 } },
  { id: "p3", nome: "Cookie", tipo: "sobremesa", tamanho: null, ativo: true, ficha: true, linha: { preco: 7.5, custo: 3.9, comissao_pct: 0, lucro_liquido: 3.6, cmv_pct: 52 } },
];
const INSUMOS = [
  { nome: "Queijo cheddar", categoria: "laticinio", categoria_rotulo: "Laticínios", unidade_base: "kg", custo_unitario: 54.8, sem_custo: false, ativo: true, preco_atualizado_em: "2026-11-10" },
  { nome: "Pão italiano", categoria: "pao", categoria_rotulo: "Pães", unidade_base: "un", custo_unitario: 1.35, sem_custo: false, ativo: true, preco_atualizado_em: "2026-11-12" },
  { nome: "Frango desfiado", categoria: "proteina", categoria_rotulo: "Proteínas", unidade_base: "kg", custo_unitario: 38.9, sem_custo: false, ativo: true, preco_atualizado_em: "2026-11-05" },
  { nome: "Molho teriyaki", categoria: "molho", categoria_rotulo: "Molhos", unidade_base: "l", custo_unitario: null, sem_custo: true, ativo: true, preco_atualizado_em: null },
];
const linhaDe = (p) => ({ produto_id: p.id, nome: p.nome, canal: "balcao", tabela: "E", desatualizado: false, ...p.linha });
const depsProduto = {
  buscarCandidatos: async ({ termoBusca }) => PRODUTOS.filter((p) => norm(p.nome).includes(norm(termoBusca).split(" ")[0])),
  margemProduto: async (x) => { const id = x?.produtoId ?? x?.id ?? x; const p = PRODUTOS.find((y) => y.id === id); return p ? [linhaDe(p)] : []; },
  obterProduto: async (x) => { const id = x?.produtoId ?? x?.id ?? x; const p = PRODUTOS.find((y) => y.id === id) ?? PRODUTOS[0];
    return { qtd_componentes: 3, status_ficha: { chave: p.ficha ? "completa" : "incompleta", label: p.ficha ? "Completa" : "Incompleta", ok: p.ficha }, custo_manual: null, custo_calculado: p.linha.custo, ficha: [] }; },
  resolverTabelas: async () => ({ tabelaBalcao: "E", tabelaIfood: null }),
};
const depsRanking = { listarMargens: async () => PRODUTOS.map(linhaDe), listarProdutosMeta: async () => PRODUTOS.map(({ id, nome, tipo, ativo, tamanho }) => ({ id, nome, tipo, ativo, tamanho })), resolverTabela: async () => "E" };
const depsInsumos = { listarInsumos: async () => ({ itens: INSUMOS }) };
const registro = [
  { definicao: produtoCmv.definicao, executar: (i, c) => produtoCmv.executar(i, c, depsProduto), access: { module: MODULOS.PRODUTOS_CMV, permission: PERMISSOES.CMV_VER }, mode: "read", risk: "low" },
  { definicao: produtosRanking.definicao, executar: (i, c) => produtosRanking.executar(i, c, depsRanking), access: { module: MODULOS.PRODUTOS_CMV, permission: PERMISSOES.CMV_VER }, mode: "read", risk: "low" },
  { definicao: insumosRanking.definicao, executar: (i, c) => insumosRanking.executar(i, c, depsInsumos), access: { module: MODULOS.INGREDIENTS, permission: PERMISSOES.INSUMOS_VER }, mode: "read", risk: "low" },
];
const ACESSO = { modulos: [MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS], permissoes: [PERMISSOES.CMV_VER, PERMISSOES.INSUMOS_VER], impersonando: false };
const SEM_CMV = { modulos: [MODULOS.INGREDIENTS], permissoes: [PERMISSOES.INSUMOS_VER], impersonando: false };

// ---------------------------------------------------------------- casos (cruzam operação × financeiro)
const ag = (n) => `crescer_${n}`;
const CASOS = [
  { id: "AC1-cmv-bmt", pergunta: "qual o CMV do BMT no balcão?", ferramentas: [ag("consultar_produto_cmv")], valores: [872], textoDeve: [String.raw`29[,.]1|29[,.]2`] },
  { id: "AC2-insumos-caros", pergunta: "quais os insumos mais caros que a gente usa?", ferramentas: [ag("listar_insumos")], valores: [5480], textoDeve: ["cheddar"] },
  { id: "AC3-pior-margem-e-divida", pergunta: "qual produto tem o CMV mais alto em percentual, e quanto ainda devemos pra Laticínios?", ferramentas: [ag("listar_produtos_cmv"), "contas_a_pagar"], valores: [16400], textoDeve: ["cookie"] },
  { id: "AC4-ficha-incompleta", pergunta: "qual a margem do frango teriyaki?", ferramentas: [ag("consultar_produto_cmv")], valores: [], textoDeve: [String.raw`(incomplet|nao (esta )?validad|ficha)`] },
  { id: "AC5-insumo-sem-custo", pergunta: "quanto custa o litro do molho teriyaki?", ferramentas: [ag("listar_insumos")], valores: [], textoDeve: [String.raw`(sem (custo|preco)|nao (tem|ha|esta) (custo|preco|cadastrad)|nao (foi )?informad)`], textoNaoDeve: [String.raw`r\$ ?0,00`] },
  { id: "AC6-sem-permissao-cmv", pergunta: "qual o CMV do BMT?", acesso: SEM_CMV, ferramentas: [], valores: [], textoNaoDeve: ["8,72", String.raw`29[,.]1`], textoDeve: [String.raw`(permiss|acesso|nao (consigo|tenho|posso))`] },
  { id: "AC7-cmv-produto-x-dre", pergunta: "o CMV do BMT na ficha é o mesmo CMV que aparece na DRE de novembro?", ferramentas: [ag("consultar_produto_cmv")], valores: [], textoDeve: [String.raw`(ficha|produto).{0,200}(dre|periodo|mes)|(dre|periodo|mes).{0,200}(ficha|produto)`] },
];

// ---------------------------------------------------------------- execução
const linhas = [];
for (const c of CASOS) {
  const acesso = c.acesso ?? ACESSO;
  const extras = ferramentasDoAgenteCrescer(registro, { resolverAcesso: async () => acesso, acessoInicial: acesso });
  const core = criarMovaCore({ porta: criarPortaSintetica(), cliente, orcamento, ferramentasExtras: extras, opcoes: { modelo: "claude-haiku-5-5" } });
  let r; try {
    r = await core.responder({ organizacaoId: ORG, conversaId: c.id, participanteId: "p", usuarioId: USUARIO, unidadeId: CENTRO, unidadesPermitidas: UNIDADES, perfil: { nome: "FINANCEIRO", consultas: "TODAS" }, podeValores: true, texto: c.pergunta, hoje: HOJE, requisicaoId: randomUUID() });
  } catch (e) { r = { motivo: `ERRO: ${e?.message ?? e}`, texto: "", ferramentas: [], uso: { custoMicrousd: 0 } }; }
  const usadas = (r.ferramentas ?? []).filter((x) => x.ok).map((x) => x.nome);
  const txt = norm(r.texto);
  const v = valoresDoTexto(r.texto ?? "").map((x) => x.valorCentavos);
  const l = { caso: c.id, pergunta: c.pergunta, resposta: r.texto, motivo: r.motivo, ferramentas: (r.ferramentas ?? []).map((x) => `${x.nome}${x.ok ? "" : `!${x.codigo ?? ""}`}`),
    ferramentaOk: c.ferramentas.every((f) => usadas.includes(f)) && (c.ferramentas.length || !usadas.some((n) => n.startsWith("crescer_consultar_produto"))),
    valoresOk: c.valores.every((x) => v.includes(x)), textoOk: (c.textoDeve ?? []).every((x) => new RegExp(x).test(txt)) && !(c.textoNaoDeve ?? []).some((x) => new RegExp(x).test(txt)),
    verificador: r.verificacao?.ok ?? null, custoMicrousd: r.uso?.custoMicrousd ?? 0, latenciaMs: r.latenciaMs ?? 0 };
  l.ok = l.ferramentaOk && l.valoresOk && l.textoOk && r.motivo === "RESPONDIDO";
  linhas.push(l);
  console.log(`${l.ok ? "OK    " : "FALHOU"} ${c.id} [${l.ferramentas.join(", ")}] ${r.motivo}\n   > ${String(r.texto).replace(/\n+/g, " ").slice(0, 300)}`);
}
const hash = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);
const saida = { modo: "REAL claude-haiku-5-5 — §6 Agente Crescer (executores reais, dependências sintéticas)", em: new Date().toISOString(), versoes: { "agente-crescer-real.mjs": hash },
  resumo: { casos: linhas.length, corretos: `${linhas.filter((l) => l.ok).length}/${linhas.length}`, ferramenta: `${linhas.filter((l) => l.ferramentaOk).length}/${linhas.length}`, valores: `${linhas.filter((l) => l.valoresOk).length}/${linhas.length}`, texto: `${linhas.filter((l) => l.textoOk).length}/${linhas.length}`, custoUsd: Math.round(linhas.reduce((a, l) => a + l.custoMicrousd, 0)) / 1e6 },
  linhas, orcamento: orcamento.resumo() };
const arq = join(dirR, `real-agente-crescer-${saida.em.slice(0, 19).replace(/[:T]/g, "-")}.json`);
writeFileSync(arq, JSON.stringify(saida, null, 2));
console.log("\n", JSON.stringify(saida.resumo), "\narquivo:", arq);
