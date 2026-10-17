// Importação do livro-caixa: upload → prévia → decisões (pares, alterações) → confirmação explícita → relatório de reconciliação.
// Nada é gravado nos lançamentos antes da confirmação. Pendências históricas são preservadas, nunca reclassificadas sozinhas.
import { fin } from "./api.js";
import { moeda, dataBr, arquivoParaBase64, ROTULO_MOTIVO, podeAcao, ACAO } from "./modelo.js";
import { garantirCss, cabecalho, tabela, badge, carregarEm, aviso, esc, estado } from "./ui.js";

const PASSOS = ["Arquivo", "Prévia", "Pares e alterações", "Confirmação"];

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const pLancar = podeAcao(ctx, ACAO.LANCAR), pConciliar = podeAcao(ctx, ACAO.CONCILIAR), pConfirmar = podeAcao(ctx, ACAO.CONFIGURAR);
  let atual = null; // prévia aberta
  let filtro = "pendentes";

  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({ titulo: "Importação do livro-caixa", sub: "Só a aba do fluxo é importada (as abas por conta são visões do mesmo livro). Reimportar não duplica; nada é excluído." });

  const passos = (n) => `<ol class="fin-passos" aria-label="Etapas">${PASSOS.map((p, i) => `<li${i === n ? ' aria-current="step"' : ""}>${esc(p)}</li>`).join("")}</ol>`;

  async function inicio() {
    carregarEm(corpo, () => fin.get("/importacoes"), (hist) => {
      corpo.innerHTML = `${passos(0)}
        <div class="fin-card"><h3>Enviar planilha (.xlsx)</h3>
          ${pLancar ? `<form data-upload class="fin-filtros"><label class="fin-campo"><span>Arquivo do livro-caixa</span><input type="file" name="arquivo" accept=".xlsx" required></label><button class="btn btn-primary btn-sm" type="submit">Gerar prévia</button></form>
          <p class="fin-sub">Limite 5 MB. A prévia não grava nada: você revisa, decide pares e só então confirma.</p>` : estado.vazio("Sem permissão para importar", "Peça a um gestor.")}
        </div>
        <div class="fin-card"><h3>Importações anteriores</h3>${tabela({
          colunas: [
            { rotulo: "Arquivo", render: (i) => esc(i.arquivoNome ?? "—") }, { rotulo: "Quando", render: (i) => esc(new Date(i.criadoEm).toLocaleString("pt-BR")) },
            { rotulo: "Situação", render: (i) => badge({ previa: "Prévia", confirmada: "Confirmada", cancelada: "Cancelada", falhou: "Falhou" }[i.status] ?? i.status, i.status === "confirmada" ? "ok" : i.status === "previa" ? "info" : "muted") },
            { rotulo: "Gravados", num: true, render: (i) => (i.resumo?.lancamentosGravados ?? "—") },
            { rotulo: "", render: (i) => (i.status === "previa" ? `<button class="btn btn-ghost btn-sm" data-abrir="${i.id}">Retomar</button>` : "") },
          ], linhas: hist, vazio: "Nenhuma importação ainda.",
        })}</div>`;
      corpo.querySelector("[data-upload]")?.addEventListener("submit", enviar);
      corpo.querySelectorAll("[data-abrir]").forEach((b) => b.addEventListener("click", async () => { try { atual = await fin.get(`/importacoes/${b.dataset.abrir}`); pintarPrevia(); } catch (e) { aviso(e.message, "bad"); } }));
    });
  }

  async function enviar(e) {
    e.preventDefault();
    const arq = e.target.arquivo.files[0];
    if (!arq) return;
    const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Lendo…";
    try {
      atual = await fin.post("/importacoes/previa", { nomeArquivo: arq.name, conteudoBase64: await arquivoParaBase64(arq) });
      aviso("Prévia gerada. Nada foi gravado ainda."); pintarPrevia();
    } catch (err) { aviso(err.message, "bad"); btn.disabled = false; btn.textContent = "Gerar prévia"; }
  }

  function pintarPrevia() {
    const r = atual.resumo, c = r.conferencia ?? {};
    const conf = c.confere === true ? badge("Totais conferem ao centavo", "ok") : c.confere === false ? badge("Totais NÃO conferem", "bad") : badge("Arquivo sem total declarado", "muted");
    const cartao = (rot, val, tipo) => `<article class="fin-kpi"><span class="fin-kpi-rot">${esc(rot)}</span><strong class="fin-kpi-val">${val}</strong>${tipo ? badge(tipo.t, tipo.k) : ""}</article>`;
    const alta = atual.pares.filter((p) => p.confianca === "alta" && !p.confirmado && !p.rejeitado);
    const outros = atual.pares.filter((p) => p.confianca !== "alta" && !p.confirmado && !p.rejeitado);
    const alteracoes = atual.lancamentos.filter((l) => l.status === "possivel_alteracao");
    const lanc = atual.lancamentos.filter((l) => (filtro === "pendentes" ? l.pendente || l.motivos?.some((m) => m !== "transferencia_sem_contraparte") : filtro === "novos" ? l.status === "novo" : true));
    const chave = new Map(atual.lancamentos.map((l) => [l.chave, l]));
    const descPar = (p) => { const s = chave.get(p.saida), en = chave.get(p.entrada); return `${esc(s?.conta ?? "?")} → ${esc(en?.conta ?? "?")} · ${moeda(s?.valor_centavos)} · ${dataBr(s?.data)}`; };

    corpo.innerHTML = `${passos(r.paresConfirmados !== undefined || alteracoes.length ? 2 : 1)}
      <div class="fin-kpis">
        ${cartao("Linhas lidas", r.linhasLidas)}${cartao("Lançamentos novos", r.novos)}${cartao("Já existentes (ignorados)", r.existentes)}
        ${cartao("Possíveis alterações", r.possiveisAlteracoes, r.possiveisAlteracoes ? { t: "Exigem decisão", k: "warn" } : null)}
        ${cartao("Pendências", r.pendentes, r.pendentes ? { t: "Serão preservadas", k: "warn" } : null)}${cartao("Erros de leitura", r.erros, r.erros ? { t: "Bloqueiam a confirmação", k: "bad" } : null)}
        ${cartao("Saldos de abertura", r.saldos)}${cartao("Pares sugeridos", r.paresSugeridos)}
      </div>
      <div class="fin-card"><h3>Conferência</h3><p>${conf} Entradas ${moeda(c.calculado?.entradaCentavos)} · Saídas ${moeda(c.calculado?.saidaCentavos)}${c.declarado ? ` (declarado: ${moeda(c.declarado.entradaCentavos)} / ${moeda(c.declarado.saidaCentavos)})` : ""}</p>
        ${r.contasSemAbertura?.length ? `<div class="fin-alerta fin-alerta--warn">Sem saldo de abertura informado: <strong>${r.contasSemAbertura.map(esc).join(", ")}</strong>. Os saldos dessas contas ficarão <em>parciais</em> (nunca assumimos zero).</div>` : ""}
        ${r.aIdentificar || r.comFormula || r.comComentario || r.identicas ? `<p class="fin-sub">Preservados para revisão: ${r.aIdentificar} “a identificar” · ${r.comFormula} valor(es) por fórmula · ${r.comComentario} comentário(s) · ${r.identicas} linha(s) idêntica(s).</p>` : ""}</div>
      ${atual.erros?.length ? `<div class="fin-card"><h3>Erros de leitura</h3>${tabela({ colunas: [{ rotulo: "Linha", render: (x) => x.linha }, { rotulo: "Problema", render: (x) => esc(x.motivo) }], linhas: atual.erros })}<p class="fin-sub">Corrija o arquivo e gere uma nova prévia.</p></div>` : ""}
      <div class="fin-card"><h3>Pares de transferência</h3>
        <p class="fin-sub">Cada perna aparece em uma linha. Sugerimos pares por valor, data e contas; <strong>nada é vinculado sem sua confirmação</strong>. Pares ambíguos nunca entram em lote. Sem contraparte, o movimento permanece pendente.</p>
        ${pConciliar && alta.length ? `<button class="btn btn-primary btn-sm" data-lote>Confirmar ${alta.length} par(es) de alta confiança</button>` : ""}
        ${outros.length ? `<h4>Ambíguos (${outros.length}) — decida um a um</h4>${tabela({ colunas: [{ rotulo: "Par sugerido", render: (p) => `${descPar(p)}<br><small>${esc(p.motivos.join("; "))}</small>` }, { rotulo: "", render: (p) => (pConciliar ? `<div class="fin-linha-acoes"><button class="btn btn-ghost btn-sm" data-par="${esc(p.id)}">Confirmar</button><button class="btn btn-ghost btn-sm" data-rejeitar="${esc(p.id)}">Rejeitar</button></div>` : "") }], linhas: outros })}` : ""}
        <p>${badge(`${r.paresConfirmados ?? 0} confirmado(s)`, "ok")}</p></div>
      ${alteracoes.length ? `<div class="fin-card"><h3>Possíveis alterações (${alteracoes.length})</h3><p class="fin-sub">Parecem edições de lançamentos já importados. Por padrão NÃO entram e o original não é alterado ou excluído.</p>${tabela({ colunas: [{ rotulo: "Linha", render: (l) => l.linha }, { rotulo: "Descrição", render: (l) => esc(l.descricao) }, { rotulo: "Valor", num: true, render: (l) => moeda(l.valor_centavos) }, { rotulo: "", render: (l) => (pConciliar ? `<button class="btn btn-ghost btn-sm" data-aceitar="${esc(l.chave)}">Importar como novo</button>` : "") }], linhas: alteracoes })}</div>` : ""}
      <div class="fin-card"><h3>Lançamentos da prévia</h3>
        <div class="fin-filtros"><label class="fin-campo"><span>Mostrar</span><select data-filtro><option value="pendentes"${filtro === "pendentes" ? " selected" : ""}>Com pendência ou nota</option><option value="novos"${filtro === "novos" ? " selected" : ""}>Novos</option><option value="todos"${filtro === "todos" ? " selected" : ""}>Todos</option></select></label></div>
        ${tabela({ colunas: [
          { rotulo: "Linha", render: (l) => l.linha }, { rotulo: "Data", render: (l) => dataBr(l.data) }, { rotulo: "Descrição", render: (l) => esc(l.descricao) }, { rotulo: "Conta", render: (l) => esc(l.conta) },
          { rotulo: "Valor", num: true, render: (l) => moeda(l.sentido === "entrada" ? l.valor_centavos : -l.valor_centavos, { sinal: true }) },
          { rotulo: "Observações", render: (l) => (l.motivos ?? []).map((m) => badge(ROTULO_MOTIVO[m] ?? m, ["sem_papel", "a_identificar", "possivel_alteracao"].includes(m) ? "warn" : "muted")).join(" ") + (l.nota ? `<br><small>${esc(l.nota.slice(0, 140))}</small>` : "") },
        ], linhas: lanc.slice(0, 200), vazio: "Nada nesta visão." }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"')}
        ${lanc.length > 200 ? `<p class="fin-sub">Mostrando 200 de ${lanc.length}. Use o filtro para refinar.</p>` : ""}</div>
      ${pConfirmar ? `<div class="fin-card"><h3>Confirmação</h3>
        <form data-confirmar><label><input type="checkbox" name="confirmo" required> Revisei a prévia: gravar ${r.novos - (r.possiveisAlteracoes ?? 0)} lançamento(s) novo(s), ${r.saldos} saldo(s) de abertura e vincular ${r.paresConfirmados ?? 0} par(es) confirmado(s). Pendências serão preservadas como pendentes.</label>
        <div class="fin-form-acoes"><button class="btn btn-ghost btn-sm" type="button" data-cancelar-previa>Cancelar prévia</button><button class="btn btn-primary btn-sm" type="submit" ${r.erros || c.confere === false ? "disabled" : ""}>Confirmar importação</button></div></form></div>` : `<p class="fin-sub">A confirmação exige permissão de configuração financeira.</p>`}`;

    corpo.querySelector("[data-filtro]")?.addEventListener("change", (e) => { filtro = e.target.value; pintarPrevia(); });
    corpo.querySelector("[data-lote]")?.addEventListener("click", () => decidir({ confirmarAltaConfianca: true }));
    corpo.querySelectorAll("[data-par]").forEach((b) => b.addEventListener("click", () => decidir({ confirmar: [b.dataset.par] })));
    corpo.querySelectorAll("[data-rejeitar]").forEach((b) => b.addEventListener("click", () => decidir({ rejeitar: [b.dataset.rejeitar] })));
    corpo.querySelectorAll("[data-aceitar]").forEach((b) => b.addEventListener("click", async () => {
      try { await fin.post(`/importacoes/${atual.id}/alteracoes`, { chaves: [b.dataset.aceitar] }); atual = await fin.get(`/importacoes/${atual.id}`); pintarPrevia(); } catch (e) { aviso(e.message, "bad"); }
    }));
    corpo.querySelector("[data-cancelar-previa]")?.addEventListener("click", async () => { try { await fin.post(`/importacoes/${atual.id}/cancelar`, {}); atual = null; aviso("Prévia cancelada."); inicio(); } catch (e) { aviso(e.message, "bad"); } });
    corpo.querySelector("[data-confirmar]")?.addEventListener("submit", confirmar);
  }

  async function decidir(corpoReq) {
    try { const n = await fin.post(`/importacoes/${atual.id}/pares`, corpoReq); atual = { ...atual, ...n, resumo: n.resumo }; pintarPrevia(); } catch (e) { aviso(e.message, "bad"); }
  }

  async function confirmar(e) {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]'); btn.disabled = true; btn.textContent = "Gravando…";
    try {
      const r = await fin.post(`/importacoes/${atual.id}/confirmar`, { confirmo: true });
      const rc = r.reconciliacao ?? {};
      corpo.innerHTML = `${passos(3)}<div class="fin-card"><h3>Importação concluída ${rc.confere ? badge("Reconciliada", "ok") : badge("Divergência — revisar", "bad")}</h3>
        <div class="fin-kpis">${[["Previstos", rc.previstos], ["Gravados", rc.gravados], ["Já existentes", rc.jaExistentes], ["Pares vinculados", rc.paresVinculados], ["Saldos gravados", rc.saldosGravados], ["Pendências preservadas", rc.pendentesPreservados], ["Não importados (alteração)", rc.naoImportadasPorAlteracao]]
          .map(([a, b]) => `<article class="fin-kpi"><span class="fin-kpi-rot">${esc(a)}</span><strong class="fin-kpi-val">${esc(String(b ?? "—"))}</strong></article>`).join("")}</div>
        ${rc.contasSemAbertura?.length ? `<p class="fin-sub">Contas sem abertura conhecida: ${rc.contasSemAbertura.map(esc).join(", ")}. Cadastre em Contas Financeiras quando houver extrato.</p>` : ""}
        <button class="btn btn-primary btn-sm" data-voltar>Voltar</button></div>`;
      corpo.querySelector("[data-voltar]").addEventListener("click", () => { atual = null; inicio(); });
      aviso("Importação confirmada.");
    } catch (err) { aviso(err.message, "bad"); btn.disabled = false; btn.textContent = "Confirmar importação"; }
  }

  inicio();
}
