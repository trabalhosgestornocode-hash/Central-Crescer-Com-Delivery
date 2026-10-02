// Guarda de EFEITOS EXTERNOS — quem pode, neste processo, iniciar rotinas que escrevem/apagam em produção ou falam com
// sistemas externos (envio de WhatsApp, consumo da fila de comunicação, purga, polling do iFood, worker Martin Brower).
//
// POR QUÊ (auditoria de 2026-10-02):
//   * o Web Service do backend tem PR Previews AUTOMÁTICOS no Render, e um preview COPIA todas as variáveis do serviço
//     base (doc. do Render: "This includes environment variables, such as database connection information"). Sem esta
//     guarda, abrir um PR sobe uma segunda cópia do backend, com o código NÃO revisado do PR, apontada para o Supabase de
//     produção e para o Gateway WhatsApp, com COMUNICACAO_WORKER_ENABLED=true herdado — consumindo a fila real e enviando;
//   * o `.env` local aponta para o Supabase de produção e a purga liga por padrão: `npm run dev` já apagava dados reais.
//
// REGRA — AUTORIZAÇÃO POSITIVA, FAIL CLOSED. Só há duas formas de PERMITIR; todo o resto BLOQUEIA:
//
//   Render (produção)  RENDER=true
//                      + IS_PULL_REQUEST=false            (o Render define por instância; "true" = preview)
//                      + EFEITOS_EXTERNOS_PERMITIDOS=true
//                      + RENDER_SERVICE_ID ∈ EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS (lista de ids srv-…, não vazia)
//                      Um preview, um serviço novo ou um serviço COPIADO herdam as duas últimas variáveis, mas têm OUTRO
//                      RENDER_SERVICE_ID (que o Render injeta e não é herdável) ⇒ bloqueados.
//
//   Fora do Render     EFEITOS_EXTERNOS_LOCAL_PERMITIDOS=true  (nome DIFERENTE de propósito: nunca existe no Render,
//   (local / teste)    então copiar as variáveis de produção para o `.env` NÃO concede permissão)
//
// Qualquer valor ausente, inválido ou contraditório bloqueia: IS_PULL_REQUEST fora de "true"/"false" (ou ausente no
// Render), RENDER fora de "true"/vazio, RENDER_SERVICE_ID ou IS_PULL_REQUEST sem RENDER=true, lista com item que não é id
// do Render, flag com valor diferente de "true".
//
// Esta guarda PERMITE; a flag de cada rotina ATIVA (COMUNICACAO_WORKER_ENABLED, IFOOD_EVENTS_EMBEDDED_ENABLED,
// MB_PLAYWRIGHT_ENABLED, COMUNICACAO_INBOX_PURGA_INTERVALO_MIN). Rotina nova com efeito externo: chamar esta guarda ANTES
// da própria flag. Nada aqui lê ou loga segredo; o resultado só carrega vocabulário fechado (nunca ids, URLs ou valores).

const ID_SERVICO_RENDER = /^srv-[a-z0-9]{10,40}$/;

const texto = (v) => String(v ?? "").trim();
/** Só a string exata "true" (sem diferenciar maiúsculas) liga; "1", "yes", "on" NÃO — fail closed. */
const exatamenteTrue = (v) => texto(v).toLowerCase() === "true";

function bloqueado(ambiente, motivo) { return { permitido: false, ambiente, motivo }; }

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{permitido: boolean, ambiente: 'preview'|'render'|'teste'|'local'|'desconhecido', motivo: string}}
 */
export function avaliarEfeitosExternos(env = process.env) {
  const pr = texto(env.IS_PULL_REQUEST).toLowerCase();
  if (pr === "true") return bloqueado("preview", "render_pull_request_preview");
  if (pr !== "" && pr !== "false") return bloqueado("desconhecido", "is_pull_request_invalido");

  const render = texto(env.RENDER).toLowerCase();
  if (render !== "" && render !== "true") return bloqueado("desconhecido", "render_invalido");

  if (render === "true") {
    if (pr !== "false") return bloqueado("desconhecido", "is_pull_request_ausente");
    if (!exatamenteTrue(env.EFEITOS_EXTERNOS_PERMITIDOS)) return bloqueado("render", "render_sem_autorizacao");
    const bruto = texto(env.EFEITOS_EXTERNOS_SERVICOS_AUTORIZADOS);
    if (bruto === "") return bloqueado("render", "lista_de_servicos_ausente");
    const ids = bruto.split(",").map((s) => s.trim());
    if (ids.some((id) => !ID_SERVICO_RENDER.test(id))) return bloqueado("render", "lista_de_servicos_invalida");
    const servico = texto(env.RENDER_SERVICE_ID);
    if (!ID_SERVICO_RENDER.test(servico)) return bloqueado("render", "render_service_id_invalido");
    return ids.includes(servico)
      ? { permitido: true, ambiente: "render", motivo: "servico_autorizado" }
      : bloqueado("render", "servico_nao_autorizado");
  }

  // Fora do Render. Variável típica do Render sem RENDER=true é contraditória (ambiente desconhecido) ⇒ bloqueia.
  if (texto(env.RENDER_SERVICE_ID) !== "" || pr !== "") return bloqueado("desconhecido", "ambiente_contraditorio");
  const teste = texto(env.NODE_ENV).toLowerCase() === "test" || Boolean(env.NODE_TEST_CONTEXT);
  const ambiente = teste ? "teste" : "local";
  return exatamenteTrue(env.EFEITOS_EXTERNOS_LOCAL_PERMITIDOS)
    ? { permitido: true, ambiente, motivo: "autorizacao_local_explicita" }
    : bloqueado(ambiente, "fora_do_render_sem_autorizacao");
}

/** Atalho booleano. */
export function efeitosExternosPermitidos(env = process.env) {
  return avaliarEfeitosExternos(env).permitido;
}
