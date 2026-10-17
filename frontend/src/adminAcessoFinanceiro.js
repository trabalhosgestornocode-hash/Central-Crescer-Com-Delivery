// Tela "Acesso Financeiro" do Painel SuperAdmin: concessões do Dashboard Financeiro por perfil+unidade.
// Usa SÓ os endpoints /plataforma/gestao-financeira/concessoes (nenhuma lógica de concessão própria). Enquanto o servidor
// disser que as escritas estão bloqueadas (flag + AAL2 recente), conceder/revogar ficam desabilitados e a tela só
// PREPARA e valida os dados — nunca exibe um sucesso que o servidor não confirmou.
import { el, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import {
  escapeHtml, fmtDataHora, pill, secao, tabela, carregando, erro, campo, selecao, area, grade,
  abrirModal, fecharModal, valor, marcado,
} from "./adminUi.js";
import {
  NIVEIS, NIVEL_ROTULO, SITUACAO_ROTULO, SITUACAO_PILL, EVENTO_ROTULO, situacaoDe, estadoDaEscrita,
  validarFormularioConcessao, montarCorpoConcessao, podeRevogar, validarMotivoRevogacao,
} from "./adminAcessoFinanceiroModelo.js";

const sel = { organizacaoId: "", unidadeId: "", incluirRevogadas: false };
const view = () => el("#adm-view");

export async function viewAcessoFinanceiro() {
  view().innerHTML = carregando();
  try {
    const [estado, empresas] = await Promise.all([adminApi.concessoesEstado(), adminApi.empresas({})]);
    const lista = Array.isArray(empresas) ? empresas : (empresas?.empresas ?? empresas?.itens ?? []);
    const unidades = sel.organizacaoId ? await adminApi.unidadesDaEmpresa(sel.organizacaoId).then((r) => (Array.isArray(r) ? r : (r?.unidades ?? []))) : [];
    let concessoes = []; let historico = [];
    if (sel.unidadeId) {
      [concessoes, historico] = await Promise.all([
        adminApi.concessoesLista({ unidadeId: sel.unidadeId, incluirRevogadas: sel.incluirRevogadas }),
        adminApi.concessoesAuditoria({ unidadeId: sel.unidadeId }),
      ]);
    }
    desenhar({ estado: estadoDaEscrita(estado), empresas: lista, unidades, concessoes, historico });
  } catch (e) {
    view().innerHTML = erro("Não foi possível carregar o Acesso Financeiro: " + e.message);
  }
}

function desenhar({ estado, empresas, unidades, concessoes, historico }) {
  const aviso = estado.liberada
    ? `<div class="adm-nota">Escritas liberadas neste ambiente. Cada operação ainda exige verificação em duas etapas recente (até 10 min).</div>`
    : `<div class="adm-nota fin-adm-bloqueio" role="status"><b>Bloqueado.</b> ${escapeHtml(estado.mensagem)} Você pode consultar e preparar os dados, mas conceder e revogar ficam desabilitados.</div>`;

  const filtros = `
    <div class="adm-filtros">
      ${selecao({ id: "fa-org", label: "Empresa", valor: sel.organizacaoId, vazio: "Selecione…",
        opcoes: empresas.map((e) => ({ valor: e.id, rotulo: e.nome })) })}
      ${selecao({ id: "fa-uni", label: "Unidade", valor: sel.unidadeId, vazio: sel.organizacaoId ? "Selecione…" : "Escolha a empresa",
        opcoes: unidades.map((u) => ({ valor: u.id, rotulo: u.nome })) })}
      <label class="adm-campo adm-campo--check"><span>&nbsp;</span>
        <span><input type="checkbox" id="fa-rev" ${sel.incluirRevogadas ? "checked" : ""} /> Incluir revogadas</span></label>
      <div class="adm-filtros-acoes">
        <button class="btn btn-primary btn-sm" data-fin-acao="nova" ${sel.unidadeId ? "" : "disabled"}>Preparar concessão</button>
      </div>
    </div>`;

  const linhas = concessoes.map((c) => {
    const s = situacaoDe(c);
    return [
      `<b>${escapeHtml(c.perfil_nome ?? "—")}</b><br><small>${escapeHtml(c.perfil_email ?? "")}</small>`,
      escapeHtml(NIVEL_ROTULO[c.nivel] ?? c.nivel) + (c.somente_financeiro ? ' <span class="pill info">só financeiro</span>' : ""),
      `<span class="pill ${SITUACAO_PILL[s]}">${SITUACAO_ROTULO[s]}</span>`,
      `${escapeHtml(fmtDataHora(c.concedida_em))}${c.expira_em ? `<br><small>expira ${escapeHtml(fmtDataHora(c.expira_em))}</small>` : ""}`,
      `<small>${escapeHtml(c.motivo ?? "")}</small>${c.motivo_revogacao ? `<br><small><b>Revogação:</b> ${escapeHtml(c.motivo_revogacao)}</small>` : ""}`,
      podeRevogar(c) ? `<button class="btn btn-ghost btn-sm" data-fin-acao="revogar" data-id="${escapeHtml(c.id)}" data-nome="${escapeHtml(c.perfil_nome ?? "")}">Preparar revogação</button>` : "—",
    ];
  });

  const eventos = historico.map((h) => [
    escapeHtml(fmtDataHora(h.ocorreu_em)),
    escapeHtml(EVENTO_ROTULO[h.evento] ?? h.evento),
    escapeHtml(NIVEL_ROTULO[h.nivel] ?? h.nivel ?? "—"),
    `<small>${escapeHtml(String(h.perfil_id).slice(0, 8))}…</small>`,
    `<small>${escapeHtml(h.motivo ?? "—")}</small>`,
  ]);

  view().innerHTML = secao({
    titulo: "Acesso ao Dashboard Financeiro",
    nota: "Concessão explícita por perfil e unidade. Papel de administrador não concede acesso. Revogar vale na próxima requisição e não encerra a sessão operacional.",
    corpo: `<div id="fa-raiz">${aviso}${filtros}
      ${sel.unidadeId ? tabela({ colunas: ["Perfil", "Nível", "Situação", "Concedida", "Motivo", "Ações"], linhas, vazio: "Nenhuma concessão para esta unidade." })
        : '<p class="adm-nota">Escolha a empresa e a unidade para ver as concessões.</p>'}
      ${sel.unidadeId ? `<h3 class="adm-subtitulo">Histórico de auditoria</h3>${tabela({ colunas: ["Quando", "Evento", "Nível", "Perfil", "Motivo"], linhas: eventos, vazio: "Sem eventos registrados." })}` : ""}
    </div>`,
  });
  ligar(estado);
}

function ligar(estado) {
  const raiz = el("#fa-raiz");
  raiz.querySelector("#fa-org")?.addEventListener("change", (e) => { sel.organizacaoId = e.target.value; sel.unidadeId = ""; viewAcessoFinanceiro(); });
  raiz.querySelector("#fa-uni")?.addEventListener("change", (e) => { sel.unidadeId = e.target.value; viewAcessoFinanceiro(); });
  raiz.querySelector("#fa-rev")?.addEventListener("change", (e) => { sel.incluirRevogadas = e.target.checked; viewAcessoFinanceiro(); });
  raiz.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fin-acao]");
    if (!b || b.disabled) return;
    if (b.dataset.finAcao === "nova") abrirPreparoDeConcessao(estado);
    if (b.dataset.finAcao === "revogar") abrirPreparoDeRevogacao(estado, b.dataset.id, b.dataset.nome);
  });
}

