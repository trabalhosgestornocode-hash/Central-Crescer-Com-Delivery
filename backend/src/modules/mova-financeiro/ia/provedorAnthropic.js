// PROVEDOR DE IA REAL do MOVA — Claude (Anthropic) pelo SDK oficial `@anthropic-ai/sdk` (já dependência do backend, usado
// pelo Agente Crescer). Implementa a MESMA porta `extrator.extrair()` do contrato estrito (ia/contratos.js).
//
// Por que Claude: o SDK já está no projeto; lê imagem e PDF nativamente (blocos `image`/`document`, PDF com texto + visão);
// saída estruturada por JSON Schema (`output_config.format`) — e o servidor valida de novo com validarSaidaDaIa.
// O que ele NÃO faz: áudio. Áudio passa por uma porta `transcritor` separada (pendente: nenhum provedor de transcrição foi
// escolhido). Sem transcritor, o áudio falha com código explícito e o grupo recebe "envie por texto".
//
// Segurança: o modelo nunca recebe ferramentas, nunca escreve SQL, nunca grava; conteúdo da mensagem/documento vai como DADO
// (delimitado). O modelo não redige números para o grupo: as respostas são montadas pelo motor a partir do Financeiro.
// Desligado por padrão: só é montado com MOVA_IA_HABILITADA=1 (ver fv2-integracao/mova.js). Nada de chave no repositório.
import { ErroTransitorio } from "../gateway/fila.js";
import { PROMPT_DO_EXTRATOR, esquemaDaSaida, montarEntradaDoModelo, normalizarSentinelas } from "./contratos.js";

// DECISÃO DE ARQUITETURA (proprietário, 21/11/2026): o MOVA usa EXCLUSIVAMENTE o Claude Haiku 5.5. A IA só interpreta;
// cálculos, validações, permissões e regras financeiras são do backend. Sem fallback automático para outro modelo.
export const MODELO_PADRAO = "claude-haiku-5-5";
export const MODELOS_PERMITIDOS = Object.freeze(["claude-haiku-5-5"]);
/** Modelos em que `thinking: {type: "disabled"}` é aceito (até esforço high). */
export const MODELOS_SEM_RACIOCINIO = Object.freeze(["claude-haiku-5-5"]);
/** Teto padrão de saída: o JSON do contrato ocupa ~240 tokens; sem raciocínio, 600 dá folga sem expor custo. */
export const SAIDA_MAXIMA_PADRAO = 600;
const ehModeloPermitido = (m) => MODELOS_PERMITIDOS.includes(String(m ?? "").replace(/-\d{8}$/, ""));
const MIDIA_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp"]);

export class ErroDeIa extends Error {
  constructor(codigo) { super(codigo); this.name = "ErroDeIa"; this.codigo = codigo; }
}

/** 429, 5xx, 529 e falhas de conexão/tempo são transitórios (a fila tenta de novo); o resto é permanente. */
export function ehFalhaTransitoriaDeIa(e) {
  const s = Number(e?.status);
  return s === 429 || s === 408 || s >= 500 || /APIConnection(Timeout)?Error|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(`${e?.name ?? ""} ${e?.code ?? ""}`);
}

/**
 * @param {{cliente:{beta:{messages:{create:Function}}}, obterEvidencia:(referencia:string) => Promise<Uint8Array|null>,
 *          transcritor?:{transcrever:(bytes:Uint8Array, mime:string) => Promise<string>}|null, modelo?:string, esforco?:string,
 *          relogio?:() => Date}} deps
 */
