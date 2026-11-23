// MONTAGEM do MOVA na integração do Financeiro v2. É AQUI — a única camada autorizada a importar o núcleo — que o MOVA recebe
// o contrato do Financeiro e um núcleo de leitura com a identidade de serviço.
//
// Execução 05 — o MOVA roda num BACKEND DE HOMOLOGAÇÃO SEPARADO (outro serviço, outro banco). O backend de produção não liga MOVA.
// TUDO DESLIGADO POR PADRÃO. Variáveis (o ambiente chega SEMPRE por parâmetro; só o index lê o ambiente do processo):
//   MOVA_HABILITADO=1                 base (rotas do Centro Financeiro)
//   MOVA_DATABASE_URL                 banco MOVA (papel de login membro de mova_app)
//   MOVA_SERVICO_USUARIO_ID           identidade de serviço das leituras (concessão financeiro_v2.ver nas unidades de TESTE)
//   MOVA_MODO=HOMOLOGACAO + MOVA_AMBIENTE=homologacao + MOVA_HOMOLOGACAO_MARCADOR=<segredo curto>
//                                     homologação: o banco MOVA E o banco do Financeiro precisam ter o comentário
//                                     `MOVA_HOMOLOGACAO:<marcador>` (o de produção não tem ⇒ recusa)
//   MOVA_GATEWAY_SECRET               segredo HMAC do canal isolado Gateway ⇄ MOVA (≠ WHATSAPP_GATEWAY_SECRET)
//   MOVA_GATEWAY_URL                  endereço do Gateway para o envio das respostas (rota /internal/mova/messages)
//   MOVA_RECEBIMENTO_HABILITADO=1     rota /internal/mova/eventos/mova-grupo
//   MOVA_PROCESSAMENTO_HABILITADO=1   worker da fila (exige recebimento)
//   MOVA_IA_HABILITADA=1              Claude (ANTHROPIC_API_KEY) — exige processamento; orçamento persistente obrigatório
//   MOVA_ENVIO_HABILITADO=1           respostas (exige processamento e MOVA_GATEWAY_URL)
//   MOVA_SUSPENSO=1                   desliga TUDO (vence qualquer outra)
//   MOVA_RELE_DATABASE_URL            (homologação) fila durável do relé (papel mova_rele_consumidor); com recebimento ligado,
//                                     o backend CONSOME o relé em vez de receber direto do Gateway (Execução 11)
//   MOVA_PG_CA                        CA do provedor do banco (PEM); na falta, usa FV2_PG_CA. TLS nunca deixa de ser verificado
//   16A — PILOTO de consultas com dados REAIS (MOVA_MODO=PILOTO + MOVA_AMBIENTE=piloto + MOVA_HOMOLOGACAO_MARCADOR):
//   MOVA_FINANCEIRO_LEITURA_URL       credencial PRÓPRIA de leitura do Financeiro (membro só de fv2_leitor_mova, migração 0028);
//                                     conferida no banco antes de montar (não escreve, não é administrativa)
//   MOVA_PILOTO_UNIDADE_ID            a ÚNICA unidade do piloto. O banco do MOVA continua o de homologação (marcador);
//                                     só conversas privadas, só consultas (nenhuma proposta), identidade = IDENTIDADE_MOVA
//   Agente 2 — OPERACAO em GRUPOS REAIS (MOVA_MODO=OPERACAO + MOVA_AMBIENTE=operacao + MOVA_OPERACAO_MARCADOR):
//     o estado do MOVA fica num schema `mova` PRÓPRIO no banco de produção, marcado `comment on schema mova is
//     'MOVA_OPERACAO:<marcador>'` (database/mova-financeiro/producao/instalar.sql). O banco de HOMOLOGAÇÃO é recusado
//     (dados reais nunca se misturam aos de teste) e o marcador de homologação na OPERACAO é contradição.
//   mesmas barreiras do PILOTO (credencial só-leitura do Financeiro, identidade do MOVA, banco do MOVA marcado) e mais:
//   MOVA_OPERACAO_UNIDADES            lista FECHADA de unidades (uuid,uuid): qualquer unidade ativa fora dela recusa a montagem
//   grupos só por LISTA de participantes; conversas privadas só as derivadas da lista; comandos simples sem IA;
//   documentos/propostas DESLIGADOS (só consultas) até a Frente B ser liberada (MOVA_OPERACAO_DOCUMENTOS=1).
//   MOVA_OPERACAO_DOCUMENTOS_SEM_IA=1: PDF/foto de quem envia documentos é conferido, guardado e fica "aguardando conferência" na
//     Central (sem IA, sem proposta, sem escrita no Financeiro). Independe da IA e do orçamento.
// Além das variáveis, a tabela mova.controle desliga cada etapa NA HORA (sem reiniciar nada) — reversão funcional.
import { Router } from "express";
import express from "express";
import pg from "pg";
import { ACAO, ErroFinanceiro, comandos, criarNucleoFinanceiro, planoDeContas } from "../financeiro-v2/index.js";
import { criarPortaOperacional } from "../mova-financeiro/index.js";
import {
  MODELOS_PERMITIDOS, carregarConfiguracao, criarRedator, criarSaidaPeloRele, ehConversaPrivada, clienteComOrcamento, criarConsumidorRele, criarControle, criarEnviadorDeRespostas, criarExtratorAnthropic, criarMova, criarOrcamentoIa, criarWorker, validarConfiguracao, configuracaoViva,
} from "../mova-financeiro/index.js";
import { LIMITE_CORPO_MOVA_BYTES, ROTA_EVENTO_MOVA, criarRotaEventosMova } from "../mova-financeiro/gateway/rota.js";
import { assinarRequisicao, exigirHmac } from "../comunicacao/gateway/whatsappGateway.hmac.js";
import { IDENTIDADE_MOVA, criarLeitorFinanceiroMova } from "./leitorMova.js";

