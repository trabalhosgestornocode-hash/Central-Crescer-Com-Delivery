// FONTE DE DADOS do Centro Financeiro (MOVA, Execução 03).
//   1. Na plataforma (?modo=plataforma) ou num servidor que responda /api/fv2: lê a API REAL do MOVA (sessão da plataforma;
//      a unidade é SEMPRE a da sessão; as permissões vêm do servidor e o servidor confere de novo em cada ação).
//   2. MOVA desligado no servidor (404 MOVA_DESLIGADO): estado real "desligado", sem dados inventados.
//   3. Sem API (arquivo estático / demonstração local): dados SINTÉTICOS de centroFinanceiroSimulacao.js, com a faixa "Simulação".
import { CAIXA, CONFIGURACAO, UNIDADES } from "./centroFinanceiroSimulacao.js";
import { criarTransportePlataforma, credenciaisDaPlataforma, emModoPlataforma, renovarCredenciaisDaPlataforma } from "./plataforma.js";
import { definirTransporte, enviar } from "./consulta.js";

const NIVEL2 = ["financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.registrar"];
let transporte = (...a) => fetch(...a);

async function ler(url) {
  const r = await transporte(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
  const dados = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, dados };
}

export function simulacao() {
  return { fonte: "SIMULACAO", unidades: UNIDADES, caixaPorUnidade: CAIXA, configuracao: CONFIGURACAO, estadoMova: null, permissoes: [], contas: [], podeDecidir: false };
}

/** @returns {Promise<object>} dados normalizados para as telas */
export async function carregarDados() {
  if (emModoPlataforma()) {
    transporte = criarTransportePlataforma({ credenciais: credenciaisDaPlataforma, renovar: renovarCredenciaisDaPlataforma });
    definirTransporte(transporte);
  }
  let sessao;
  try { sessao = await ler("/api/fv2/sessao"); } catch { return simulacao(); }
  if (!sessao.ok || !sessao.dados?.unidades?.length) return emModoPlataforma() ? { fonte: "ERRO", mensagem: sessao.dados?.mensagem ?? "Não foi possível abrir a sessão financeira." } : simulacao();
  const u = sessao.dados.unidades[0];
  const caixa = await ler("/api/fv2/mova/caixa");
  if (caixa.status === 404 && caixa.dados?.codigo === "MOVA_DESLIGADO") return { fonte: "MOVA_DESLIGADO", unidade: u };
  if (!caixa.ok) return { fonte: "ERRO", mensagem: caixa.dados?.mensagem ?? "Não foi possível ler a Caixa de Entrada." };
  const [estadoMova, contas, erros] = await Promise.all([ler("/api/fv2/mova/estado"), ler("/api/fv2/caixa-e-bancos"), ler("/api/fv2/mova/erros")]);
  const itens = [...caixa.dados.itens, ...caixa.dados.aguardandoUnidade];
  const incompleta = itens.some((i) => i.proposta?.bloqueioDeAplicacao === "REQUISITOS_FINANCEIROS_INCOMPLETOS");
  return {
    fonte: "API",
    unidades: [{ unidadeId: u.id, nome: u.nome, requisitosCompletos: !incompleta, fontes: null }],
    caixaPorUnidade: { [u.id]: caixa.dados },
    configuracao: { ...CONFIGURACAO, grupos: null, canal: "Gateway próprio (Baileys) — configuração no servidor" },
    estadoMova: estadoMova.ok ? estadoMova.dados : null,
    permissoes: u.permissoes ?? [],
    podeDecidir: NIVEL2.every((p) => (u.permissoes ?? []).includes(p)) && sessao.dados.escritaHabilitada === true,
    podeConfigurar: (u.permissoes ?? []).includes("financeiro_v2.configurar") && sessao.dados.escritaHabilitada === true,
    podeAbrirDocumentos: (u.permissoes ?? []).includes("financeiro_v2.documentos"),
    homologacao: estadoMova.ok && estadoMova.dados?.chaves?.modo === "HOMOLOGACAO",
    erros: erros.ok ? erros.dados?.itens ?? [] : [],
    contas: (contas.ok ? contas.dados?.contas ?? [] : []).filter((c) => c.ativa !== false).map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo })),
  };
}

/** Ações do administrador (o servidor confere permissão, unidade e estado; aqui só se envia). */
export const acoes = Object.freeze({
  aplicar: (propostaId, contaId) => enviar("/api/fv2/acoes/mova/aplicar", { propostaId, ...(contaId ? { contaId } : {}) }),
  rejeitar: (propostaId, motivo) => enviar("/api/fv2/acoes/mova/rejeitar", { propostaId, motivo }),
  async classificar(propostaId, categoria) {
    const d = await ler(`/api/fv2/mova/proposta?id=${encodeURIComponent(propostaId)}`); // versão atual (concorrência otimista)
    if (!d.ok) return { ok: false, mensagem: d.dados?.mensagem ?? "Proposta indisponível." };
    return enviar("/api/fv2/acoes/mova/classificar", { propostaId, versao: d.dados.versao, categoria });
  },
  reprocessar: (eventoId) => enviar("/api/fv2/acoes/mova/reprocessar", { eventoId }),
  controle: (alteracoes) => enviar("/api/fv2/acoes/mova/controle", alteracoes),
  async arquivo(sha) {
    const d = await ler(`/api/fv2/mova/arquivo?sha=${encodeURIComponent(sha)}`);
    return d.ok ? { ok: true, ...d.dados } : { ok: false, mensagem: d.dados?.mensagem ?? "Documento indisponível." };
  },
});
