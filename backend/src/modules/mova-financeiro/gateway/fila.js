// FILA do MOVA (porta + implementação em memória). Idempotente por `eventoId`: reenvio de webhook nunca gera segundo
// processamento. Falha TRANSITÓRIA (Financeiro fora, mídia indisponível) volta para a fila com espera crescente até o teto;
// falha PERMANENTE (ou teto atingido) vai para FALHOU (fila de mortos), sem efeito financeiro.
//
// A implementação persistente (tabela própria no banco, com lease) é PENDENTE: exige migração e autorização. A memória
// serve aos testes e à simulação; o contrato (métodos e estados) é o mesmo que a versão persistente deve cumprir.

export const ESTADO_ITEM = Object.freeze({ PENDENTE: "PENDENTE", PROCESSANDO: "PROCESSANDO", CONCLUIDO: "CONCLUIDO", FALHOU: "FALHOU" });
export const METODOS_DA_FILA = Object.freeze(["enfileirar", "processarPendentes", "estado", "listar"]);

/** Erro que pede nova tentativa (o item volta para a fila). */
export class ErroTransitorio extends Error {
  constructor(codigo) { super(codigo); this.name = "ErroTransitorio"; this.codigo = codigo; }
}

/**
 * @param {{maxTentativas?:number, esperaBaseMs?:number, relogio?:() => number}} [o]
 */
export function criarFilaMemoria({ maxTentativas = 5, esperaBaseMs = 1000, relogio = () => Date.now() } = {}) {
  const itens = new Map();
  return {
    /** @returns {{aceito:boolean, duplicado:boolean}} */
    enfileirar(eventoId, carga) {
      if (typeof eventoId !== "string" || !eventoId) throw new TypeError("eventoId obrigatório");
      if (itens.has(eventoId)) return { aceito: false, duplicado: true };
      itens.set(eventoId, { eventoId, carga, estado: ESTADO_ITEM.PENDENTE, tentativas: 0, proximaEm: 0, ultimoErro: null, resultado: null });
      return { aceito: true, duplicado: false };
    },
    /**
     * Processa os itens vencidos, em ordem de chegada, um de cada vez.
     * @param {(carga:any, item:{eventoId:string, tentativas:number}) => Promise<any>} tratar
     * @param {{aoDesistir?:(item:object) => Promise<void>|void}} [o] chamado UMA vez quando o item vai para FALHOU
     */
    async processarPendentes(tratar, { aoDesistir } = {}) {
      const agora = relogio();
      let processados = 0;
      for (const item of itens.values()) {
        if (item.estado !== ESTADO_ITEM.PENDENTE || item.proximaEm > agora) continue;
        item.estado = ESTADO_ITEM.PROCESSANDO;
        item.tentativas += 1;
        try {
          item.resultado = await tratar(item.carga, { eventoId: item.eventoId, tentativas: item.tentativas });
          item.estado = ESTADO_ITEM.CONCLUIDO;
          item.ultimoErro = null;
        } catch (e) {
          // Só o CÓDIGO do erro fica registrado (nunca a mensagem, que pode carregar conteúdo).
          item.ultimoErro = e instanceof ErroTransitorio ? e.codigo : "ERRO_PERMANENTE";
          if (e instanceof ErroTransitorio && item.tentativas < maxTentativas) {
            item.estado = ESTADO_ITEM.PENDENTE;
            item.proximaEm = agora + esperaBaseMs * 2 ** (item.tentativas - 1);
          } else {
            item.estado = ESTADO_ITEM.FALHOU;
            if (aoDesistir) await aoDesistir({ eventoId: item.eventoId, carga: item.carga, codigo: item.ultimoErro });
          }
        }
        processados += 1;
      }
      return processados;
    },
    estado(eventoId) {
      const i = itens.get(eventoId);
      return i ? { estado: i.estado, tentativas: i.tentativas, ultimoErro: i.ultimoErro, resultado: i.resultado } : null;
    },
    listar() { return [...itens.values()].map((i) => ({ eventoId: i.eventoId, estado: i.estado, tentativas: i.tentativas, ultimoErro: i.ultimoErro })); },
  };
}