export const CONTRATO_FINANCEIRO = Object.freeze({ ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sim = (v) => v === "1";

/** Lê a configuração (nunca imprime valores). Ausente, inválida ou CONTRADITÓRIA ⇒ desligado com motivo. */
export function lerConfiguracaoMova(env) {
  if (env.MOVA_HABILITADO !== "1") return { habilitado: false, motivo: "DESLIGADO" };
  if (sim(env.MOVA_SUSPENSO)) return { habilitado: false, motivo: "SUSPENSO" };
  const faltando = ["MOVA_DATABASE_URL", "MOVA_SERVICO_USUARIO_ID"].filter((k) => !env[k]);
  if (faltando.length) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando };
  if (!UUID.test(env.MOVA_SERVICO_USUARIO_ID)) return { habilitado: false, motivo: "CONFIGURACAO_INCOMPLETA", faltando: ["MOVA_SERVICO_USUARIO_ID"] };
  const recebimento = sim(env.MOVA_RECEBIMENTO_HABILITADO);
  const processamento = sim(env.MOVA_PROCESSAMENTO_HABILITADO);
  const ia = sim(env.MOVA_IA_HABILITADA);
  const envio = sim(env.MOVA_ENVIO_HABILITADO);
  const contradicoes = [];
  // Modo: HOMOLOGACAO precisa das três confirmações; qualquer sinal parcial é contradição (nunca cai em outro modo em silêncio).
  const operacao = env.MOVA_MODO === "OPERACAO";
  const piloto = env.MOVA_MODO === "PILOTO" || operacao; // a OPERACAO herda TODAS as barreiras do piloto (leitor, identidade, marcador)
  const sinaisHomolog = [env.MOVA_MODO === "HOMOLOGACAO", env.MOVA_AMBIENTE === "homologacao", Boolean(env.MOVA_HOMOLOGACAO_MARCADOR)];
  const homologacao = !piloto && sinaisHomolog.every(Boolean);
  if (!piloto && sinaisHomolog.some(Boolean) && !homologacao) contradicoes.push("HOMOLOGACAO_INCOMPLETA");
  if (env.MOVA_MODO && !["HOMOLOGACAO", "SIMULACAO", "PILOTO", "OPERACAO"].includes(env.MOVA_MODO)) contradicoes.push("MODO_DESCONHECIDO");
  const marcadorValido = (m) => /^[A-Za-z0-9_-]{12,64}$/.test(m ?? "");
  if ((homologacao || (piloto && !operacao)) && !marcadorValido(env.MOVA_HOMOLOGACAO_MARCADOR)) contradicoes.push("MARCADOR_INVALIDO");
  // OPERACAO: marcador PRÓPRIO do schema de produção; o de homologação junto é contradição (nunca o banco de teste).
  if (operacao && !marcadorValido(env.MOVA_OPERACAO_MARCADOR)) contradicoes.push("MARCADOR_INVALIDO");
  if (operacao && env.MOVA_HOMOLOGACAO_MARCADOR) contradicoes.push("OPERACAO_COM_MARCADOR_DE_HOMOLOGACAO");
  if (!operacao && env.MOVA_OPERACAO_MARCADOR) contradicoes.push("MARCADOR_DE_OPERACAO_FORA_DA_OPERACAO");
  // 16A: o piloto lê o Financeiro REAL só pela credencial de leitura; o estado do MOVA continua no banco de homologação.
  if (piloto) {
    if (env.MOVA_AMBIENTE !== (operacao ? "operacao" : "piloto")) contradicoes.push(operacao ? "OPERACAO_INCOMPLETA" : "PILOTO_INCOMPLETO");
    const leitura = env.MOVA_FINANCEIRO_LEITURA_URL;
    if (!leitura) contradicoes.push("PILOTO_SEM_LEITOR");
    // Nunca a mesma credencial de NENHUM outro banco configurado (aplicação, autoridade, MOVA, relé ou qualquer outro).
    else if (Object.entries(env).some(([k, v]) => k !== "MOVA_FINANCEIRO_LEITURA_URL" && /_DATABASE_URL$/.test(k) && v === leitura)) contradicoes.push("PILOTO_LEITOR_COM_OUTRA_CREDENCIAL");
    if (!operacao && !UUID.test(env.MOVA_PILOTO_UNIDADE_ID ?? "")) contradicoes.push("PILOTO_SEM_UNIDADE");
    const unidadesOperacao = String(env.MOVA_OPERACAO_UNIDADES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (operacao && (!unidadesOperacao.length || !unidadesOperacao.every((u) => UUID.test(u)))) contradicoes.push("OPERACAO_SEM_UNIDADES");
    if (operacao && env.MOVA_PILOTO_UNIDADE_ID) contradicoes.push("OPERACAO_COM_UNIDADE_DO_PILOTO");
    if (String(env.MOVA_SERVICO_USUARIO_ID ?? "").toLowerCase() !== IDENTIDADE_MOVA) contradicoes.push("PILOTO_IDENTIDADE_DIFERENTE_DO_LEITOR");
  }
  // Agente 2 — Frente C: AUTONOMIA (conferência com o extrato + políticas; só leitura) e ESCRITA (liquidação pelo serviço oficial).
  // Escrita exige a autonomia, a OPERACAO e uma identidade OPERACIONAL própria (nunca a de leitura do MOVA).
  const autonomia = sim(env.MOVA_OPERACAO_AUTONOMIA);
  const escrita = sim(env.MOVA_OPERACAO_ESCRITA);
  if ((autonomia || escrita) && !operacao) contradicoes.push("AUTONOMIA_FORA_DA_OPERACAO");
  if (escrita && !autonomia) contradicoes.push("ESCRITA_SEM_AUTONOMIA");
  if (sim(env.MOVA_OPERACAO_CRIAR_DESPESAS) && !sim(env.MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE)) contradicoes.push("CRIAR_DESPESAS_SEM_PAGAMENTO_POR_COMPROVANTE");
  if (sim(env.MOVA_OPERACAO_REGISTRAR_JUROS) && !sim(env.MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE)) contradicoes.push("REGISTRAR_JUROS_SEM_PAGAMENTO_POR_COMPROVANTE");
  if (sim(env.MOVA_OPERACAO_CRIAR_CONTAS) && !autonomia) contradicoes.push("CRIAR_CONTAS_SEM_AUTONOMIA");
  if (escrita && !UUID.test(env.MOVA_IDENTIDADE_OPERACIONAL ?? "")) contradicoes.push("ESCRITA_SEM_IDENTIDADE_OPERACIONAL");
  // Agente 2 — Frente D: entregadores no privado (só OPERACAO) e a rotina semanal (exige os entregadores).
  const entregadores = sim(env.MOVA_ENTREGADORES);
  const rotinaEntregadores = sim(env.MOVA_ENTREGADORES_ROTINA);
  if (entregadores && !operacao) contradicoes.push("ENTREGADORES_FORA_DA_OPERACAO");
  if (rotinaEntregadores && !entregadores) contradicoes.push("ROTINA_SEM_ENTREGADORES");
  if (escrita && String(env.MOVA_IDENTIDADE_OPERACIONAL ?? "").toLowerCase() === String(env.MOVA_SERVICO_USUARIO_ID ?? "").toLowerCase()) contradicoes.push("IDENTIDADE_OPERACIONAL_IGUAL_A_LEITURA");
  if (processamento && !recebimento) contradicoes.push("PROCESSAMENTO_SEM_RECEBIMENTO");
  if (ia && !processamento) contradicoes.push("IA_SEM_PROCESSAMENTO");
  if (envio && !processamento) contradicoes.push("ENVIO_SEM_PROCESSAMENTO");
  // 15B: o Gateway é serviço PRIVADO — em homologação o envio vai pela fila de saída do relé (MOVA_RELE_DATABASE_URL);
  // MOVA_GATEWAY_URL (chamada direta) só serve para um backend dentro da rede privada do Render.
  if (envio && !env.MOVA_GATEWAY_URL && !env.MOVA_RELE_DATABASE_URL) contradicoes.push("ENVIO_SEM_TRANSPORTE");
  // 15A: envio exige o MARCO de ativação (ISO UTC): respostas criadas antes dele nunca são enviadas (nada retroativo).
  const envioNaoAntesDe = env.MOVA_ENVIO_NAO_ANTES_DE || null;
  if (envio && !(envioNaoAntesDe && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(envioNaoAntesDe))) contradicoes.push("ENVIO_SEM_MARCO");
  if ((recebimento || envio) && !(String(env.MOVA_GATEWAY_SECRET ?? "").length >= 32)) contradicoes.push("CANAL_SEM_SEGREDO");
  if (env.MOVA_GATEWAY_SECRET && env.MOVA_GATEWAY_SECRET === env.WHATSAPP_GATEWAY_SECRET) contradicoes.push("SEGREDO_IGUAL_AO_PRINCIPAL");
  if (env.MOVA_DATABASE_URL && env.FV2_APP_DATABASE_URL && env.MOVA_DATABASE_URL === env.FV2_APP_DATABASE_URL && !homologacao) contradicoes.push("BANCO_COMPARTILHADO_FORA_DA_HOMOLOGACAO");
  // Teto estrito por chamada (Execução 13B): as duas chaves juntas, inteiras e positivas; esforço opcional e de lista fechada.
  const tetoSaida = env.MOVA_IA_TETO_SAIDA, tetoEntrada = env.MOVA_IA_TETO_ENTRADA, tetoEsforco = env.MOVA_IA_TETO_ESFORCO || null;
  let teto = null;
  if (tetoSaida || tetoEntrada || tetoEsforco) {
    if (!/^[1-9][0-9]{1,5}$/.test(tetoSaida ?? "") || !/^[1-9][0-9]{1,6}$/.test(tetoEntrada ?? "") || (tetoEsforco && !["low", "medium", "high"].includes(tetoEsforco))) contradicoes.push("TETO_IA_INVALIDO");
    else teto = Object.freeze({ maxSaida: Number(tetoSaida), maxEntrada: Number(tetoEntrada), esforco: tetoEsforco });
  }
  // Modelo da IA: lista FECHADA (hoje só Claude Haiku 5.5, decisão do proprietário em 21/11/2026); vazio = o padrão (Haiku).
  const modeloIa = env.MOVA_IA_MODELO || null;
  if (modeloIa && !MODELOS_PERMITIDOS.includes(modeloIa)) contradicoes.push("MODELO_IA_NAO_PERMITIDO"); // só Haiku 5.5 (decisão 21/11)
  if (contradicoes.length) return { habilitado: false, motivo: "CONFIGURACAO_CONTRADITORIA", contradicoes };
  return {
    habilitado: true, databaseUrl: env.MOVA_DATABASE_URL, servicoUsuarioId: env.MOVA_SERVICO_USUARIO_ID.toLowerCase(),
    recebimento, processamento, ia, envio, modo: operacao ? "OPERACAO" : piloto ? "PILOTO" : homologacao ? "HOMOLOGACAO" : "SIMULACAO", marcador: operacao ? env.MOVA_OPERACAO_MARCADOR : homologacao || piloto ? env.MOVA_HOMOLOGACAO_MARCADOR : null,
    ...(piloto && !operacao ? { pilotoUnidadeId: env.MOVA_PILOTO_UNIDADE_ID.toLowerCase(), leituraUrl: env.MOVA_FINANCEIRO_LEITURA_URL, somenteConsultas: true } : {}),
    ...(operacao ? { operacaoUnidades: String(env.MOVA_OPERACAO_UNIDADES).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean), leituraUrl: env.MOVA_FINANCEIRO_LEITURA_URL,
      somenteConsultas: !sim(env.MOVA_OPERACAO_DOCUMENTOS), recebimentoDocumental: sim(env.MOVA_OPERACAO_DOCUMENTOS_SEM_IA), comandosDeterministicos: true, autonomia, escrita,
      pagamentoPorComprovante: sim(env.MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE),
      // 23/11: criar a conta a pagar de despesa sem conta prévia (exige o pagamento por comprovante; padrão DESLIGADA).
      criarDespesas: sim(env.MOVA_OPERACAO_CRIAR_DESPESAS),
      // 23/11: registrar juros/multa confirmados junto com o pagamento por comprovante (exige o pagamento por comprovante; padrão DESLIGADA).
      registrarJuros: sim(env.MOVA_OPERACAO_REGISTRAR_JUROS),
      // 24/11: conta a pagar NOVA a partir de boleto/nota e vínculo da nota com a conta existente (padrão DESLIGADA; exige a autonomia).
      criarContas: sim(env.MOVA_OPERACAO_CRIAR_CONTAS),
      // Piloto de leitura documental: com IA ligada, ela lê SÓ arquivos (texto solto nunca gasta orçamento). Padrão LIGADO;
      // desligar exige MOVA_IA_SOMENTE_DOCUMENTOS=0 explícito.
      iaSomenteDocumentos: env.MOVA_IA_SOMENTE_DOCUMENTOS === undefined || env.MOVA_IA_SOMENTE_DOCUMENTOS === "" ? true : sim(env.MOVA_IA_SOMENTE_DOCUMENTOS), entregadores, rotinaEntregadores,
      identidadeOperacional: escrita ? env.MOVA_IDENTIDADE_OPERACIONAL.toLowerCase() : null } : {}), teto, modeloIa, envioNaoAntesDe: envio ? envioNaoAntesDe : null, transporteEnvio: envio ? (env.MOVA_RELE_DATABASE_URL ? "RELE" : "DIRETO") : null,
    // 15I: teto de respostas por processo (teste controlado). Vazio = sem teto; inválido = 0 (nada sai).
    envioMaximo: env.MOVA_ENVIO_MAXIMO ? (/^[0-9]{1,4}$/.test(env.MOVA_ENVIO_MAXIMO) ? Number(env.MOVA_ENVIO_MAXIMO) : 0) : null,
    // 23/11: teto operacional DIÁRIO (persistente, 00h Fortaleza) e por conversa (anti-laço; padrão 10 quando há teto diário).
    // Vazio = sem teto diário; inválido = 0 (nada sai). Só a configuração amplia; o código nunca.
    envioMaximoDia: env.MOVA_ENVIO_MAXIMO_DIA ? (/^[0-9]{1,4}$/.test(env.MOVA_ENVIO_MAXIMO_DIA) ? Number(env.MOVA_ENVIO_MAXIMO_DIA) : 0) : null,
    envioMaximoPorConversaDia: env.MOVA_ENVIO_MAXIMO_POR_CONVERSA_DIA ? (/^[0-9]{1,3}$/.test(env.MOVA_ENVIO_MAXIMO_POR_CONVERSA_DIA) ? Number(env.MOVA_ENVIO_MAXIMO_POR_CONVERSA_DIA) : 0) : (env.MOVA_ENVIO_MAXIMO_DIA ? 10 : null),
    respostasNaturais: ia && sim(env.MOVA_RESPOSTAS_NATURAIS),
    // 23/11: "<unidadeId>=<grupo>@g.us[,…]" — grupo da gerência COMPARTILHADO indicado pelo proprietário para os avisos de uma
    // unidade sem grupo exclusivo. Entrada inválida é ignorada (o aviso fica pendente, como sem grupo).
    avisosNoGrupo: Object.freeze(Object.fromEntries(String(env.MOVA_AVISOS_NO_GRUPO ?? "").split(",").map((x) => x.trim().toLowerCase().split("="))
      .filter(([u, g, ...r]) => !r.length && UUID.test(u ?? "") && /^[0-9]{10,30}@g\.us$/.test(g ?? "")))),
  };
}

/**
 * 16A: o piloto opera UMA unidade, por conversas PRIVADAS (sem grupo). Qualquer outra configuração ativa no banco do MOVA
 * (segunda unidade, grupo, unidade diferente da declarada) ⇒ recusa a montagem.
 */
export function exigirEscopoDoPiloto(configuracao, unidadeId) {
  const motivos = [];
  if (configuracao.unidades.length !== 1) motivos.push("PILOTO_EXIGE_UMA_UNIDADE");
  else if (configuracao.unidades[0].unidadeId !== unidadeId) motivos.push("PILOTO_UNIDADE_DIFERENTE");
  if (configuracao.gruposAutorizados.length === 0) motivos.push("PILOTO_SEM_CONVERSA");
  if (configuracao.gruposAutorizados.some((g) => !ehConversaPrivada(g.grupoId))) motivos.push("PILOTO_COM_GRUPO");
  if (motivos.length) throw Object.assign(new Error("Configuração fora do escopo do piloto."), { codigo: "PILOTO_FORA_DO_ESCOPO", motivos });
}

/**
 * Agente 2 — OPERACAO: só unidades da lista fechada; todo grupo por LISTA (validarConfiguracao já exige); nenhuma conversa
 * privada que não seja derivada da lista. Qualquer desvio ⇒ recusa a montagem (nada sobe pela metade).
 */
export function exigirEscopoDaOperacao(configuracao, unidades) {
  const motivos = [];
  if (configuracao.unidades.some((u) => !unidades.includes(u.unidadeId))) motivos.push("OPERACAO_UNIDADE_FORA_DA_LISTA");
  if (!configuracao.gruposAutorizados.some((g) => g.grupoId.endsWith("@g.us"))) motivos.push("OPERACAO_SEM_GRUPO");
  if (configuracao.gruposAutorizados.some((g) => !g.grupoId.endsWith("@g.us") && !g.derivada)) motivos.push("OPERACAO_COM_CONVERSA_AVULSA");
  if (configuracao.gruposAutorizados.some((g) => g.acesso !== "LISTA")) motivos.push("OPERACAO_GRUPO_SEM_LISTA");
  if (motivos.length) throw Object.assign(new Error("Configuração fora do escopo da operação."), { codigo: "OPERACAO_FORA_DO_ESCOPO", motivos });
}

/** Recusa (lança) se o banco não for o de HOMOLOGAÇÃO marcado. Banco de produção não tem o comentário ⇒ recusa. */
export async function exigirBancoDeHomologacao(pool, marcador) {
  const r = await pool.query("select shobj_description(d.oid, 'pg_database') as c from pg_database d where d.datname = current_database()");
  if (!marcador || r.rows[0]?.c !== `MOVA_HOMOLOGACAO:${marcador}`) throw Object.assign(new Error("Banco não é o de homologação do MOVA."), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
}

/**
 * OPERACAO: recusa (lança) se o schema `mova` não for o da operação marcado, ou se o banco for o de HOMOLOGAÇÃO.
 * Dados reais ficam só no schema próprio de produção; o banco de teste nunca guarda estado da operação.
 */
export async function exigirBancoDaOperacao(pool, marcador) {
  const r = await pool.query(
    "select obj_description(n.oid, 'pg_namespace') as s, (select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()) as d from pg_namespace n where n.nspname = 'mova'");
  const linha = r.rows[0];
  if (typeof linha?.d === "string" && linha.d.startsWith("MOVA_HOMOLOGACAO:")) throw Object.assign(new Error("Banco de homologação não guarda a operação."), { codigo: "BANCO_DE_HOMOLOGACAO_NA_OPERACAO" });
  if (!marcador || linha?.s !== `MOVA_OPERACAO:${marcador}`) throw Object.assign(new Error("Schema mova não é o da operação."), { codigo: "BANCO_NAO_E_DA_OPERACAO" });
}

/** Extrator quando a IA está DESLIGADA: nada vai a provedor externo; o evento falha com código claro (não é transitório). */
export const EXTRATOR_DESLIGADO = Object.freeze({ async extrair() { throw Object.assign(new Error("IA_DESLIGADA"), { codigo: "IA_DESLIGADA" }); } });
/** Piloto documental: a IA só recebe mensagens COM arquivo; texto solto segue como se a IA estivesse desligada (sem custo). */
export const extratorSoDeDocumentos = (extrator) => Object.freeze({ async extrair(e) { return e?.midia ? extrator.extrair(e) : EXTRATOR_DESLIGADO.extrair(e); } });

/**
 * Monta o MOVA sobre o pool do schema `mova` e o repositório do Financeiro. Testável: tudo injetável.
 * @param {{cfg:object, pool:object, repositorio:object, verificarBancoFinanceiro?:() => Promise<void>, criarClienteIa?:() => object,
 *          enviarAoGateway?:Function, relogio?:() => Date, registrar?:Function}} p
 */
export async function montarMova({ cfg, pool, repositorio, verificarBancoFinanceiro = null, criarClienteIa = null, enviarAoGateway = null, releSaida = null, relogio = () => new Date(), registrar = () => {}, comAutomacao = null, operacionalDaPlataforma = null }) {
  if (cfg.modo === "HOMOLOGACAO" || cfg.modo === "PILOTO" || cfg.modo === "OPERACAO") {
    // HOMOLOGACAO/PILOTO: estado no banco de homologação marcado. OPERACAO: schema próprio de produção marcado (nunca o de teste).
    if (cfg.modo === "OPERACAO") await exigirBancoDaOperacao(pool, cfg.marcador);
    else await exigirBancoDeHomologacao(pool, cfg.marcador);
    if (!verificarBancoFinanceiro) throw Object.assign(new Error("Sem verificação do banco do Financeiro."), { codigo: "BANCO_FINANCEIRO_NAO_VERIFICADO" });
    // HOMOLOGACAO: o Financeiro também é o de homologação. PILOTO: a credencial do Financeiro é de leitura pura (0028).
    await verificarBancoFinanceiro();
  }
  const lerConfiguracao = async () => validarConfiguracao(await carregarConfiguracao(pool, { identidadeServico: { usuarioId: cfg.servicoUsuarioId }, modo: cfg.modo ?? "SIMULACAO" }));
  // 23/11: só a lista de entregadores é recarregada em funcionamento (a cada envio/rotina, no máximo 1×/min, ou na hora pelo cadastro).
  const configuracao = configuracaoViva(await lerConfiguracao(), { recarregar: lerConfiguracao, relogio: () => relogio().getTime() });
  if (cfg.modo === "PILOTO") exigirEscopoDoPiloto(configuracao, cfg.pilotoUnidadeId);
  if (cfg.modo === "OPERACAO") exigirEscopoDaOperacao(configuracao, cfg.operacaoUnidades);
  const escopos = configuracao.unidades.map((u) => ({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }));
  if (escopos.length === 0) throw Object.assign(new Error("Nenhuma conversa/unidade configurada."), { codigo: "SEM_CONFIGURACAO" });
  const nucleoBase = criarNucleoFinanceiro({ repositorio, exigirConcessaoPersistida: true, escoposAutorizados: escopos, relogio });
  // Leituras do worker (sem pessoa): cada chamada roda no contexto de AUTOMAÇÃO da plataforma, que abre a sessão de banco da
  // identidade de serviço só se ela tiver concessão ativa na unidade. Sem o contexto (testes/memória), o núcleo é usado direto.
  const nucleoServico = comAutomacao
    ? Object.freeze(Object.fromEntries(Object.entries(nucleoBase).map(([k, f]) => [k, typeof f === "function" ? (...a) => comAutomacao(() => f(...a)) : f])))
    : nucleoBase;
  const controle = criarControle({ pool });
  const orcamento = criarOrcamentoIa({ pool });
  let mova = null;
  const obterEvidencia = (ref) => mova.evidencias.obter(ref);
  const extratorIa = cfg.ia && criarClienteIa
    ? criarExtratorAnthropic({ cliente: clienteComOrcamento(criarClienteIa(), { orcamento, controle, teto: cfg.teto ?? null }), obterEvidencia, relogio, ...(cfg.modeloIa ? { modelo: cfg.modeloIa } : {}) })
    : EXTRATOR_DESLIGADO;
  const extrator = extratorIa !== EXTRATOR_DESLIGADO && cfg.iaSomenteDocumentos === true ? extratorSoDeDocumentos(extratorIa) : extratorIa;
  // 15A: respostas naturais — desligadas por padrão; exigem IA ligada e passam pelo MESMO orçamento/teto do extrator.
  const redator = cfg.ia && cfg.respostasNaturais && cfg.iaSomenteDocumentos !== true && criarClienteIa
    ? criarRedator({ cliente: clienteComOrcamento(criarClienteIa(), { orcamento, controle, teto: cfg.teto ?? null }), registrar })
    : null;
  // Agente 2 — Frente C: a escrita só existe com a identidade OPERACIONAL implantada pela plataforma (núcleo de escrita + concessões
  // dela). Sem isso a montagem RECUSA (nada sobe pela metade); sem `escrita`, o MOVA confere e propõe, nunca escreve.
  let operacional = null;
  if (cfg.escrita) {
    const op = operacionalDaPlataforma ? await operacionalDaPlataforma({ identidade: cfg.identidadeOperacional, escopos }) : null;
    if (!op?.nucleo || !op?.concessoes) throw Object.assign(new Error("Identidade operacional não implantada."), { codigo: "IDENTIDADE_OPERACIONAL_NAO_IMPLANTADA" });
    operacional = criarPortaOperacional({ nucleo: op.nucleo, concessoes: op.concessoes, financeiro: CONTRATO_FINANCEIRO, identidade: cfg.identidadeOperacional, identidadeLeitura: cfg.servicoUsuarioId });
  }
  mova = criarMova({ configuracao, nucleo: nucleoServico, autonomia: cfg.autonomia === true, operacional, entregadores: cfg.entregadores === true, pagamentoPorComprovante: cfg.pagamentoPorComprovante === true, criarDespesas: cfg.criarDespesas === true, registrarJuros: cfg.registrarJuros === true, criarContas: cfg.criarContas === true, avisosNoGrupo: cfg.avisosNoGrupo ?? {}, concessoes: { listar: async () => [] }, financeiro: CONTRATO_FINANCEIRO, extrator, pool, relogio, registrar, controle, redator, somenteConsultas: cfg.somenteConsultas === true, comandosDeterministicos: cfg.comandosDeterministicos === true, recebimentoDocumental: cfg.recebimentoDocumental === true });
  const worker = cfg.processamento ? criarWorker({ receptor: mova.receptor, registrar }) : null;
  const enviadorBase = criarEnviadorDeRespostas({ armazenamento: mova.armazenamento, controle, registrar,
    enviar: enviarAoGateway ?? (async () => { throw Object.assign(new Error("sem gateway"), { codigo: "GATEWAY_NAO_CONFIGURADO" }); }),
    habilitado: Boolean(cfg.envio && (enviarAoGateway || releSaida)), naoAntesDe: cfg.envioNaoAntesDe ?? null, rele: releSaida, maximoDeEnvios: cfg.envioMaximo ?? null,
    maximoPorDia: cfg.envioMaximoDia ?? null, maximoPorConversaDia: cfg.envioMaximoPorConversaDia ?? null,
    // Homologação/piloto: só conversas PRIVADAS autorizadas. OPERACAO: os grupos por LISTA e as privadas DERIVADAS da lista.
    destinosPermitidos: () => configuracao.gruposAutorizados.map((g) => g.grupoId).filter((j) => cfg.modo === "OPERACAO" || ehConversaPrivada(j)) });
  const recarregar = async () => {
    try { const r = await configuracao.recarregarEntregadores(); if (r.trocado) registrar({ tipo: "MOVA_ENTREGADORES_RECARREGADOS" }); else if (r.motivo === "OUTRAS_MUDANCAS_EXIGEM_REINICIO") registrar({ tipo: "MOVA_CONFIGURACAO_EXIGE_REINICIO" }); }
    catch (e) { registrar({ tipo: "MOVA_ENTREGADORES_RECARGA_FALHOU", codigo: e?.codigo ?? e?.code ?? "ERRO" }); } // mantém a lista atual
  };
  const enviador = Object.freeze({ ...enviadorBase, async enviarPendentes(o) { await recarregar(); return enviadorBase.enviarPendentes(o); } });
  // Rotina dos entregadores: um passo a cada 5 min (idempotente; automação desligada/pausada por unidade não envia nada).
  const rotina = cfg.rotinaEntregadores && mova.entregadores ? criarRotinaPeriodica(async () => { await recarregar(); return mova.entregadores.rotina(); }, { registrar }) : null;
  return { mova, worker, enviador, configuracao, controle, orcamento, rotina };
}

/** Cliente de envio pelo canal isolado do Gateway (rota /internal/mova/messages, segredo MOVA). */
export function criarEnvioPeloCanal({ gatewayUrl, segredo, fetchFn = (...a) => fetch(...a), timeoutMs = 15_000 }) {
  const caminho = "/internal/mova/messages";
  return async ({ grupoId, texto, idempotencia }) => {
    const corpo = JSON.stringify({ grupoJid: grupoId, texto, idempotencyKey: idempotencia });
    const headers = { ...assinarRequisicao({ segredo, metodo: "POST", caminho, corpo }), "Content-Type": "application/json" };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    // 15A (achado G-1): o Gateway gera id de mensagem aleatório e NÃO deduplica pela chave de idempotência. Então só é
    // seguro repetir o que comprovadamente NÃO chegou a ser enviado; o resto é ENVIO_INCERTO (sem nova tentativa automática).
    try { r = await fetchFn(`${gatewayUrl.replace(/\/$/, "")}${caminho}`, { method: "POST", headers, body: corpo, signal: ctrl.signal }); }
    catch (e) {
      // Tempo esgotado: o Gateway pode ter enviado e a resposta se perdido. Falha de conexão (antes de qualquer byte): seguro repetir.
      if (e?.name === "AbortError") throw Object.assign(new Error("resposta do gateway incerta"), { codigo: "ENVIO_INCERTO" });
      throw Object.assign(new Error("gateway inalcançável"), { codigo: "GATEWAY_INALCANCAVEL" });
    }
    finally { clearTimeout(t); }
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.providerMessageId) return { providerMessageId: j.providerMessageId };
    if (r.ok) throw Object.assign(new Error("gateway sem id"), { codigo: "ENVIO_INCERTO" }); // 2xx sem id: pode ter saído
    throw Object.assign(new Error("gateway recusou"), { codigo: j.error ?? (r.status >= 500 ? "ENVIO_INCERTO" : `GATEWAY_${r.status}`) });
  };
}

// ------------------------------------------------------------------ montagem da PLATAFORMA (preguiçosa, única por processo)
let instancia = null;
let obterDependenciasFv2 = null;
/** Chamado por criarFinanceiroV2DaPlataforma: entrega o repositório do Financeiro (mesma conexão e regras das rotas). */
export function registrarDependenciasFv2(fn) { obterDependenciasFv2 = fn; }

/** MOVA da plataforma, ou null (desligado/incompleto/recusado). Nunca derruba o backend. */
/** Passo periódico sem sobreposição (um de cada vez); falha só registra. `parar()` encerra. */
export function criarRotinaPeriodica(passo, { intervaloMs = 5 * 60 * 1000, registrar = () => {} } = {}) {
  let rodando = false;
  const tick = async () => {
    if (rodando) return null;
    rodando = true;
    try { return await passo(); } catch (e) { registrar({ tipo: "MOVA_ROTINA_FALHOU", codigo: e?.codigo ?? e?.code ?? "ERRO" }); return null; } finally { rodando = false; }
  };
  const timer = setInterval(tick, intervaloMs);
  timer.unref?.();
  return Object.freeze({ tick, parar: () => clearInterval(timer) });
}
export async function movaDaPlataforma({ env, registrar = () => {} }) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || (!obterDependenciasFv2 && cfg.modo !== "PILOTO" && cfg.modo !== "OPERACAO")) return null;
  if (instancia) return instancia;
  instancia = (async () => {
    // TLS SEMPRE verificado; a CA do provedor (ex.: raiz do Supabase) vem de MOVA_PG_CA ou, na falta, de FV2_PG_CA.
    const ca = env.MOVA_PG_CA ?? env.FV2_PG_CA ?? null;
    const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4, idleTimeoutMillis: 30000, ssl });
    pool.on("error", () => {});
    const verificarBancoFinanceiro = async () => {
      const c = new pg.Client({ connectionString: env.FV2_APP_DATABASE_URL, ssl });
      await c.connect();
      try { await exigirBancoDeHomologacao(c, cfg.marcador); } finally { await c.end(); }
    };
    let criarClienteIa = null;
    if (cfg.ia && !env.ANTHROPIC_API_KEY) registrar({ evento: "MOVA_IA_SEM_CHAVE", aviso: "MOVA_IA_HABILITADA=1 sem ANTHROPIC_API_KEY: leitura por IA fica desligada" }); // falha segura: o resto segue
    if (cfg.ia && env.ANTHROPIC_API_KEY) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); criarClienteIa = () => new Anthropic({ maxRetries: 0, timeout: 60_000 }); } // sem nova tentativa oculta: cada tentativa passa pela reserva
    const enviarAoGateway = cfg.envio && cfg.transporteEnvio === "DIRETO" ? criarEnvioPeloCanal({ gatewayUrl: env.MOVA_GATEWAY_URL, segredo: env.MOVA_GATEWAY_SECRET }) : null;
    const releSaida = cfg.envio && cfg.transporteEnvio === "RELE" ? criarSaidaPeloRele({ pool: obterPoolRele(env) }) : null;
    if (cfg.modo === "PILOTO" || cfg.modo === "OPERACAO") {
      // 16A: Financeiro REAL só pela credencial de leitura do MOVA (pool próprio, 2 conexões, consulta com teto de tempo).
      const poolLeitor = new pg.Pool({ connectionString: cfg.leituraUrl, max: 2, idleTimeoutMillis: 30000, ssl, statement_timeout: 15000, application_name: cfg.modo === "OPERACAO" ? "mova-operacao-leitor" : "mova-piloto-leitor" });
      poolLeitor.on("error", () => {});
      const leitor = criarLeitorFinanceiroMova({ pool: poolLeitor });
      // Escrita (Frente C/D): só se a plataforma registrar o provedor da identidade operacional (implantação do Agente 1).
      const operacionalDaPlataforma = cfg.escrita ? (obterDependenciasFv2?.()?.operacionalMova ?? null) : null;
      return montarMova({ cfg, pool, repositorio: leitor.repositorio, comAutomacao: null, verificarBancoFinanceiro: leitor.verificar, criarClienteIa, enviarAoGateway, releSaida, registrar, operacionalDaPlataforma });
    }
    const dep = obterDependenciasFv2();
    return montarMova({ cfg, pool, repositorio: dep.repositorio, comAutomacao: dep.comAutomacaoMova ?? null, verificarBancoFinanceiro, criarClienteIa, enviarAoGateway, releSaida, registrar });
  })().catch((e) => { instancia = null; registrar({ tipo: "MOVA_MONTAGEM_FALHOU", codigo: e?.codigo ?? e?.code ?? "ERRO" }); return null; });
  return instancia;
}

