#!/usr/bin/env node
// Mede a importação de um relatório GRANDE (Conciliação do iFood, ~13,5 mil movimentos SINTÉTICOS) no PostgreSQL LOCAL isolado.
// Conta as idas ao banco de cada etapa e, com FV2_LATENCIA_MS, soma uma espera por consulta (simula banco remoto).
//
//   FV2_LATENCIA_MS=0 FV2_PEDIDOS=2260 node --test scripts/fv2/desempenhoImportacao.mjs
//
// Usa o mesmo ambiente dos testes (scripts/fv2-banco-teste.mjs iniciar). Nada é lido do .env; nenhum dado real.
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ctx, montar } from "../../test/financeiro-v2/helpers/cenario.js";
import { texto } from "../../test/financeiro-v2/helpers/arquivos.js";
import { motivoParaPular } from "../../test/financeiro-v2/helpers/postgres.js";

const LATENCIA = Number(process.env.FV2_LATENCIA_MS ?? 0);
const PEDIDOS = Number(process.env.FV2_PEDIDOS ?? 2260);
let consultas = 0;
const original = pg.Client.prototype.query;
const LENTAS = Number(process.env.FV2_MOSTRAR_LENTAS_MS ?? 0);
const medir = (texto, promessa) => {
  if (!LENTAS || !promessa?.then) return promessa;
  const t0 = performance.now();
  return promessa.then((r) => { const ms = performance.now() - t0; if (ms >= LENTAS) console.log(`  lenta ${Math.round(ms)} ms: ${String(texto?.text ?? texto).slice(0, 70)}`); return r; });
};
pg.Client.prototype.query = function (...a) {
  consultas += 1;
  if (typeof a[a.length - 1] === "function") return original.apply(this, a);
  if (!LATENCIA) return medir(a[0], original.apply(this, a));
  return new Promise((ok) => { setTimeout(ok, LATENCIA); }).then(() => medir(a[0], original.apply(this, a)));
};

const COLUNAS = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const hex = (i, n) => i.toString(16).padStart(n, "0");

/** ~6 movimentos por pedido; um saldo (id_saldo) por dia, que fecha com a soma das linhas que impactam o repasse. */
function relatorio(pedidos) {
  const porDia = new Map();
  for (let i = 0; i < pedidos; i += 1) {
    const dia = `2026-11-${String(1 + (i % 17)).padStart(2, "0")}`;
    const pedido = `${hex(i, 8)}-0000-4000-8000-${hex(i, 12)}`;
    const cesta = 30 + (i % 40);
    const linhas = [
      ["Venda", "Entrada Financeira", "Entrada Financeira", cesta - 1, "SIM"],
      ["Venda", "Subsídio", "Promoção custeada pela loja", -5, "NÃO"],
      ["Venda", "Subsídio", "Promoção custeada pelo iFood", 4, "SIM"],
      ["Venda", "Retenção", "Taxa de serviço iFood cobrada do cliente", -1, "SIM"],
      ["Venda", "Cobrança", "Comissão do iFood (entrega própria da loja)", -(cesta * 0.12).toFixed(2) * 1, "SIM"],
      ["Venda", "Cobrança", "Taxa de transação", -(cesta * 0.032).toFixed(2) * 1, "SIM"],
    ].map(([fato, tipo, desc, valor, impacto]) => ({ fato, tipo, desc, valor, impacto, pedido, dia, cesta }));
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(...linhas);
  }
  const saida = [COLUNAS.join(";")];
  for (const [dia, linhas] of porDia) {
    const saldo = Math.round(linhas.filter((l) => l.impacto === "SIM").reduce((s, l) => s + Math.round(l.valor * 100), 0)) / 100;
    for (const l of linhas) {
      const v = { competencia: "2026-11", fato_gerador: l.fato, tipo_lancamento: l.tipo, descricao_lancamento: l.desc, valor: l.valor, base_calculo: 0, percentual_taxa: 0, pedido_associado_ifood: l.pedido, pedido_associado_ifood_curto: l.pedido.slice(0, 4), motivo_cancelamento: "", data_criacao_pedido_associado: `${dia}T12:00:00.000Z`, data_repasse_esperada: "2026-12-02", valor_transacao: saldo, loja_id: "LOJA-SINTETICA", cnpj: "00000000000000", data_faturamento: `${dia}T12:30:00.000Z`, data_apuracao_inicio: dia, data_apuracao_fim: dia, valor_cesta_final: l.cesta, responsavel_transacao: "IFOOD", impacto_no_repasse: l.impacto, id_saldo: `S-${dia}`, metodo_pagamento: "Pix" };
      saida.push(COLUNAS.map((k) => v[k]).join(";"));
    }
  }
  return texto(saida.join("\n"));
}

const pular = motivoParaPular();
test(`importação de ${PEDIDOS * 6} movimentos (latência simulada ${LATENCIA} ms por consulta)`, { skip: pular, timeout: 3_600_000 }, async () => {
  const c = ctx();
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00.000Z") });
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" }).catch(() => {});
  const conteudo = relatorio(PEDIDOS);
  const etapa = async (nome, fn) => {
    const q0 = consultas; const t0 = performance.now();
    const r = await fn();
    const ms = performance.now() - t0;
    console.log(`${nome.padEnd(12)} ${String(Math.round(ms)).padStart(8)} ms  ${String(consultas - q0).padStart(7)} consultas`);
    return r;
  };
  const rec = await etapa("receber", () => n.receberArquivoParaImportacao(c, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo, periodoInicio: "2026-11-01", periodoFim: "2026-11-17" }));
  assert.equal(rec.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(rec.previa.erros?.slice(0, 3)));
  assert.equal(rec.previa.contagens.novos, PEDIDOS * 6);
  const conf = await etapa("confirmar", () => n.confirmarImportacao(c, { importacaoId: rec.importacao.id, impressaoPrevia: rec.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Ensaio de desempenho sintético." }));
  assert.equal(conf.relatorio.inseridos, PEDIDOS * 6);
  const previa = await etapa("previa", () => n.previaDaConciliacaoIfood(c, { importacaoId: rec.importacao.id }));
  await etapa("aplicar", () => n.aplicarConciliacaoIfood(c, { importacaoId: rec.importacao.id, justificativa: "Ensaio de desempenho sintético." }));
  const repetida = await etapa("repetir", () => n.receberArquivoParaImportacao(c, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo, periodoInicio: "2026-11-01", periodoFim: "2026-11-17" }));
  assert.equal(repetida.repetido, true, "o mesmo arquivo devolve a importação existente");
  console.log(`líquido ${previa.valores.liquidoCentavos} · lançamentos ${previa.lancamentos.criar}`);
});
