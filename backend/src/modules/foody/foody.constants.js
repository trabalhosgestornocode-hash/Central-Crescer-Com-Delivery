// Camada central Foody — PILOTO EM SOMBRA. Constantes, catálogos fechados e flags.
//
// Nesta fase o módulo NÃO tem consumidores: nada aqui é importado por server.js, pelo Parser, pelo Dashboard, pelo Checklist,
// pelas notificações ou pelo WhatsApp (há teste de arquitetura garantindo isso). Tudo fica DESLIGADO por padrão.

export const FOODY_BASE_URL = "https://app.foodydelivery.com/rest/1.2";
/** Tamanho máximo de página observado na API real (lista ordenada por `date`). */
export const FOODY_TAMANHO_PAGINA = 500;
/** Limite documentado: 100 req/min. 700 ms entre chamadas ≈ 85/min, com folga. */
export const FOODY_ESPACAMENTO_MS = 700;
export const FOODY_MAX_PAGINAS = 40;
export const FOODY_TIMEOUT_MS = 30_000;
export const FOODY_TENTATIVAS = 3;

/** Fuso de parede de todas as unidades atuais. A API devolve tudo em -03:00. */
export const FOODY_OFFSET = "-03:00";
export const FOODY_OFFSET_MIN = -180;

/** Versão das regras de cálculo do fechamento logístico (entra no hash; mudar = nova versão de regra). */
export const FOODY_REGRA_VERSAO = 1;
/** Reprocessa D-1..D-N; depois disso o dia fica CONGELADO (só reprocessamento explícito com motivo). */
export const FOODY_DIAS_REPROCESSO = 3;

/** Status da API → vocabulário do relatório usado pelo Parser. Catálogo fechado: valor desconhecido vira pendência. */
export const STATUS_FOODY_PARA_SITUACAO = Object.freeze({
  closed: "Finalizado",
  cancelled: "Cancelado",
  delivered: "Entregue",
  ready: "Pronto",
});

export const FORMA_PAGAMENTO = Object.freeze({ online: "Pg. Online", card: "Cartão", money: "Dinheiro" });

export const RAZAO_CANCELAMENTO = Object.freeze({
  other: "Outros",
  ifood_cancellation: "Cancelamento proveniente do IFood",
});

/** courierType (catálogo FECHADO): só `internal` é entregador próprio; qualquer outro valor é "não classificado". */
export const ENTREGADOR_TIPO = Object.freeze({
  PROPRIO: "proprio",
  NAO_CLASSIFICADO: "nao_classificado",
  SEM_ENTREGADOR: "sem_entregador",
});
export const COURIER_TYPE_PROPRIO = new Set(["internal"]);

export const ESTADO_VALORES = Object.freeze({
  SINCRONIZADO: "SINCRONIZADO", // veio da API, cobertura completa, sem decisão pendente
  PROVISORIO: "PROVISORIO",     // há cancelamento em revisão, tipo de entregador não classificado ou operação em dúvida
  CONCILIADO: "CONCILIADO",     // reservado: revisão humana feita (fase futura)
  CUSTO_REAL: "CUSTO_REAL",     // reservado: composto com os lançamentos (fase futura)
});

export const STATUS_FECHAMENTO = Object.freeze({
  PRELIMINAR: "PRELIMINAR",
  CONSOLIDADO: "CONSOLIDADO",
  CORRIGIDO: "CORRIGIDO",
  INCOMPLETO: "INCOMPLETO",
});

/**
 * Fechamento DEFINITIVO = cobertura completa (CONSOLIDADO/CORRIGIDO) E nenhum valor provisório (estado SINCRONIZADO, ou os
 * estados reservados CONCILIADO/CUSTO_REAL). Regra ÚNICA para qualquer consumidor (Parser, relatórios, tela): o status sozinho
 * não basta — um CORRIGIDO pode carregar pendência nova. PRELIMINAR/INCOMPLETO/PROVISORIO nunca contam como definitivos.
 */
export function fechamentoDefinitivo(f) {
  const status = f?.status;
  const estado = f?.estado_valores ?? f?.estadoValores;
  return (status === "CONSOLIDADO" || status === "CORRIGIDO") && (estado === "SINCRONIZADO" || estado === "CONCILIADO" || estado === "CUSTO_REAL");
}

export const ORIGEM = Object.freeze({ MANUAL: "manual", AGENDADO: "agendado", REPROCESSAMENTO: "reprocessamento" });

/** Feature flags (todas DESLIGADAS se ausentes). */
export const FLAG_HABILITADO = "FOODY_CENTRAL_ENABLED";
export const FLAG_AGENDADOR = "FOODY_CENTRAL_AGENDADOR_ENABLED";
export const FLAG_UNIDADES = "FOODY_CENTRAL_UNIDADES";
/** Conexão COMPARTILHADA (migration 148): distribuição por operação para destinos ATIVOS. Desligada = comportamento da 147. */
export const FLAG_COMPARTILHAMENTO = "FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED";
/**
 * ADMINISTRAÇÃO da integração pela tela (149): cadastrar/ativar/pausar/revogar a conexão, propor/aprovar/revogar o
 * compartilhamento e decidir a triagem. É SEPARADA da sincronização: ligar esta flag não coleta nenhum pedido — a coleta depende
 * só de FOODY_CENTRAL_ENABLED + allowlist (+ agendador), que são outra decisão.
 */
export const FLAG_ADMINISTRACAO = "FOODY_CENTRAL_ADMIN_ENABLED";
/**
 * Guardar o NOME do entregador que a API Foody envia (`courier.courierName`), além do hash. Exige a migration 160.
 * Desligada (padrão) = só o hash, exatamente como antes. Pedido do proprietário em 10/11/2026: o Parser precisa do nome para
 * conferir e pagar os entregadores. O nome nunca vai para logs, respostas de sincronização ou prévia.
 */
export const FLAG_ENTREGADOR_NOME = "FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED";
/**
 * Guardar a DISTÂNCIA EM RAIO (km, linha reta ponto de coleta → ponto de entrega), calculada na coleta a partir das
 * coordenadas que a API envia (`collectionPoint.coordinates` e `deliveryPoint.coordinates`). Exige a migration 161.
 * Só o número (km, 2 casas) é guardado — as coordenadas do cliente NUNCA. Desligada (padrão) = exatamente como antes.
 */
export const FLAG_DISTANCIA = "FOODY_CENTRAL_DISTANCIA_ENABLED";
/** Segredo (≥ 32 caracteres) do qual derivam a chave do token e a chave do HMAC do entregador. Nunca vai ao banco. */
export const ENV_SEGREDO = "FOODY_CENTRAL_SECRET";