/**
 * Router ISOLADO do canal Gateway ⇄ MOVA (app.js monta em /internal/mova): HMAC com MOVA_GATEWAY_SECRET (nunca o segredo
 * principal). Só existe com MOVA habilitado e recebimento ligado; senão null (a rota não existe).
 */
export function criarRouterMovaIsolado(env, { obterMova = () => movaDaPlataforma({ env }) } = {}) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !cfg.recebimento) return null;
  const r = Router();
  r.use(express.raw({ type: "*/*", limit: LIMITE_CORPO_MOVA_BYTES }), exigirHmac(env.MOVA_GATEWAY_SECRET));
  const receptor = { async receber(payload, o) { const m = await obterMova(); return m ? m.mova.receptor.receber(payload, o) : { status: "INDISPONIVEL", motivo: "MOVA_NAO_MONTADO" }; } };
  r.use(criarRotaEventosMova({ receptor }));
  return r;
}

/** Compatibilidade (Execução 03): injeção no router do Gateway principal — não é mais usada pelo app.js. */
export function movaParaGateway(env) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado || !cfg.recebimento) return null;
  const receptor = { async receber(payload, o) { const m = await movaDaPlataforma({ env }); return m ? m.mova.receptor.receber(payload, o) : { status: "INDISPONIVEL", motivo: "MOVA_NAO_MONTADO" }; } };
  return { receptor, rota: criarRotaEventosMova, limiteBytes: LIMITE_CORPO_MOVA_BYTES, caminho: ROTA_EVENTO_MOVA };
}

