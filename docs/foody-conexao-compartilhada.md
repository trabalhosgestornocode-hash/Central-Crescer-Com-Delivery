# Conexão Foody compartilhada (Subway Saci + Açaí no Grau Saci): código local, piloto em sombra

**Status:** código local + migration 145 **não aplicada**. A flag está desligada, não há rota HTTP nem consumidor. Ela é aplicada junto com a 144, com GO próprio.

**Problema:** a conta Foody da Subway Saci despacha também os pedidos do Açaí no Grau Saci, que é **outra organização**. A coleta precisa continuar única: uma conexão, um token e uma consulta à API. Depois, os pedidos são distribuídos por operação, sem misturar dados entre as empresas.

## 1. Decisões aprovadas

| # | Decisão |
|---|---|
| 1 | Uma conexão para as duas empresas. A unidade titular é a Subway Saci. A proteção F3 da 144 continua: uma conta (token) tem uma conexão ativa. |
| 2 | Indicadores por empresa: cada organização tem o próprio fechamento logístico. |
| 3 | Sem empresa pagadora, sem rateio e sem acerto: só o custo logístico de cada operação, no tenant dela. |
| 4 | Ambíguo vai para a triagem. **Item desconhecido também vai para a triagem**, mesmo que os outros itens do pedido sejam conhecidos. |
| 5 | O vínculo exige aprovação explícita e auditável do organization_admin das **duas** organizações. |
| 6 | Os 2.495 pedidos históricos de Açaí guardados pelo Parser (`parser_fd_pedidos`) **não são lidos pela aplicação, migrados nem alterados**. O gerador offline do catálogo lê o histórico só em `SELECT`. |
| 7 | Reaproveita a camada da 144 (PR #75). |

## 2. Fluxo

```
API Foody (GET, token da titular) ─► saneamento ─► classificação ESTRITA (catálogo versionado) ─► decisão de triagem (se houver)
                                                                                                   │
              ┌────────────────────────────┬──────────────────────────────┬────────────────────────┴──────────┐
         subway                      açaí + destino ATIVO            açaí sem destino ativo             triagem
   unidade TITULAR, completo    unidade DESTINO, completo         TITULAR, só mínimo (regra 144)   TITULAR, sem valor/pagamento
                                       (destino_id)                                               (mantém os itens p/ decidir)
```

- Um uid nunca fica **ativo** em dois tenants. Quando a operação muda (por decisão de triagem ou revogação), a linha antiga é **desativada** antes de a nova ser gravada: fica sem dado comercial e com `roteamento_motivo = RECLASSIFICADO`. O banco reforça a regra com `uq_foody_pedidos_conexao_uid_ativo`.
- **Destino PENDENTE ou sem flag:** comportamento da 144, com o Açaí mínimo na titular.
- **Destino revogado:** volta à regra da 144. As linhas que estavam ativas no destino são desativadas na próxima sync de cada dia reprocessado.
- **Fechamentos:** a mesma sync gera um fechamento da titular (Subway) e um por destino ativo (Açaí), cada um no próprio tenant. Triagem pendente na conexão deixa os **dois** PROVISÓRIOS, com a pendência `TRIAGEM_PENDENTE`. Erro no fechamento do destino não impede o da titular.

## 3. Classificação estrita

Arquivos: `foody.classificacao.js` (regra), `foody.catalogo-operacao.js` (catálogo **gerado**) e `foody.catalogo.gerador.js` (gerador puro).

- O pedido é quebrado em **linhas de item** (produto e complementos), normalizadas: sem quantidade, acento ou caixa, e com tamanhos genéricos.
- Cada linha precisa de evidência própria, de **uma** operação: a **linha inteira** no catálogo, ou um **termo validado**. Os termos validados são `acai` e `paleta` ("paletas são só do Açaí", confirmado pelo responsável em 03/11/2026) para o Açaí, e `subway` para a Subway.
- Linha sem evidência → `triagem / ITEM_DESCONHECIDO`. Evidências de operações diferentes → `triagem / CONFLITO`. Pedido sem linha → `triagem / SEM_EVIDENCIA`.
- Nunca há casamento por palavra solta: "gotas de chocolate" é cobertura no Açaí e sabor de cookie na Subway.

**Catálogo versionado:** versão `2026-11-03.1`, com 329 linhas Subway e 91 Açaí. O hash `78ee2124…f9f` está fixado no teste.
- Foi gerado de 15.330 pedidos do Parser da unidade titular (17/08 a 02/11/2026), 15.068 deles rotulados por termo.
- Nenhuma linha foi vista nas duas operações.
- Descartes: 200 linhas raras (menos de 2 ocorrências ou de 2 dias) e 9 com cara de texto livre.
- O conteúdo são nomes de produto e complemento do cardápio, sem dado de cliente.
- **Não aprende em produção:** o catálogo é congelado e o módulo não escreve arquivo. Para mudar, gere uma nova versão e abra um PR:

```bash
node --env-file=.env scripts/foody-gerar-catalogo.mjs --unidade=<uuid da titular> --versao=AAAA-MM-DD.N
# depois: atualizar VERSAO_FIXADA/HASH_FIXADO em test/foody-compartilhada-catalogo.test.js e revisar o diff das linhas
```

### Cobertura medida (regra estrita, sem dado pessoal: só agregados)

| Conjunto | Automático | Triagem | Divergência com o Parser |
|---|---|---|---|
| Holdout temporal: treino < 01/10, teste ≥ 01/10 (5.381 pedidos) | 94,37% | 303 (todos `ITEM_DESCONHECIDO`) | 2* |
| Holdout temporal: treino < 15/10, teste ≥ 15/10 (2.882 pedidos) | 97,05% | 85 | 2* |
| Catálogo oficial sobre o histórico inteiro (15.330, in-sample) | 98,08% | 295 | 9* |
| Catálogo oficial sobre os 385 pedidos reais da API Foody (2 dias) | **97,92%** | 8 | 1* |

\* Todas as divergências são pedidos de **paleta**: o Parser marca "revisão" e a regra nova põe no Açaí, conforme a validação do responsável. Não houve nenhum caso de Subway↔Açaí trocado.

Com parâmetros mais rígidos (mínimo 3 ocorrências / 3 dias), a cobertura cai cerca de 1 ponto percentual, sem ganho de segurança mensurável. Ficou o padrão 2/2.

**Comparação sobre os 385 pedidos reais saneados**, modo compartilhado contra o da 144:
- nenhum pedido perdido ou duplicado;
- 0 divergências de operação;
- `Subway compartilhado = Subway 144 − Subway que foi para a triagem`;
- soma das taxas brutas idêntica (R$ 1.587 e R$ 1.230 nos dois dias);
- nenhum Açaí na titular e nenhum Subway no destino.

## 4. Aprovação dupla e triagem (`foody.compartilhamento.service.js`)

1. **Propor:** feito pelo organization_admin da organização **titular**. A proposta já leva a aprovação da titular, e o destino nasce `PENDENTE`.
2. **Aprovar:** feito pelo organization_admin da organização de **destino**, com a conexão `ATIVA`. O destino passa a `ATIVO`.
3. **Revogar:** pode ser feito pelo admin de qualquer uma das duas organizações, com motivo. É definitivo e funciona com a flag em qualquer valor.
4. **Triagem:** o admin de qualquer organização do vínculo decide a operação de um pedido em triagem. A decisão é somente inclusão, vale a última e é aplicada na próxima sync. Um pedido **já atribuído** só pode ser reclassificado pelo admin da organização que o detém: ninguém puxa para si um pedido da outra empresa.

Superadmin em **impersonação não conta** para nenhuma dessas ações. O banco confere tudo de novo, lendo `usuarios_organizacoes` no momento da escrita. Toda mudança do vínculo gera um evento imutável em `foody_destinos_eventos`.

**Mesma pessoa pelas duas organizações.** É permitido, mas só quando ela é organization_admin **legítima** das duas no momento de cada ato. Mesmo assim:
- são **dois atos** separados, cada um no contexto da sua organização. O serviço exige o contexto da organização certa em cada passo. O banco recusa a aprovação do destino na mesma transação da proposta ("ato separado");
- o banco grava os carimbos `aprovado_*_em` com a própria hora, e o carimbo enviado pelo cliente é ignorado;
- a auditoria é **por tenant**:
  - `PROPOSTO` e `APROVADO_TITULAR` ficam na titular;
  - `APROVADO_DESTINO` fica no destino;
  - `ATIVADO` e `REVOGADO` ficam nos dois.

  Cada evento traz `ator_organizacao_id`, a organização em nome da qual a pessoa agiu. Quando é a mesma pessoa, o `ATIVADO` registra isso no motivo;
- se a pessoa perde o papel numa das organizações, perde também o poder de agir por ela.

## 4.1 Privacidade da triagem e do fechamento do destino

- **Linha de triagem.** Fica na titular e não traz nenhum dado comercial: valor, taxa, pagamento e cancelamento ficam vazios. Dos itens, guarda **só as linhas sem atribuição segura**, que são as desconhecidas ou as que têm evidência das duas empresas na mesma linha. Os itens já reconhecidos de qualquer empresa nunca ficam na triagem: aparecem só como contagem no resumo (`operacao_motivo`). No pedido misto (`CONFLITO`), os itens ficam vazios.
- **Listagem.** `listarTriagem` devolve `foodyUid`, número, data, situação, motivo, resumo, versão do catálogo e `linhasSemEvidencia`. Nada além disso.
- **Fechamento do destino.** A cobertura vem saneada (`coberturaParaDestino`):
  - sem o volume total da conta (`pedidosUnicos` e `paginas` vazios);
  - sem nomes de ponto de coleta;
  - sem o detalhe dos erros;
  - as pendências da conexão aparecem só como `{codigo, origem: "conexao"}`.

  O status de cobertura incompleta continua valendo. A titular, dona da conta, mantém a cobertura completa.

## 4.2 Integridade do ciclo compartilhado

- `sincronizarEFechar` tenta **todos** os fechamentos, da titular e de cada destino, mesmo que um deles falhe. O resultado por unidade (`REGISTRADO`, `SEM_MUDANCA` ou `ERRO:<código>`) e o número de pendentes ficam gravados na execução (`foody_sync_execucoes.fechamentos` e `fechamentos_pendentes`).
- Destino que falha → `concluido: false` e `pendentes`. No agendador, a entrada sai com `erro: "FECHAMENTO_PENDENTE"`: o ciclo **não** conta como sucesso.
- Titular que falha → os destinos são tentados mesmo assim, e o erro sobe com `fechamentosPendentes`.
- **Reconciliação.** Só roda com a flag de compartilhamento ligada. O agendador também reprocessa os dias **congelados** dos últimos 35 dias em dois casos:
  - a última execução do dia deixou fechamento pendente;
  - existe decisão de triagem para pedido ainda em triagem.

  Esse reprocessamento usa `origem = reprocessamento` e motivo. Os dias D-1..D-3 não se repetem. A pendência some quando a última execução do dia fecha sem erro.

## 4.3 Evolução do catálogo

1. **Produto novo.** Uma linha que não está no catálogo nem traz um termo validado leva o pedido à triagem (`ITEM_DESCONHECIDO`). Só essa linha fica visível na triagem.
2. **Resolução.** Há dois caminhos:
   - **decisão de triagem**, que vale para aquele pedido;
   - **nova versão do catálogo**, gerada pelo `scripts/foody-gerar-catalogo.mjs`, revisada no diff e com o novo hash fixado no teste. Ela vale para os pedidos sincronizados dali em diante.
3. **Atualização dos fechamentos.**
   - A sync seguinte grava a linha de novo:
     - no mesmo tenant, ela é atualizada;
     - em outro tenant, a antiga é desativada (`RECLASSIFICADO`, mínima) e há uma única linha ativa, garantida pelo índice global.
   - Os fechamentos ganham **nova versão** `CORRIGIDO`, com o motivo de reclassificação. As versões anteriores nunca mudam.
   - Cada pedido e cada execução registram a `catalogo_versao`.
4. **Histórico.** Uma versão nova de catálogo **não** reabre dia congelado. Só a decisão de triagem, ou um reprocessamento manual com motivo, aplica uma mudança a dia congelado.

**Rotas e tela:** não fazem parte deste PR. O teste de arquitetura proíbe consumidores do módulo nesta fase. Expor o serviço em rota autenticada é a próxima etapa, com GO próprio.

## 5. Migration 145 (aditiva sobre a 144)

Tabelas novas:
- `foody_conexao_destinos`: o vínculo, com o estado e as duas aprovações;
- `foody_destinos_eventos`: a auditoria, somente inclusão;
- `foody_triagem_decisoes`: as decisões de triagem, somente inclusão.

Colunas novas:
- em `foody_pedidos`: `conexao_id`, `destino_id`, `roteamento_ativo`, `roteamento_motivo`, `triagem_motivo` e `catalogo_versao`;
- em `foody_sync_execucoes`: contagem de triagem, distribuição (só contagens), versão do catálogo, `fechamentos` (resultado por unidade) e `fechamentos_pendentes`;
- em `foody_destinos_eventos`: `ator_organizacao_id`.

O RLS está ligado, sem policy, e não há grant a anon nem a authenticated. O service_role não tem DELETE.

O rollback (`145_rollback.sql`) é **fail-closed**: recusa se já houver vínculo, decisão ou pedido distribuído, e nesse caso aponta para o rollback da 144. Limpo, ele restaura as regras exatas da 144 e é idempotente. O `144_rollback.sql` remove também os objetos da 145.

## 6. Testes

```bash
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=stub SUPABASE_ANON_KEY=stub \
  node --test test/foody-compartilhada.test.js test/foody-compartilhada-catalogo.test.js test/foody-central-*.test.js
# Postgres LOCAL descartável (pula sem a variável):
CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:<porta>/postgres \
  node --test test/foody-compartilhada-migration-pg.test.js test/foody-compartilhada-e2e-pg.test.js test/foody-central-migration-pg.test.js
```

- `foody-compartilhada.test.js`: distribuição, o ajuste obrigatório de segurança, um uid ativo, revogação, isolamento, fechamentos independentes e o serviço de aprovação/triagem. Usa banco falso com a unicidade global simulada.
- `foody-compartilhada-revisao.test.js`: regressões da revisão final, nos quatro pontos:
  - privacidade da triagem e do fechamento do destino;
  - fechamento pendente e reconciliação;
  - mesma pessoa pelas duas organizações;
  - evolução do catálogo, com versões de fechamento e sem duplicidade.
- `foody-compartilhada-catalogo.test.js`: regressão do catálogo (versão e hash fixados, congelado, uma operação por linha, sem texto livre), casos de borda e o gerador.
- `foody-compartilhada-migration-pg.test.js`: regras da 145 no Postgres real. Cobre:
  - aprovação;
  - auditoria por tenant;
  - mesma pessoa em transações separadas;
  - unicidade;
  - triagem;
  - fechamento do destino;
  - revogação;
  - transferência;
  - rollback.
- `foody-compartilhada-e2e-pg.test.js`: o repositório, a sync, o fechamento e o serviço **reais** rodando contra o Postgres real, por um cliente mínimo compatível com o supabase-js (`helpers/pg-supabase-mini.js`).

## 7. Para ligar (cada passo com GO próprio)

1. Aplicar 144 + 145 (backup antes).
2. Cadastrar a conexão da titular, que nasce PAUSADA. Ativar.
3. Expor o serviço de vínculo/triagem em rota autenticada, com tela.
4. O admin da titular propõe e o admin do Açaí aprova.
5. Ligar `FOODY_CENTRAL_ENABLED`, a allowlist (só a titular) e `FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED` em sombra. Conferir com o Gestor.

**Para desligar:** revogue o destino com a flag ligada e reprocesse D-1..D-3; só depois desligue a flag. Desligar a flag com destino ativo e linhas no destino faz a sync daqueles dias falhar de propósito (fail-closed: índice global e trava de linha desativada da 145), em vez de duplicar ou sumir com pedido.
