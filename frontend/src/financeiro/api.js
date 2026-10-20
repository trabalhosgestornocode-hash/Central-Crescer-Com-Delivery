// Cliente do domínio financeiro. Usa o `http` da sessão (Authorization + x-context-token); NUNCA envia organização/unidade:
// o servidor as obtém do contexto validado. Todas as respostas do domínio vêm em { data }.
import { http } from "../sessao.js";
import { API_BASE } from "../config.js";
import { queryString } from "./modelo.js";

const BASE = "/api/v1/gestao-financeira";
const json = (metodo, corpo) => ({ method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo ?? {}) });

/** Download autenticado (mesmas credenciais do http): devolve { blob, nome }. Erros da API viram Error com a mensagem amigável. */
async function baixar(caminho, consulta) {
  const r = await fetch(`${API_BASE}${BASE}${caminho}${queryString(consulta)}`, { headers: await http.cabecalhos() });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Falha ao gerar o arquivo (${r.status}).`); }
  const nome = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "relatorio";
  return { blob: await r.blob(), nome };
}

export const fin = {
  baixar,
  get: async (caminho, consulta) => (await http.get(`${BASE}${caminho}${queryString(consulta)}`)).data,
  post: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("POST", corpo))).data,
  patch: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("PATCH", corpo))).data,
  put: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("PUT", corpo))).data,
};
