// PAINEL DE ATIVAÇÃO POR UNIDADE (migração 0022). O administrador financeiro da empresa ativa unidades em lote, define
// quem opera e quem administra. Mesmo login da Crescer (plataforma.js): a decisão é sempre do servidor (administrador da
// empresa na plataforma + administrador financeiro corporativo, empresa = a da sessão). Sem TOTP a cada ato, sem
// atestante, sem SQL. Nada é escolhido automaticamente.
import { criarConsultor, definirTransporte, enviar } from "./consulta.js";
import { credenciaisDaPlataforma, criarTransportePlataforma, estadoDoErro } from "./plataforma.js";
import { esc } from "./formatar.js";

definirTransporte(criarTransportePlataforma({ credenciais: credenciaisDaPlataforma }));
const $ = (s) => document.querySelector(s);
const MOTIVOS = {
  SEM_AUTORIDADE_ADMINISTRATIVA: "Só o administrador da empresa acessa a ativação do Financeiro v2.",
  NAO_E_ADMINISTRADOR_CORPORATIVO: "Você ainda não é administrador financeiro desta empresa. Peça a um administrador financeiro para incluir você.",
  UNIDADE_FORA_DA_EMPRESA: "Alguma unidade não pertence a esta empresa.",
  PESSOA_SEM_VINCULO: "A pessoa não tem vínculo ativo com a unidade.",
  CONTA_COMPARTILHADA: "Conta compartilhada não opera o financeiro: use uma conta pessoal.",
  NAO_E_ADMIN_DA_EMPRESA: "Só administradores da empresa na plataforma podem ser administradores financeiros.",
  JUSTIFICATIVA_INSUFICIENTE: "Escreva a justificativa (mínimo 20 caracteres).",
  IDENTIDADE_OPERACIONAL_NAO_CONFIGURADA: "A identidade operacional do MOVA ainda não foi configurada no servidor.",
};
const mensagem = (r) => MOTIVOS[r.motivo] ?? MOTIVOS[r.erro] ?? estadoDoErro(r).mensagem ?? r.mensagem;
let contexto = null;
const nomeNivel = { CONSULTA: "Consulta", OPERADOR: "Operador", FINANCEIRO: "Financeiro", COMPLETO: "Completo", NENHUM: "Sem acesso", PERSONALIZADO: "Personalizado" };

