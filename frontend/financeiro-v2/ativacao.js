// Página do PROCEDIMENTO DE ATIVAÇÃO (Execução 10): administrador da empresa provisiona a administração financeira inicial
// e libera/desliga SÓ a unidade da sessão. Mesmo login e contexto da Crescer (plataforma.js); a decisão é do servidor
// (administrador da empresa, TOTP recente, sem autoconcessão, unidade da sessão). Nada é escolhido automaticamente.
import { criarConsultor, definirTransporte, enviar } from "./consulta.js";
import { credenciaisDaPlataforma, criarTransportePlataforma, estadoDoErro } from "./plataforma.js";
import { esc } from "./formatar.js";

definirTransporte(criarTransportePlataforma({ credenciais: credenciaisDaPlataforma }));
const $ = (s) => document.querySelector(s);
const MOTIVOS = {
  SEM_AUTORIDADE_ADMINISTRATIVA: "Só o administrador da empresa pode ativar o Financeiro v2.",
  PROVISIONAMENTO_DESLIGADO: "O procedimento de ativação não está ligado no servidor.",
};
const mensagem = (r) => MOTIVOS[r.motivo] ?? MOTIVOS[r.erro] ?? estadoDoErro(r).mensagem ?? r.mensagem;

async function carregar() {
  const r = await criarConsultor().consultar("/api/fv2/administracao/contexto");
  $("#conteudo").removeAttribute("aria-busy");
  if (!r) return;
  if (!r.ok) { $("#ctx").textContent = mensagem(r); for (const f of document.querySelectorAll("form")) f.hidden = true; return; }
  const d = r.dados;
  $("#ctx").innerHTML = `<p><strong>${esc(d.organizacao.nome ?? "Empresa")}</strong> · ${esc(d.unidade.nome ?? "Unidade")}</p>
    <p class="estado-detalhe">Empresa: ${esc(d.organizacao.id)} · Unidade: ${esc(d.unidade.id)}</p>
    <p>Situação: empresa ${d.liberacao.empresa ? "liberada" : "não liberada"} · unidade ${d.liberacao.unidade ? "<strong>liberada</strong>" : "não liberada"}</p>
    ${d.modoDaAutoridade === "CO_LOCALIZADA" ? '<p class="estado-detalhe">Autoridade no mesmo serviço do backend (isolamento só de credencial).</p>' : ""}`;
  const sel = $('#form-prov select[name="perfilId"]');
  sel.innerHTML = `<option value="">— escolha —</option>${d.candidatos.map((c) => `<option value="${esc(c.perfilId)}" ${c.contaPessoal ? "" : "disabled"}>${esc(c.nome)}${c.contaPessoal ? "" : " (conta compartilhada — não pode)"}</option>`).join("")}`;
}

$("#form-prov").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const d = Object.fromEntries(new FormData(f));
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/administracao/provisionar", { perfilId: d.perfilId, justificativa: d.justificativa, evidencia: d.evidencia });
  saida.textContent = r.ok ? "Administração inicial registrada." : mensagem(r);
  if (r.ok) carregar();
});
$("#form-lib").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const ativa = e.submitter?.dataset.ativa === "true";
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/administracao/liberacao", { ativa, justificativa: new FormData(f).get("justificativa") });
  saida.textContent = r.ok ? (ativa ? "Unidade liberada no Financeiro v2." : "Unidade desligada: volta ao painel atual.") : mensagem(r);
  if (r.ok) carregar();
});
carregar();