export function criarExtratorAnthropic({ cliente, obterEvidencia, transcritor = null, modelo = MODELO_PADRAO, esforco = "medium", relogio = () => new Date() }) {
  if (!cliente?.beta?.messages?.create) throw new TypeError("cliente Anthropic ausente");
  if (!ehModeloPermitido(modelo)) throw new TypeError(`modelo de IA não permitido no MOVA: ${modelo}`);
  const esquema = esquemaDaSaida();

  async function conteudoDaMidia(midia) {
    const bytes = await obterEvidencia(midia.referencia);
    if (!bytes) throw new ErroTransitorio("EVIDENCIA_INDISPONIVEL");
    const b64 = Buffer.from(bytes).toString("base64");
    if (MIDIA_IMAGEM.has(midia.mime)) return { blocos: [{ type: "image", source: { type: "base64", media_type: midia.mime, data: b64 } }], transcricao: null };
    if (midia.mime === "application/pdf") return { blocos: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }], transcricao: null };
    if (midia.mime.startsWith("audio/")) {
      if (!transcritor) throw new ErroDeIa("AUDIO_SEM_TRANSCRICAO");
      let texto;
      try { texto = await transcritor.transcrever(bytes, midia.mime); } catch (e) {
        if (ehFalhaTransitoriaDeIa(e)) throw new ErroTransitorio("TRANSCRICAO_INDISPONIVEL");
        throw new ErroDeIa("TRANSCRICAO_FALHOU");
      }
      return { blocos: [], transcricao: String(texto ?? "").slice(0, 4096) };
    }
    throw new ErroDeIa("MIDIA_NAO_SUPORTADA");
  }

  return Object.freeze({
    modelo,
    /**
     * @param {{texto:string|null, tipo:string, midia:{mime:string, referencia:string}|null,
     *          contexto?:{unidades?:string[], mensagemCitada?:string|null}}} e
     */
    async extrair({ texto, tipo, midia, contexto = {} }) {
      const { blocos, transcricao } = midia ? await conteudoDaMidia(midia) : { blocos: [], transcricao: null };
      // A mensagem citada (resposta direta no WhatsApp) é o ÚNICO contexto de conversa: mensagens só próximas no tempo não entram.
      const dados = [texto, transcricao ? `[transcrição do áudio]\n${transcricao}` : null, contexto.mensagemCitada ? `[mensagem respondida]\n${contexto.mensagemCitada}` : null].filter(Boolean).join("\n\n");
      const entrada = montarEntradaDoModelo({ texto: dados, tipo, mime: midia?.mime ?? null });
      const referencia = relogio().toISOString().slice(0, 10);
      const cv = contexto.conversa;
      const linhaConversa = cv?.consulta ? `\nCONTEXTO DA CONVERSA (sistema; última pergunta desta pessoa): consulta=${cv.consulta}; unidade=${cv.unidade ?? "-"}; período=${cv.periodo ?? "-"}.` : "";
      const system = `${entrada.instrucoes}\nDATA DE REFERÊNCIA (hoje): ${referencia}. Unidades possíveis: ${(contexto.unidades ?? []).join("; ") || "não informadas"}.${linhaConversa}`;
      let resposta;
      try {
        resposta = await cliente.beta.messages.create({
          model: modelo, max_tokens: SAIDA_MAXIMA_PADRAO,
          output_config: { effort: esforco, format: { type: "json_schema", schema: esquema } },
          // Execução 13C: extração estruturada não precisa de raciocínio; só os modelos que ACEITAM desligá-lo (Opus 5.5 recusa: 400).
          ...(MODELOS_SEM_RACIOCINIO.includes(modelo) && ["low", "medium", "high"].includes(esforco) ? { thinking: { type: "disabled" } } : {}),
          system,
          messages: [{ role: "user", content: [...blocos, { type: "text", text: entrada.conteudo }] }],
        });
      } catch (e) {
        if (e instanceof ErroDeIa) throw e; // orçamento/controle (Execução 05): código preservado, a chamada nem saiu
        if (ehFalhaTransitoriaDeIa(e)) throw new ErroTransitorio("IA_INDISPONIVEL");
        throw new ErroDeIa(Number(e?.status) === 400 ? "IA_REQUISICAO_INVALIDA" : Number(e?.status) === 401 || Number(e?.status) === 403 ? "IA_SEM_AUTORIZACAO" : "IA_ERRO_PERMANENTE");
      }
      // Sem fallback: se outro modelo respondeu (roteamento inesperado), a saída é descartada (o custo já foi registrado).
      if (resposta?.model && !ehModeloPermitido(resposta.model)) throw new ErroDeIa("IA_MODELO_INESPERADO");
      if (resposta?.stop_reason === "refusal") throw new ErroDeIa("IA_RECUSOU");
      if (resposta?.stop_reason === "max_tokens") throw new ErroDeIa("IA_RESPOSTA_TRUNCADA");
      const textoJson = (resposta?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      let saida;
      try { saida = JSON.parse(textoJson); } catch { throw new ErroDeIa("IA_JSON_INVALIDO"); }
      if (transcricao && saida && typeof saida === "object" && !Array.isArray(saida)) saida.transcricao = transcricao;
      return normalizarSentinelas(saida); // o motor valida com validarSaidaDaIa (chaves fechadas, enums, tipos)
    },
  });
}
