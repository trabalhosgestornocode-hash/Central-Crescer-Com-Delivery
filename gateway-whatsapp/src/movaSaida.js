// MOVA — FILA DE SAÍDA pelo relé de homologação (Execução 15B). INERTE por padrão.
//
// Por quê: este Gateway é um serviço PRIVADO (sem URL pública); o backend MOVA de homologação não consegue chamá-lo. Então o
// Gateway PERGUNTA ao relé (mesma Edge Function e mesmo segredo do canal MOVA, só conexão de SAÍDA) se há resposta a enviar:
//   POST <WHATSAPP_MOVA_BACKEND_URL>/internal/mova/saida  {acao:"reservar"} → envia → {acao:"confirmar"} | {acao:"falhar"}
//
// Só liga com TODAS: canal MOVA ativo + WHATSAPP_MOVA_ENVIO_HABILITADO=1 + homologação privada (contato verificado) + esta
// instância ser a LÍDER do lease. O envio em si é `sessao.enviarGrupoMova`, que já recusa qualquer destino que não seja o
// contato VERIFICADO (grupos do MOVA estão vazios). Nada aqui toca nos envios empresariais, relatórios, lease ou heartbeat.
//
// Deduplicação (G-1): a garantia persistente está no RELÉ (id estável, reserva atômica, lease vencido ⇒ INCERTA, nunca
// reenviada). Aqui há só uma barreira extra em memória (ids já enviados por este processo não saem de novo). Se a confirmação
// se perder depois do envio, NÃO há nova tentativa de envio: a saída fica INCERTA no relé, para revisão humana.
import { assinarRequisicao } from "./hmac.js";

export const CAMINHO_SAIDA_MOVA = "/internal/mova/saida";
const JID_PRIVADO = /^[1-9][0-9]{7,14}@s\.whatsapp\.net$/;

/** Decide se a saída pode existir neste processo (sem efeitos). */
// Agente 2: em produção o backend ENTREGA a resposta direto ao Gateway (POST /internal/mova/messages, canal MOVA). Lá não existe
// /internal/mova/saida, e a consulta ao relé só gerava 404 a cada 5 s. Com WHATSAPP_MOVA_SAIDA_MODO=DIRETO a fila do relé não
// sobe. O padrão (ausente) continua RELE, que é o comportamento da homologação; o envio direto não depende desta fila.
export const MODOS_SAIDA_MOVA = Object.freeze(["RELE", "DIRETO"]);
export function lerSaidaMova({ canalAtivo, envioHabilitado, contatoHomologacao, modo = "RELE" }) {
  if (!canalAtivo) return { ativo: false, motivo: "SEM_CANAL" };
  if (!envioHabilitado) return { ativo: false, motivo: "ENVIO_DESLIGADO" };
  if (modo === "DIRETO") return { ativo: false, motivo: "TRANSPORTE_DIRETO" };
  if (!contatoHomologacao) return { ativo: false, motivo: "SEM_CONTATO_VERIFICADO" };
  return { ativo: true };
}

/**
 * @param {{url:string, segredo:string, sessao:{enviarGrupoMova:Function}, gatewayId:string, souLider?:()=>boolean,
 *          fetchFn?:typeof fetch, timeoutMs?:number, intervaloMs?:number, lote?:number, tentativasConfirmacao?:number,
 *          agendar?:Function, cancelar?:Function, log?:Function}} deps
 */