async function abrirPreparoDeConcessao(estado) {
  let perfis = [];
  try { perfis = await adminApi.concessoesPerfis(sel.unidadeId); } catch (e) { toast("Erro: " + e.message); return; }
  const bloqueio = estado.liberada ? "" : `<div class="adm-nota fin-adm-bloqueio"><b>Gravação bloqueada.</b> ${escapeHtml(estado.mensagem)}</div>`;
  const corpo = bloqueio + grade(
    selecao({ id: "fa-perfil", label: "Perfil", vazio: "Selecione…",
      opcoes: perfis.map((p) => ({ valor: p.id, rotulo: `${p.nome}${p.email ? ` — ${p.email}` : ""}${p.propria ? " (sua própria conta)" : ""}` })) }) +
    selecao({ id: "fa-nivel", label: "Nível de acesso", vazio: "Selecione…", opcoes: NIVEIS.map((n) => ({ valor: n.valor, rotulo: n.rotulo })) }) +
    campo({ id: "fa-exp", label: "Expira em (opcional)", tipo: "date" }) +
    `<label class="adm-campo adm-campo--check"><span>&nbsp;</span><span><input type="checkbox" id="fa-sofin" /> Entra direto no financeiro (sem escolha de setor)</span></label>` +
    area({ id: "fa-motivo", label: "Motivo (fica na auditoria)", linhas: 3 }),
  ) + `<div id="fa-prev" class="adm-nota" aria-live="polite"></div>`;

  const ler = () => ({ perfilId: valor("fa-perfil"), nivel: valor("fa-nivel"), motivo: valor("fa-motivo"), expiraEm: valor("fa-exp"), somenteFinanceiro: marcado("fa-sofin") });
  const atualizarPrevia = () => {
    const v = validarFormularioConcessao(ler(), { perfis });
    const f = ler();
    el("#fa-prev").innerHTML = v.ok
      ? `Pronta para conceder <b>${escapeHtml(NIVEL_ROTULO[f.nivel])}</b>${f.expiraEm ? ` até ${escapeHtml(f.expiraEm)}` : ""}.${estado.liberada ? "" : " <b>Nada será gravado: a escrita está bloqueada.</b>"}`
      : v.erros.map((x) => `• ${escapeHtml(x)}`).join("<br>");
  };

  abrirModal({
    titulo: "Preparar concessão financeira", corpo, confirmar: "Conceder",
    // Sem botão de confirmar quando bloqueado: não há caminho para "simular" sucesso.
    aoConfirmar: estado.liberada ? async () => {
      const v = validarFormularioConcessao(ler(), { perfis });
      if (!v.ok) throw new Error(v.erros.join(" "));
      const org = sel.organizacaoId;
      await adminApi.conceder(montarCorpoConcessao({ organizacaoId: org, unidadeId: sel.unidadeId, ...ler() }));
      toast("Concessão registrada.");
      viewAcessoFinanceiro();
    } : null,
  });
  for (const id of ["fa-perfil", "fa-nivel", "fa-exp", "fa-motivo", "fa-sofin"]) {
    el(`#${id}`)?.addEventListener("input", atualizarPrevia);
    el(`#${id}`)?.addEventListener("change", atualizarPrevia);
  }
  atualizarPrevia();
}

function abrirPreparoDeRevogacao(estado, id, nome) {
  const bloqueio = estado.liberada ? "" : `<div class="adm-nota fin-adm-bloqueio"><b>Revogação bloqueada.</b> ${escapeHtml(estado.mensagem)} Em emergência, siga o procedimento documentado (docs/gestao-financeira/03-revogacao-emergencial.md).</div>`;
  abrirModal({
    titulo: `Preparar revogação — ${nome || "perfil"}`,
    corpo: bloqueio + `<p class="adm-nota">O acesso financeiro deixa de valer na próxima requisição. A sessão operacional não é encerrada.</p>` +
      area({ id: "fa-motivo-rev", label: "Motivo da revogação (fica na auditoria)", linhas: 3 }),
    confirmar: "Revogar", perigo: true,
    aoConfirmar: estado.liberada ? async () => {
      const v = validarMotivoRevogacao(valor("fa-motivo-rev"));
      if (!v.ok) throw new Error(v.erros.join(" "));
      await adminApi.revogarConcessao(id, valor("fa-motivo-rev"));
      toast("Concessão revogada.");
      viewAcessoFinanceiro();
    } : null,
  });
}

export { fecharModal };
