// Importar contas a pagar de uma planilha: 1) escolhe o arquivo, 2) vê a PRÉVIA (nada é gravado) com o que será criado, 3) confirma as escolhas
// de categoria e de conta e importa. Reenviar o mesmo arquivo não duplica. Os pagamentos ficam para conciliar com o extrato (não cria saída bancária).
import { fin } from "./api.js";
import { moeda, arquivoParaBase64 } from "./modelo.js";
import { esc, aviso } from "./ui.js";

const IGNORAR = "ignorar";
const R = (c) => moeda(c);

/** Opções de um <select> de mapeamento; `sugestaoId` vem pré-selecionada. */
const opcoes = (lista, sugestaoId, { ignorar = false } = {}) =>
  `<option value=""${sugestaoId ? "" : " selected"}>Escolha…</option>${lista.map((o) => `<option value="${esc(o.id)}"${o.id === sugestaoId ? " selected" : ""}>${esc(o.nome)}</option>`).join("")}${ignorar ? `<option value="${IGNORAR}">Não importar este grupo</option>` : ""}`;

export function abrirImportarContasPagar({ aoSalvar } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = "fin-dialogo fin-icp";
  dlg.innerHTML = `<div class="fin-form"><h3>Importar contas a pagar de uma planilha</h3>
    <p class="fin-sub">Planilha do mês (.xlsx) com as colunas <strong>Vencimento</strong>, <strong>Valor previsto</strong>, <strong>Valor realizado</strong>, <strong>Descrição</strong>, <strong>Categoria</strong>, <strong>Banco / forma</strong>, <strong>Data pagamento</strong> e <strong>Origem</strong>.
      Entram só os títulos do sistema da loja. Você vê a prévia antes de gravar; reenviar o arquivo não duplica.</p>
    <label class="fin-campo"><span>Arquivo</span><input type="file" accept=".xlsx" data-arq></label>
    <p><button type="button" class="btn btn-ghost btn-sm" data-previa disabled>Pré-visualizar</button></p>
    <div data-resultado role="status" aria-live="polite"></div>
    <div class="fin-form-acoes"><button type="button" class="btn btn-ghost btn-sm" data-fechar>Fechar</button><button type="button" class="btn btn-primary btn-sm" data-confirmar hidden>Importar</button></div></div>`;
  document.body.appendChild(dlg);
  const fechar = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(); });
  dlg.querySelector("[data-fechar]").addEventListener("click", fechar);
  const arq = dlg.querySelector("[data-arq]"), bPrevia = dlg.querySelector("[data-previa]"), bOk = dlg.querySelector("[data-confirmar]"), saida = dlg.querySelector("[data-resultado]");
  let corpo = null, previa = null;
  arq.addEventListener("change", () => { bPrevia.disabled = !arq.files?.length; bOk.hidden = true; saida.innerHTML = ""; });

  const escolhas = () => {
    const mc = {}, mt = {};
    saida.querySelectorAll("[data-mc]").forEach((s) => { mc[s.dataset.mc] = s.value; });
    saida.querySelectorAll("[data-mt]").forEach((s) => { mt[s.dataset.mt] = s.value; });
    return { mc, mt };
  };
  const completo = () => { const { mc, mt } = escolhas(); return Object.values(mc).every(Boolean) && Object.values(mt).every(Boolean); };
  const atualizarBotao = () => {
    const faltam = !completo(), { mc } = escolhas();
    const n = previa.mapeamento.categorias.reduce((a, g) => a + (mc[g.chave] === IGNORAR ? 0 : g.quantidade), 0);
    bOk.hidden = previa.erros.length > 0 || previa.resumo.novos === 0; bOk.disabled = faltam || n === 0;
    bOk.textContent = n === 0 ? "Nada a importar" : `Importar ${n} conta(s)`;
    saida.querySelector("[data-falta]").hidden = !faltam;
  };

  bPrevia.addEventListener("click", async () => {
    bPrevia.disabled = true; saida.textContent = "Lendo o arquivo…";
    try {
      corpo = { conteudoBase64: await arquivoParaBase64(arq.files[0]), arquivoNome: arq.files[0].name };
      previa = await fin.post("/contas-pagar/importar/previa", corpo);
      const r = previa.resumo, erros = previa.erros.length, m = previa.mapeamento, o = previa.opcoes;
      saida.innerHTML = `<p><strong>${r.titulosNoArquivo} título(s) do sistema no arquivo:</strong> ${r.novos} novo(s) · ${r.jaImportados} já importado(s) (não duplicam) · ${r.pagos} já pago(s) · ${r.abertos} em aberto.</p>
        <p class="fin-sub">Valor previsto das novas: <strong>${R(r.valorPrevistoCentavos)}</strong> · já pago: <strong>${R(r.valorPagoCentavos)}</strong>. ${r.foraDoEscopo.quantidade ? `${r.foraDoEscopo.quantidade} linha(s) de “só extrato” (${R(r.foraDoEscopo.valorCentavos)}) ficam de fora: já estão no Fluxo de Caixa.` : ""}</p>
        ${erros ? `<div class="fin-alerta fin-alerta--bad" role="alert"><strong>Corrija o arquivo: nada será importado.</strong><ul>${previa.erros.slice(0, 8).map((e) => `<li>linha ${e.linha}: ${esc(e.motivo)}</li>`).join("")}</ul></div>` : ""}
        ${r.novos && !erros ? `<h4>Categoria de cada grupo</h4><p class="fin-sub">Confira a sugestão ou troque. A categoria define onde a conta entra nos resultados.</p>
          <table class="fin-tabela fin-icp-map"><thead><tr><th scope="col">Na planilha</th><th scope="col" class="fin-num">Contas</th><th scope="col" class="fin-num">Valor</th><th scope="col">No sistema</th></tr></thead><tbody>${m.categorias.map((g) =>
            `<tr><td>${esc(g.rotulo)}</td><td class="fin-num">${g.quantidade}</td><td class="fin-num">${R(g.valorCentavos)}</td><td><select data-mc="${esc(g.chave)}" aria-label="Categoria para ${esc(g.rotulo)}">${opcoes(o.categorias, g.sugestaoId, { ignorar: true })}</select></td></tr>`).join("")}</tbody></table>
          ${m.contas.length ? `<h4>Conta de pagamento</h4><table class="fin-tabela fin-icp-map"><thead><tr><th scope="col">Na planilha</th><th scope="col" class="fin-num">Pagamentos</th><th scope="col" class="fin-num">Valor</th><th scope="col">Conta no sistema</th></tr></thead><tbody>${m.contas.map((g) =>
            `<tr><td>${esc(g.rotulo)}</td><td class="fin-num">${g.quantidade}</td><td class="fin-num">${R(g.valorCentavos)}</td><td><select data-mt="${esc(g.chave)}" aria-label="Conta para ${esc(g.rotulo)}">${opcoes(o.contas, g.sugestaoId)}</select></td></tr>`).join("")}</tbody></table>` : ""}
          <p class="fin-sub" data-falta hidden>Escolha uma opção em cada linha para poder importar.</p>
          <p class="fin-sub">Cada pagamento já feito é registrado na conta escolhida e a conta é quitada quando foi paga por inteiro. Não é criada nenhuma saída bancária: o pagamento é conciliado depois com o extrato, na Conciliação de Saídas.</p>` : ""}
        ${r.novos === 0 && !erros ? '<div class="fin-alerta" role="status"><strong>Nada a importar:</strong> todos os títulos do arquivo já foram importados.</div>' : ""}`;
      if (!erros && r.novos) { saida.querySelectorAll("select").forEach((s) => s.addEventListener("change", atualizarBotao)); atualizarBotao(); } else bOk.hidden = true;
    } catch (e) { saida.innerHTML = `<div class="fin-alerta fin-alerta--bad" role="alert">${esc(e.message ?? "Não foi possível ler o arquivo.")}</div>`; }
    finally { bPrevia.disabled = false; }
  });

  bOk.addEventListener("click", async () => {
    const { mc, mt } = escolhas();
    bOk.disabled = true; bPrevia.disabled = true; bOk.textContent = "Importando…";
    try {
      const r = await fin.post("/contas-pagar/importar", { ...corpo, mapeamentoCategorias: mc, mapeamentoContas: mt });
      saida.innerHTML = `<div class="fin-alerta" role="status"><strong>Importação concluída.</strong> ${r.contasCriadas} conta(s) criada(s), ${r.pagamentosRegistrados} pagamento(s) registrado(s), ${r.quitadas} quitada(s)${r.ignoradasPorEscolha ? `, ${r.ignoradasPorEscolha} deixada(s) de fora por escolha` : ""}.
        ${r.falhas.length ? `<br><strong>${r.falhas.length} não puderam ser criadas:</strong> ${esc(r.falhas.slice(0, 3).map((f) => `linha ${f.linha}: ${f.motivo}`).join("; "))}. Reenvie o arquivo para tentar só essas.` : ""}<br><small>${esc(r.observacao)}</small></div>`;
      bOk.hidden = true; aviso("Importação concluída."); aoSalvar?.();
    } catch (e) { bOk.disabled = false; bPrevia.disabled = false; atualizarBotao(); saida.insertAdjacentHTML("afterbegin", `<div class="fin-alerta fin-alerta--bad" role="alert">${esc(e.message ?? "Não foi possível importar.")}</div>`); }
  });
  dlg.showModal();
  return dlg;
}
