// Detecta quando esta aba está rodando uma versão antiga da Central (já existe um deploy mais novo no ar) e
// recarrega sozinha — sem isto, uma aba aberta antes de um deploy continua rodando o JS velho indefinidamente
// (ver app.js criarApp(): `.js`/`.html` nunca ficam em cache, mas isso só ajuda em quem RECARREGA; uma aba já
// carregada mantém os módulos antigos em memória até alguém dar refresh).
//
// Versão = os 7 hex do commit publicado (RENDER_GIT_COMMIT, ver backend/src/app.js#versaoPublicada), devolvidos
// em GET /health. Fora do Render (local, PR Preview sem a env) o backend não informa versão — aqui a verificação
// fica inerte: sem um "antes" confiável do servidor, qualquer diferença seria ruído.
export const INTERVALO_MS = 5 * 60_000;  // deploy não é tão frequente a ponto de precisar verificar com mais pressa
export const ESPERA_RECARGA_MS = 5_000;

/** Decisão pura: a versão que o servidor devolveu agora mostra que esta aba ficou para trás? */
export function ehVersaoNova(versaoDestaAba, versaoRecebida) {
  return versaoDestaAba != null && typeof versaoRecebida === "string" && versaoRecebida !== "" && versaoRecebida !== versaoDestaAba;
}

let versaoDestaAba = null;  // 1ª versão vista no boot; null = ainda não soube, ou servidor não informa (local/preview)
let timer = null;
let detectada = false;      // já avisou? não verifica de novo, não duplica o aviso

async function versaoDoServidor() {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.versao === "string" && j.versao ? j.versao : null;
  } catch {
    return null; // sem rede agora não é "versão antiga" — é só sem conexão, outro problema
  }
}

function mostrarAvisoEAtualizar() {
  if (detectada) return;
  detectada = true;
  if (timer !== null) { clearInterval(timer); timer = null; }
  const aviso = document.createElement("div");
  aviso.id = "versao-antiga-aviso";
  aviso.className = "versao-antiga-aviso";
  aviso.setAttribute("role", "status");
  aviso.textContent = "Versão antiga identificada. Atualizando automaticamente…";
  document.body.prepend(aviso);
  setTimeout(() => location.reload(), ESPERA_RECARGA_MS);
}

async function verificar() {
  if (detectada) return;
  const v = await versaoDoServidor();
  if (!v) return;                                 // local/preview sem RENDER_GIT_COMMIT: nada para comparar
  if (versaoDestaAba === null) { versaoDestaAba = v; return; } // 1ª resposta desta aba: fixa a referência, não compara com ela mesma
  if (ehVersaoNova(versaoDestaAba, v)) mostrarAvisoEAtualizar();
}

/** Liga a verificação periódica de versão. Idempotente. Chamado uma vez, no boot (app.js). */
export function iniciarVerificacaoVersao() {
  if (timer !== null || detectada) return;
  verificar(); // já pega a referência desta aba sem esperar o 1º intervalo
  timer = setInterval(verificar, INTERVALO_MS);
  // Aba que estava em segundo plano (minimizada, outra aba em foco) pode ter perdido um ou mais deploys —
  // confere na hora em que o usuário volta a olhar para ela, não só no próximo intervalo.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") verificar(); });
}
