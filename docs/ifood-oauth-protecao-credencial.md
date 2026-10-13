# iFood — proteção da credencial Order no OAuth multi-loja

Status: **preparado em branch isolada (`feat/ifood-oauth-protecao-credencial`), sem commit, sem deploy, sem OAuth real.**

## 1. O problema

`/oauth/complete` troca o código de autorização por tokens e **grava por cima** da credencial Order da conexão
(`ifood_credenciais`, único por `conexao_id,app_type`). Hoje a credencial da Sanduíches funciona. Se a Saladas for autorizada e o token
novo cobrir **só** a Saladas (ou não declarar escopo), a Sanduíches perde o acesso e o Events/pedidos reais param.

## 2. O que o JWT atual mostra (inspeção local, somente leitura, sem rede)

- Access token em formato **JWT**, com claim `merchant_scope` (lista com 2 itens) e `merchant_scoped: true`.
- Itens no formato `<merchantId>:<módulo>`: **só a Sanduíches** (`a6e54f…39b9`), módulos `order` e `events`.
- **A Saladas não está no escopo.** Validade de 6 h.
- Ressalva: ler a claim prova o que o token **declara**, não que o servidor do iFood o **aceita**.

## 3. Como a proteção funciona (`ifoodCredencialProtecao.js`, `ifoodTokenEscopo.js`)

Quando já existe credencial Order e chega uma nova autorização:

1. Lê as lojas adicionais vivas (`ativa`/`liberada`); se não conseguir ler → **recusa**.
2. Exige que o token **novo** declare, para a loja principal e cada loja viva, **os mesmos módulos** do token atual
   (`order`+`events` se o atual for ilegível).
3. Token novo opaco, sem `merchant_scope` ou com validade < 60 s → **recusa**.
4. Gravação **condicional** (compare-and-set sobre o token atual): se o token foi renovado no meio, **recusa** e não sobrescreve.
5. Recusa = `IFOOD_CREDENCIAL_SEM_COBERTURA` (409), sessão OAuth `failed`, credencial intacta, log `oauth.credencial_preservada`
   (ids mascarados, nunca token).
6. Sucesso = log `oauth.credencial_substituida`.

Primeira conexão (sem credencial) e apps Financial/Analytics: comportamento anterior. Nenhuma migration.

## 4. Limites

- Não impede que o iFood **invalide o refresh token anterior** no momento da nova autorização (ver §6): a proteção age depois da troca
  do código. Se o iFood revogar o refresh antigo ao autorizar, o access token atual segue valendo até expirar (≤ 6 h), mas a renovação
  falharia. Por isso o passo real exige o Gerente acompanhando e uma janela, e depende da resposta do suporte.
- Só protege o fluxo do app. Não protege contra alteração direta no banco.

## 5. Sequência segura proposta (só com autorização futura)

1. Resposta do suporte (§6) e aprovação do PR com a proteção.
2. Deploy da proteção; Saladas segue `pendente`.
3. Janela supervisionada: iniciar OAuth, autorizar a Saladas no Portal, concluir. Se o token cobrir as duas lojas, a proteção grava;
   caso contrário, mantém a credencial atual e nada muda.
4. Só então liberar a Saladas no polling (passo separado).

Rollback: reverter o PR (a proteção não altera dados). Credencial perdida → reautorizar a Sanduíches pelo fluxo normal.

## 6. Consulta ao suporte iFood

> Assunto: Autorização de um segundo merchant no mesmo app distribuído (Order/Events) — efeito sobre tokens existentes
>
> Nosso app distribuído já opera o merchant A em produção (Order + Events). Vamos autorizar o merchant B (mesmo grupo) no mesmo app.
> Antes de fazer isso, precisamos confirmar:
>
> 1. Ao concluir a autorização do merchant B, o **refresh token** emitido antes (com escopo só do merchant A) é **invalidado**?
>    Em que momento: ao digitar o código no Portal, ao trocar o authorizationCode, ou nunca?
> 2. O **access token** atual continua válido até o `exp`, ou é revogado?
> 3. O novo token passa a ter `merchant_scope` com **todos** os merchants autorizados ao app (A e B) ou só o autorizado naquele fluxo?
> 4. Há como autorizar o merchant B **sem** gerar novos tokens (apenas ampliar o escopo), e o token atual passa a cobrir B após
>    renovação? Qual a propagação (a documentação cita até 10 minutos)?
> 5. A autorização vale na digitação do código no Portal do Parceiro ou só na troca do authorizationCode?
> 6. Há risco de o Events do merchant A (polling em andamento) receber 401/403 durante a transição?
>
> Dados: client id do app Order (a informar pelo responsável) e merchants A/B (a informar pelo responsável).

## 7. Testes

`backend/test/ifood-oauth-protecao-credencial.test.js` (20 testes): tokens JWT sintéticos não assinados e OAuth simulado, sem rede,
sem banco. Cobre parser, prova de cobertura, recusa (só Saladas, opaco, sem escopo, vencido, extras, falha ao ler, CAS perdido),
sucesso (Sanduíches; Sanduíches+Saladas), Financial inalterado e ausência de token/ids completos em logs e erro.