export function criarSaidaMova({ url, segredo, sessao, gatewayId, souLider = () => true, fetchFn = (...a) => fetch(...a), timeoutMs = 10_000,
  intervaloMs = 5_000, lote = 1, tentativasConfirmacao = 3, agendar = (f, ms) => setTimeout(f, ms), cancelar = (t) => clearTimeout(t), log = () => {} }) {
  if (!url || !segredo || !sessao?.enviarGrupoMova || !/^[A-Za-z0-9_.:-]{1,80}$/.test(gatewayId ?? "")) throw new TypeError("saída MOVA: configuração incompleta");
  const jaEnviados = new Set(); // barreira extra (memória); a garantia persistente é do relé
  let timer = null; let rodando = false; let parado = true;

  async function chamar(acao) {
    const corpo = JSON.stringify({ ...acao, gateway: gatewayId });
    const headers = { ...assinarRequisicao({ segredo, metodo: "POST", caminho: CAMINHO_SAIDA_MOVA, corpo }), "Content-Type": "application/json" };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchFn(`${url}${CAMINHO_SAIDA_MOVA}`, { method: "POST", headers, body: corpo, signal: ctrl.signal });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } catch { return { status: 0, json: {} }; } finally { clearTimeout(t); }
  }

  async function informar(acao) {
    for (let i = 0; i < tentativasConfirmacao; i++) { // assinatura e nonce NOVOS a cada tentativa; só a CONFIRMAÇÃO é repetida, nunca o envio
      const r = await chamar(acao);
      if (r.status === 200) return r.json;
      if (r.status >= 400 && r.status < 500) break;
    }
    log("warn", "mova.saida_informe_perdido", { acao: acao.acao }); // o lease vence ⇒ INCERTA no relé (sem reenvio)
    return null;
  }

  async function rodada() {
    if (rodando || !souLider()) return { enviadas: 0, pulada: true };
    rodando = true; let enviadas = 0;
    try {
      const r = await chamar({ acao: "reservar", lote });
      if (r.status !== 200 || !Array.isArray(r.json.itens)) { if (r.status !== 200) log("warn", "mova.saida_reserva_falhou", { status: r.status }); return { enviadas: 0 }; }
      for (const item of r.json.itens) { // em ORDEM (o relé devolve por criação)
        const id = String(item?.id ?? "");
        if (!/^[0-9a-f-]{36}$/.test(id)) continue;
        if (jaEnviados.has(id)) { log("warn", "mova.saida_repetida_bloqueada", {}); await informar({ acao: "falhar", id, codigo: "JA_ENVIADA_NESTE_PROCESSO", antesDoEnvio: false }); continue; }
        if (!JID_PRIVADO.test(String(item.destino ?? "")) || typeof item.texto !== "string" || !item.texto.trim()) {
          await informar({ acao: "falhar", id, codigo: "ITEM_INVALIDO", antesDoEnvio: true }); continue;
        }
        let res;
        try {
          res = await sessao.enviarGrupoMova({ grupoJid: item.destino, texto: item.texto, correlationId: `mova-saida:${id}` });
        } catch (e) {
          // preEnvio=true: recusado ANTES de falar com o WhatsApp (desligado, destino não verificado, desconectado) ⇒ pode repetir.
          await informar({ acao: "falhar", id, codigo: String(e?.codigo ?? "FALHA_NO_ENVIO").slice(0, 80).replace(/[^A-Z0-9_:]/g, "_") || "FALHA_NO_ENVIO", antesDoEnvio: e?.preEnvio === true });
          continue;
        }
        jaEnviados.add(id); enviadas += 1;
        const pid = String(res?.providerMessageId ?? "");
        await informar({ acao: "confirmar", id, providerMessageId: /^[A-Za-z0-9_.:-]{1,120}$/.test(pid) ? pid : "SEM_ID" });
      }
      return { enviadas };
    } finally { rodando = false; }
  }

  function ciclo() {
    if (parado) return;
    rodada().catch(() => log("warn", "mova.saida_rodada_falhou", {})).finally(() => { if (!parado) timer = agendar(ciclo, intervaloMs); });
  }
  return Object.freeze({
    rodada,
    iniciar() { if (!parado) return; parado = false; timer = agendar(ciclo, intervaloMs); log("info", "mova.saida_iniciada", { intervaloMs }); },
    parar() { parado = true; if (timer) cancelar(timer); timer = null; },
  });
}
