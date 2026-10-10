import { Router } from "express";
import * as controller from "./sessao.controller.js";
import { requireContexto, exigirSenhaDefinitiva } from "../../middlewares/auth.js";
import { limiteDeTaxa, combinar, ipCliente } from "../../shared/rateLimit.js";
import { RATE_LIMIT } from "../../config/limites.js";

// Limites de taxa das rotas de credencial. Chave por CONTA (req.user.id) e,
// no PIN, TAMBÉM por IP — para que um atacante com a senha da conta não ataque
// vários perfis em paralelo (contornando parte do lockout por perfil), nem
// faça spray trocando de conta a partir de uma origem só. O 429 é genérico:
// não revela se a conta/perfil existe.
const limitePin = combinar(
  limiteDeTaxa({ escopo: "sessao:pin:conta", ...RATE_LIMIT.pinPorConta }),
  limiteDeTaxa({ escopo: "sessao:pin:ip", ...RATE_LIMIT.pinPorIp, chave: ipCliente }),
);
const limiteSelecionar = limiteDeTaxa({ escopo: "sessao:selecionar", ...RATE_LIMIT.selecionarContexto });
const limiteSenha = limiteDeTaxa({ escopo: "sessao:senha", ...RATE_LIMIT.trocarSenha });
const limiteRenovar = limiteDeTaxa({ escopo: "sessao:renovar", max: Number(process.env.RATE_LIMIT_RENOVAR_MAX) || 40, janelaMs: 60 * 60_000 });

// Rotas de sessão. Todas exigem estar AUTENTICADO (requireAuth já roda em
// /api/v1), mas quase nenhuma exige CONTEXTO — é justamente aqui que o
// contexto nasce. Aplicar requireContexto ao router inteiro criaria um
// impasse: não daria para escolher a empresa sem já ter escolhido uma.
export const sessaoRouter = Router();

// Trocar a própria senha. É a ÚNICA saída do estado "senha provisória", então
// NÃO passa pelo gate `exigirSenhaDefinitiva` — se passasse, o usuário ficaria
// preso: bloqueado para tudo, inclusive para se desbloquear.
sessaoRouter.post("/senha", limiteSenha, controller.novaSenha);

// As rotas abaixo exigem senha definitiva: escolher empresa/unidade antes de
// definir a senha própria não faz sentido e é bloqueado. (O gate global de
// routes.js só cobre o que vem DEPOIS do mount de /sessao; por isso as rotas
// de sessão que devem ser bloqueadas repetem o gate aqui.)
sessaoRouter.get("/acessos", exigirSenhaDefinitiva, controller.acessos);
sessaoRouter.post("/selecionar", exigirSenhaDefinitiva, limiteSelecionar, controller.selecionar);

// Perfil operacional (Fase C do multi-perfil) — o passo "Selecione seu
// usuário", ENTRE o login e a seleção de contexto. Como `/acessos`, exigem
// autenticação + senha definitiva, mas NÃO contexto (é aqui que a identidade
// operacional é escolhida, antes de ter empresa). A conta vem sempre de
// req.user.id; nenhum handler lê conta_id do cliente.
sessaoRouter.get("/perfis", exigirSenhaDefinitiva, controller.perfis);
sessaoRouter.post("/selecionar-perfil", exigirSenhaDefinitiva, limitePin, controller.selecionarPerfil);

// MFA (P0.2) — o frontend avisa após cadastrar/remover o 2º fator (o
// enroll/verify é client-side via Supabase Auth). Só registra auditoria a
// partir do estado REAL relido do JWT; não recebe segredo nenhum.
sessaoRouter.post("/mfa/evento", exigirSenhaDefinitiva, controller.mfaEvento);

// `atual` exige contexto (é o que ele descreve).
sessaoRouter.get("/atual", exigirSenhaDefinitiva, requireContexto, controller.atual);

// `unidades` também exige contexto — alimenta o seletor global do topbar
// (item 4/10 do pedido: fonte única para trocar de unidade sem sair da
// empresa), inclusive quando já se está em "Todas as unidades".
sessaoRouter.get("/unidades", exigirSenhaDefinitiva, requireContexto, controller.unidades);

// `trocar-unidade` exige contexto: é a troca a partir do seletor do topbar,
// diferente de `/selecionar` (usado sem contexto prévio). Só ela sabe se a
// sessão atual é uma impersonação e aplica a regra certa (ver
// sessao.service.js#trocarUnidadeDoContexto).
sessaoRouter.post("/trocar-unidade", exigirSenhaDefinitiva, requireContexto, controller.trocarUnidade);

// `renovar`: renovação AUTOMÁTICA do contexto — SÓ do perfil de exibição (computador da TV, expediente de ~17 h).
// Exige autenticação (JWT do Supabase válido), senha definitiva e contexto VIVO; o serviço recusa (403, sem alterar nada)
// qualquer outro papel e qualquer impersonação. Não lê o corpo. Limite de taxa por conta: a TV renova ~3 vezes por jornada.
sessaoRouter.post("/renovar", exigirSenhaDefinitiva, requireContexto, limiteRenovar, controller.renovar);

// `encerrar` funciona com ou sem contexto: revoga o que houver. Se exigisse
// contexto, um token já expirado impediria o logout — o pior momento para
// travar o usuário.
sessaoRouter.post("/encerrar", contextoOpcional, controller.encerrar);

/** Tenta resolver o contexto; segue em frente se não houver. */
function contextoOpcional(req, res, next) {
  if (!req.header("x-context-token")) return next();
  requireContexto(req, res, (erro) => next(erro && erro.statusCode === 409 ? undefined : erro));
}
