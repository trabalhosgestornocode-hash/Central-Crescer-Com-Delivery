// Gera FIXTURES SINTÉTICAS da tela Entregadores Próprios a partir do NÚCLEO real (memória): o frontend é testado com o mesmo
// contrato do servidor. Nada de dado real. Uso: node scripts/fv2/fixturesEntregadores.mjs  (escreve em frontend/test/fixtures/)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { somarDias } from "../../src/modules/financeiro-v2/dominio/tempo.js";
import { ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx } from "../../test/financeiro-v2/helpers/cenario.js";

const SEMANAS = ["2026-10-26", "2026-11-02", "2026-11-09"];
const NOMES = [["ana", "Ana Sintética"], ["bruno", "Bruno Sintético"], ["carla", "Carla Sintética"]];
const entrega = (id, chave, nome, data, centavos) => ({ id: `pedido:${id}`, tipo: "ENTREGA", entregadorChave: chave, entregadorNome: nome, data, numeroPedido: String(id), situacao: "Entregue", valorCentavos: centavos, elegivel: true, emRevisao: false });
const fonte = { apurar: async (p) => ({ disponivel: true, dias: Array.from({ length: 7 }, (_, i) => ({ data: somarDias(p.inicio, i), fonte: "foody", provisorio: false, aberto: false, triagem: 0 })),
  entregas: NOMES.flatMap(([k, n], j) => Array.from({ length: 3 + j }, (_, i) => entrega(`${p.inicio}-${k}-${i}`, k, n, somarDias(p.inicio, i % 7), 650 + 50 * j))) }) };
const estado = { agora: "2026-11-23T12:00:00.000Z" };
const cofre = criarCofreMemoria();
const n = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date(estado.agora), cofre, entregadores: { fonte, inicioDaOperacao: SEMANAS[0], cofreDeNotas: cofre } });
const c = ctx(ORG_A, UNI_A, TODAS);
await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
for (const s of SEMANAS) await n.fecharSemanaDeEntregadores(c, { inicio: s });
await n.registrarExtraDoEntregador(c, { entregador: "ana", entregadorNome: "Ana Sintética", data: "2026-11-12", descricao: "Entrega extra no evento", valorCentavos: 2500, situacao: "PENDENTE", justificativa: "Fixture sintética." });
const pdf = { conteudo: new Uint8Array(Buffer.from("%PDF-1.4 nota sintetica")), nome: "nf.pdf", tipoMime: "application/pdf" };
await n.anexarDocumentoDoEntregador(c, { inicio: "2026-11-09", entregador: "bruno", tipoAnexo: "NOTA_FISCAL", numero: "77", emitente: "Bruno Sintético", tomador: "Loja Sintética", valorCentavos: 2800, arquivo: pdf });

const fechada = await n.consultarEntregadoresProprios(c, { selecao: "ULTIMA_FECHADA" });
const aguardando = await n.consultarEntregadoresProprios(c, { semana: "2026-11-16" });
const vazia = await n.consultarEntregadoresProprios(ctx(ORG_A, "00000000-0000-4000-8000-0000000000b9", TODAS), { selecao: "ULTIMA_FECHADA" }).catch(() => null);
const cadastro = {
  dados: { ligado: true, unidadeAtendida: true, itens: [], notas: [], envios: [], cadastros: [
    { id: "1", chave: "ana", telefone: "…0011", nome: "Ana", observacoes: "Turno da noite", ativo: true, criadoEm: "2026-11-23T09:00:00.000Z", envio: "APTO" },
    { id: "2", chave: "ana", telefone: "…0099", nome: "Ana", observacoes: null, ativo: false, criadoEm: "2026-11-20T09:00:00.000Z", revogadoEm: "2026-11-23T09:00:00.000Z", motivoRevogacao: "TROCA_DE_NUMERO" },
    { id: "3", chave: "carla", telefone: "…0033", nome: "Carla Sintética", observacoes: null, ativo: false, criadoEm: "2026-11-21T09:00:00.000Z", revogadoEm: "2026-11-22T09:00:00.000Z", motivoRevogacao: "DESATIVADO" },
  ] },
  oficiais: { itens: NOMES.map(([k, nome]) => ({ chave: k, nome, ultimaSemana: "2026-11-09" })) },
};
const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../frontend/test/fixtures");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "entregadores-fechada.json"), JSON.stringify(fechada, null, 1));
writeFileSync(join(dir, "entregadores-aguardando.json"), JSON.stringify(aguardando, null, 1));
writeFileSync(join(dir, "entregadores-cadastro.json"), JSON.stringify(cadastro, null, 1));
if (vazia) writeFileSync(join(dir, "entregadores-vazia.json"), JSON.stringify(vazia, null, 1));
console.log("fixtures:", fechada.semana.inicio, fechada.semana.situacao, "|", aguardando.semana.inicio, aguardando.semana.situacao, "| vazia:", Boolean(vazia));
