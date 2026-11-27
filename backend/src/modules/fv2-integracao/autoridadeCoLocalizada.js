// AUTORIDADE CO-LOCALIZADA (Execução 10) — decisão do proprietário: um ÚNICO serviço no Render (sem gateway separado).
//
// Implementa a porta `sessoes` do repositório chamando o MESMO emissor do gateway (emissorDeSessoes.js), dentro do
// processo do backend, com a credencial PRÓPRIA da autoridade (papel de login membro de fv2_autoridade, pool separado).
//
// O QUE ISSO NÃO É: isolamento forte. A credencial da autoridade fica no MESMO processo que a aplicação comum; quem
// comprometer esse processo (execução de código ou vazamento de variáveis) obtém as duas e pode:
//   - abrir sessões de banco para pessoas que TÊM concessão (o banco ainda exige concessão ativa — FV020);
//   - contornar no código a exigência de 2º fator das ações sensíveis (o banco não a confere, salvo na liberação).
// O que continua valendo: credenciais comuns (anon/authenticated/service_role) sem caminho até o schema; RLS e funções
// protegidas no banco; credenciais separadas no banco (papéis distintos, limite de conexões); registros sem segredos.
// Por isso o modo só liga com aceite EXPLÍCITO (FV2_AUTORIDADE_COLOCALIZADA_ACEITA=1) e a primeira ativação é só consulta.
import { criarEmissorDeSessoes } from "./emissorDeSessoes.js";
import { identidadeDaRequisicao, vinculoDaRequisicao } from "./clienteGateway.js";

const erro = (r) => Object.assign(new Error("A autoridade financeira recusou o pedido."), { code: r.codigoBanco ?? undefined, motivoGateway: r.motivo, statusGateway: r.status });

/** @param {{poolAutoridade:{query:Function}, obterUsuario:Function, mfa:{provar:Function}, relogio?:Function, registrar?:Function}} p */
export function criarAutoridadeCoLocalizada(p) {
  const emissor = criarEmissorDeSessoes(p);
  return Object.freeze({
    async emitir(e) {
      const id = identidadeDaRequisicao();
      if (!id?.tokenDeAcesso || !id?.sessao) throw erro({ status: 401, motivo: "SEM_IDENTIDADE_DA_REQUISICAO" });
      const escopo = { organizacaoId: e.organizacaoId, unidadeId: e.unidadeId, usuarioId: e.usuarioId };
      // 27/11: o escopo da CONTRAPARTE declarada pela operação entre empresas em curso → autorização vinculada (regra própria).
      const vinculo = vinculoDaRequisicao(e);
      const r = vinculo
        ? await emissor.emitirSessaoVinculada({ sessao: id.sessao, contaPessoal: id.contaPessoal === true, token: id.tokenDeAcesso, escopo, vinculo })
        : await emissor.emitirSessao({ sessao: id.sessao, contaPessoal: id.contaPessoal === true, finalidade: id.finalidade, token: id.tokenDeAcesso, escopo });
      if (!r.ok) throw erro(r);
      return r.token;
    },
    /** Marca do token (o repositório nunca reaproveita um token vinculado fora da sua operação). */
    vinculoPara: (e) => vinculoDaRequisicao(e)?.chave ?? null,
    marcaDaSessao: () => identidadeDaRequisicao()?.sessao?.acesso?.sessionId ?? null,
    // Provisionamento do administrador inicial (rota própria, chave FV2_PROVISIONAMENTO_HABILITADO): mesma regra do gateway.
    async emitirProvisionamento(ato) {
      const id = identidadeDaRequisicao();
      if (!id?.tokenDeAcesso || !id?.sessao) throw erro({ status: 401, motivo: "SEM_IDENTIDADE_DA_REQUISICAO" });
      const r = await emissor.emitirProvisionamento({ sessao: id.sessao, ato, token: id.tokenDeAcesso });
      if (!r.ok) throw erro(r);
      return r.token;
    },
  });
}
