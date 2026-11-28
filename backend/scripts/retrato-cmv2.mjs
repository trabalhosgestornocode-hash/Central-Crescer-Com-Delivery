// Retrato SOMENTE LEITURA das respostas da API Produtos/CMV 2.0 por organização (para revisão visual local).
// Chama apenas funções de leitura/prévia (nenhuma aplica nada). Uso:
//   node --env-file=<.env> scripts/retrato-cmv2.mjs <saida.json> <orgId>...
import { writeFileSync } from "node:fs";
import * as s from "../src/modules/produtos/produtosCmv.service.js";

const [saida, ...orgs] = process.argv.slice(2);
const out = {};
for (const organizacaoId of orgs) {
  const saude = await s.saude({ organizacaoId });
  const pend = await s.pendencias({ organizacaoId });
  const rend = await s.previaRendimentos({ organizacaoId });
  const homol = await s.previaHomologacao({ organizacaoId });
  const custoZero = {};
  for (const c of pend.causas_raiz.filter((x) => x.codigo === "insumo_sem_custo")) custoZero[c.alvo.id] = await s.previaCustoZero({ organizacaoId, insumoId: c.alvo.id });
  const alvos = [...new Set([...rend.itens.slice(0, 3).map((i) => i.produto_id), ...pend.produtos.filter((p) => p.tipo !== "submontagem").slice(0, 3).map((p) => p.id), ...pend.produtos.slice(0, 2).map((p) => p.id)])];
  const recuperacao = {}; const simulacao = {};
  for (const id of alvos) {
    recuperacao[id] = await s.recuperarFicha({ organizacaoId, produtoId: id });
    simulacao[id] = await s.simular({ organizacaoId, produtoId: id, preco: 24.9, metaCmv: 0.3, margemContribuicaoAlvo: 0.25 }).catch((e) => ({ erro: e.message }));
  }
  out[organizacaoId] = { saude, pend, rend, homol, custoZero, recuperacao, simulacao, mentoria: await s.indicadoresMentoria({ organizacaoId }) };
  console.error("ok", organizacaoId, pend.produtos.length);
}
writeFileSync(saida, JSON.stringify(out));
