// Perfil de EXIBIÇÃO (Operador de Exibição) — só APRESENTAÇÃO no frontend.
//
// A conta do computador ligado à TV da loja tem um único papel, `display_operator`, com UMA permissão
// (`checklist.visualizar`). Quem AUTORIZA é o backend (middleware `restringirPerfilExibicao`: tudo fora do
// Checklist responde 403, mesmo se alguém abrir outra rota na mão). Isto aqui só evita oferecer o que a API vai
// recusar: sem menu administrativo, sem navegação desnecessária, e a entrada (login, reentrada depois do
// vencimento do contexto, reinício do navegador) cai direto no Checklist.
//
// Funções puras (recebem a sessão), para testar sem DOM.

export const PAPEL_EXIBICAO = "display_operator";

/** Os ÚNICOS itens do menu que o perfil de exibição enxerga/alcança. */
export const ROTAS_DO_PERFIL_EXIBICAO = Object.freeze(["checklist-operacional"]);

/** A sessão é de um Operador de Exibição? */
export const ehPerfilExibicao = (sessao) => sessao?.papel === PAPEL_EXIBICAO;

/** O item do menu pode aparecer/abrir para este perfil? Para os demais papéis, sempre sim (as regras de módulo seguem em router.js/app.js). */
export const itemPermitidoAoPerfil = (item, sessao) => !ehPerfilExibicao(sessao) || ROTAS_DO_PERFIL_EXIBICAO.includes(item?.id);

/** Rota de entrada do perfil de exibição; `null` para os demais papéis (eles seguem a regra de sempre). */
export const rotaInicialDoPerfil = (sessao) => (ehPerfilExibicao(sessao) ? ROTAS_DO_PERFIL_EXIBICAO[0] : null);