let laco = null;
let consumidorRele = null;
let poolReleUnico = null;
/** Pool ÚNICO do relé (papel mova_rele_consumidor): entrada (consumidor) e saída (fila de respostas) usam a mesma conexão. */
function obterPoolRele(env) {
  if (poolReleUnico) return poolReleUnico;
  const ca = env.MOVA_PG_CA ?? env.FV2_PG_CA ?? null;
  poolReleUnico = new pg.Pool({ connectionString: env.MOVA_RELE_DATABASE_URL, max: 2, idleTimeoutMillis: 30000, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
  poolReleUnico.on("error", () => {});
  return poolReleUnico;
}
/** Worker + enviador em laço (server.js, depois do listen). Desligado por padrão; nunca derruba o backend. */
export async function iniciarMovaEmbutido({ env, log = () => {} }) {
  const cfg = lerConfiguracaoMova(env);
  if (!cfg.habilitado) return { habilitado: false, motivo: cfg.motivo };
  // Fase B: só recebimento pelo relé (sem processamento) também inicia — o consumidor enfileira no MOVA, o worker fica parado.
  if (!cfg.processamento && !(env.MOVA_RELE_DATABASE_URL && cfg.recebimento)) return { habilitado: false, motivo: "PROCESSAMENTO_DESLIGADO" };
  const m = await movaDaPlataforma({ env, registrar: (e) => log("warn", "mova.evento", e) });
  if (!m) return { habilitado: false, motivo: "MOVA_NAO_MONTADO" };
  m.worker?.iniciar();
  if (env.MOVA_RELE_DATABASE_URL && cfg.recebimento && !consumidorRele) {
    consumidorRele = criarConsumidorRele({ pool: obterPoolRele(env), receptor: m.mova.receptor, segredo: env.MOVA_GATEWAY_SECRET, controle: m.controle, registrar: (e) => log("warn", "mova.rele", e) });
    consumidorRele.iniciar();
  }
  if (m.enviador.habilitado && !laco) laco = setInterval(() => { m.enviador.enviarPendentes().catch(() => {}); }, 5000);
  return { habilitado: true, envio: m.enviador.habilitado, rele: Boolean(consumidorRele) };
}
export async function pararMovaEmbutido({ env }) {
  consumidorRele?.parar(); consumidorRele = null;
  if (laco) { clearInterval(laco); laco = null; }
  const m = instancia ? await instancia : null;
  m?.worker?.parar();
  void env;
}
