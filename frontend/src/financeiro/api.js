// Cliente do domínio financeiro. Usa o `http` da sessão (Authorization + x-context-token); NUNCA envia organização/unidade:
// o servidor as obtém do contexto validado. Todas as respostas do domínio vêm em { data }.
import { http } from "../sessao.js";
import { queryString } from "./modelo.js";

const BASE = "/api/v1/gestao-financeira";
const json = (metodo, corpo) => ({ method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo ?? {}) });

export const fin = {
  get: async (caminho, consulta) => (await http.get(`${BASE}${caminho}${queryString(consulta)}`)).data,
  post: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("POST", corpo))).data,
  patch: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("PATCH", corpo))).data,
  put: async (caminho, corpo) => (await http.chamar(`${BASE}${caminho}`, json("PUT", corpo))).data,
};