async function carregar() {
  const r = await criarConsultor().consultar("/api/fv2/corporativo/contexto");
  $("#conteudo").removeAttribute("aria-busy");
  if (!r) return;
  if (!r.ok) {
    $("#estado").textContent = mensagem(r);
    if (r.motivo === "NAO_E_ADMINISTRADOR_CORPORATIVO") $("#sec-inicial").hidden = false;
    return;
  }
  $("#sec-inicial").hidden = true;
  contexto = r.dados;
  $("#estado").textContent = `${contexto.organizacao.nome ?? "Empresa"} — ${contexto.unidades.length} unidade(s) com banco financeiro preparado.`;
  for (const s of ["#sec-unidades", "#sec-acessos", "#sec-adm", "#sec-mova"]) $(s).hidden = false;
  $("#lista-unidades").innerHTML = contexto.unidades.map((u) => `<li><label><input type="checkbox" name="unidade" value="${esc(u.id)}"> <strong>${esc(u.nome)}</strong>
    — ${u.liberada ? (u.escrita ? "ativa (consulta e lançamentos)" : "ativa só para consulta") : "desligada"}</label></li>`).join("");
  $("#un-mova").innerHTML = contexto.unidades.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}</option>`).join("");
  $("#un-acessos").innerHTML = contexto.unidades.map((u) => `<option value="${esc(u.id)}">${esc(u.nome)}</option>`).join("");
  $("#lista-adm").innerHTML = contexto.administradores.map((a) => `<li>${a.eu ? "Você" : esc(a.contaId.slice(0, 8) + "…")}</li>`).join("");
  $('#form-adm select[name="conta"]').innerHTML = contexto.candidatosAAdministrador.length
    ? contexto.candidatosAAdministrador.filter((c) => !contexto.administradores.some((a) => a.contaId === c)).map((c) => `<option value="${esc(c)}">${esc(c.slice(0, 8))}…</option>`).join("") : "<option value=''>Nenhum candidato</option>";
  await carregarPessoas();
}

async function carregarPessoas() {
  const unidade = $("#un-acessos").value;
  if (!unidade) return;
  const r = await criarConsultor().consultar(`/api/fv2/corporativo/pessoas?unidade=${encodeURIComponent(unidade)}`);
  if (!r) return;
  if (!r.ok) { $("#pessoas").textContent = mensagem(r); return; }
  const pessoas = r.dados.pessoas;
  $("#pessoas").innerHTML = pessoas.length ? `<ul class="mini">${pessoas.map((p) => `<li>${esc(p.nome)} — <strong>${esc(nomeNivel[p.nivel] ?? p.nivel)}</strong>${p.contaPessoal ? "" : " (conta compartilhada: não pode operar)"}${p.euMesmo ? " (você)" : ""}</li>`).join("")}</ul>` : "<p>Nenhuma pessoa com vínculo nesta unidade.</p>";
  const f = $("#form-acesso");
  f.hidden = !pessoas.length;
  f.querySelector('select[name="perfil"]').innerHTML = pessoas.filter((p) => p.contaPessoal && !p.euMesmo).map((p) => `<option value="${esc(p.perfilId)}">${esc(p.nome)}</option>`).join("");
}

$("#un-acessos").addEventListener("change", carregarPessoas);
$("#form-inicial").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/administracao/administrador-corporativo-inicial", { justificativa: new FormData(f).get("justificativa") });
  saida.textContent = r.ok ? "Você agora é administrador financeiro desta empresa." : (r.motivo === "SEM_PROVA_DE_SEGUNDO_FATOR" || /segundo fator|autenticador/i.test(r.mensagem ?? "") ? "Entre de novo com o código do autenticador (TOTP) e repita." : mensagem(r));
  if (r.ok) carregar();
});
$("#form-lib").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const unidades = [...f.querySelectorAll('input[name="unidade"]:checked')].map((x) => x.value);
  if (!unidades.length) { saida.textContent = "Marque ao menos uma unidade."; return; }
  const ativa = e.submitter?.dataset.ativa === "true";
  const corpo = { unidades, ativa, justificativa: new FormData(f).get("justificativa") };
  if (e.submitter?.dataset.escrita === "false") corpo.escrita = false;
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/corporativo/liberacao", corpo);
  saida.textContent = r.ok ? `${r.dados.unidadesAlteradas} unidade(s) atualizada(s).` : mensagem(r);
  if (r.ok) carregar();
});
$("#form-acesso").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const d = Object.fromEntries(new FormData(f));
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/corporativo/acessos", { unidade: $("#un-acessos").value, perfil: d.perfil, nivel: d.nivel, justificativa: d.justificativa });
  saida.textContent = r.ok ? "Acesso salvo. Vale na próxima operação da pessoa." : mensagem(r);
  if (r.ok) carregarPessoas();
});
$("#form-adm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const d = Object.fromEntries(new FormData(f));
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/corporativo/administradores", { conta: d.conta, ativo: true, justificativa: d.justificativa });
  saida.textContent = r.ok ? "Administrador financeiro adicionado." : mensagem(r);
  if (r.ok) carregar();
});
$("#form-mova").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const saida = f.querySelector(".resultado-acao");
  const d = new FormData(f);
  const acao = e.submitter?.dataset.acao === "REVOGAR" ? "REVOGAR" : "CONCEDER";
  saida.textContent = "Enviando…";
  const r = await enviar("/api/fv2/corporativo/mova-operacional", { unidade: d.get("unidade"), acao, juros: d.get("juros") === "on", justificativa: d.get("justificativa") });
  saida.textContent = r.ok ? (acao === "REVOGAR" ? "MOVA revogado nesta unidade." : "MOVA autorizado nesta unidade.") : mensagem(r);
});
carregar();
