# Revogação emergencial de concessão financeira (flag de concessões desligada)

**Quando usar:** é preciso cortar o acesso financeiro de um perfil AGORA e a administração normal
(`/plataforma/gestao-financeira/concessoes`) está bloqueada (`FINANCEIRO_CONCESSOES_HABILITADAS` desligada ou MFA recente
não comprovado). **Isto não é um bypass de MFA:** é um procedimento de contenção, executado por pessoa autorizada,
fora do aplicativo, sempre auditado. Só **reduz** acesso — nunca concede.

> Não executar em produção como teste. Ensaiar no banco descartável. Em produção, só diante de incidente real e com
> aprovação registrada.

## Pré-requisitos
- Operador autorizado: SuperAdmin da plataforma com acesso ao SQL Editor/`service_role` do projeto (duas pessoas, quando possível: uma executa, outra confere).
- Ticket/registro do incidente com a justificativa (mín. 10 caracteres — o banco recusa menos).

## Passos
1. **Identificar a concessão** (somente leitura):
   ```sql
   select c.id, c.organizacao_id, c.unidade_id, c.perfil_id, c.nivel, c.somente_financeiro,
          c.concedida_em, c.expira_em, c.revogada_em, p.nome as perfil, u.nome as unidade
     from gestao_financeira_concessoes c
     join perfis_operacionais p on p.id = c.perfil_id
     join unidades u on u.id = c.unidade_id
    where c.revogada_em is null
      and c.perfil_id = '<PERFIL_UUID>';       -- ou c.unidade_id = '<UNIDADE_UUID>'
   ```
2. **Verificar unidade e perfil**: confira nome da unidade, empresa e perfil/pessoa com o ticket. Se houver dúvida, **pare** e peça confirmação — a revogação de outra pessoa por engano corta o acesso de quem trabalha.
3. **Executar a revogação** (uma concessão por vez, por `id`; nunca `update` sem `where id`):
   ```sql
   begin;
   update gestao_financeira_concessoes
      set revogada_em = now(),
          revogada_por = '<UUID_DO_OPERADOR>',          -- auth.users.id de quem executa
          motivo_revogacao = 'EMERGÊNCIA <ticket>: <justificativa clara>'
    where id = '<CONCESSAO_UUID>' and revogada_em is null
   returning id, perfil_id, unidade_id, revogada_em;
   -- deve retornar EXATAMENTE 1 linha; se 0 ou mais de 1, rollback;
   commit;
   ```
4. **Registro de auditoria:** o trigger grava automaticamente o evento `revogada` em `gestao_financeira_concessoes_auditoria` (append-only). Confirme:
   ```sql
   select evento, ator_id, motivo, ocorreu_em from gestao_financeira_concessoes_auditoria
    where concessao_id = '<CONCESSAO_UUID>' order by id desc limit 3;
   ```
   Registre também, no ticket, quem executou, quando e o `id` da concessão.
5. **Verificação posterior de bloqueio** (a revogação vale na requisição seguinte; nenhuma sessão é encerrada):
   - Banco: `select count(*) from gestao_financeira_concessoes where perfil_id = '<PERFIL_UUID>' and unidade_id = '<UNIDADE_UUID>' and revogada_em is null;` → **0**.
   - Aplicação: a pessoa (ou um perfil de teste) recebe **403 `FINANCEIRO_SEM_CONCESSAO`** em `GET /api/v1/gestao-financeira/status` e `GET /api/v1/sessao/setores` deixa de listar `financeiro`. O Dashboard Operacional continua funcionando.
6. **Encerrar:** anexar evidências (consultas 1, 3, 4 e 5) ao ticket. Reconciliar depois, pela tela do SuperAdmin, quando as escritas forem liberadas (a tela mostra a revogação e o motivo).

## O que NÃO fazer
- Não apagar linhas (`delete` não é concedido nem ao `service_role`) nem editar a trilha de auditoria (o banco recusa).
- Não desabilitar o módulo da empresa/unidade como atalho: isso corta **todos** os perfis daquela unidade.
- Não habilitar `FINANCEIRO_CONCESSOES_HABILITADAS` para "facilitar" a emergência.
- Não conceder acesso por SQL.

## Corte em massa (incidente grave)
Se for preciso cortar o financeiro de uma unidade inteira: **desabilitar o módulo na unidade** (`delete from unidade_modulos where unidade_id = '<UUID>' and modulo_id = 'gestao_financeira'`) é efetivo imediatamente (o gate relê o banco), mas é uma decisão de dois operadores e deve ser desfeita conscientemente depois; as concessões ficam intactas.
